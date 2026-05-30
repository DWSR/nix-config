{ config, lib, ... }:
let
  inherit (lib) mkEnableOption mkOption types;

  cfg = config.home.tailscaleServe;

  portPattern = "([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])";
  localProxyUrlPattern = "^(http|https|tcp|https\\+insecure)://(localhost|127\\.0\\.0\\.1)(:(${portPattern}))?(/.*)?$";

  portType = types.addCheck types.int (port: port >= 1 && port <= 65535) // {
    description = "TCP port from 1 through 65535";
  };

  httpPathType = types.addCheck types.str (path: lib.hasPrefix "/" path) // {
    description = "HTTP path beginning with /";
  };

  localProxyUrlType =
    types.addCheck types.str (url: builtins.match localProxyUrlPattern url != null)
    // {
      description = "local loopback proxy URL using http, https, tcp, or https+insecure";
    };

  listenOpts = {
    options = {
      protocol = mkOption {
        type = types.enum [
          "https"
          "http"
          "tcp"
          "tls-terminated-tcp"
        ];
        description = ''
          Tailscale-facing listener protocol. Only tailnet-private Serve
          listener protocols supported by this module are allowed.
        '';
      };

      port = mkOption {
        type = portType;
        description = ''
          Tailscale-facing listener port.
        '';
      };

      path = mkOption {
        type = types.nullOr httpPathType;
        default = null;
        description = ''
          Optional HTTP path. Only HTTP and HTTPS listeners may set a path.
        '';
      };
    };
  };

  listenHasCompatiblePath =
    listen:
    listen.path == null
    || builtins.elem listen.protocol [
      "http"
      "https"
    ];

  listenType = types.addCheck (types.submodule listenOpts) listenHasCompatiblePath // {
    description = "Tailscale Serve listener with path only on http or https";
  };

  targetIsConsistent =
    target:
    if target.kind == "port" then
      target.port != null && target.url == null
    else
      target.kind == "url" && target.url != null && target.port == null;

  targetOpts = {
    options = {
      kind = mkOption {
        type = types.enum [
          "port"
          "url"
        ];
        description = ''
          Local target shape. File, directory, static text, Funnel, and public
          exposure targets are intentionally unsupported.
        '';
      };

      port = mkOption {
        type = types.nullOr portType;
        default = null;
        description = ''
          Local TCP port target. Required when kind is port and forbidden when
          kind is url.
        '';
      };

      url = mkOption {
        type = types.nullOr localProxyUrlType;
        default = null;
        description = ''
          Local loopback or localhost URL target. Required when kind is url and
          forbidden when kind is port.
        '';
      };
    };
  };

  targetType = types.addCheck (types.submodule targetOpts) targetIsConsistent // {
    description = "local target with exactly the fields required by its kind";
  };

  entryOpts = {
    options = {
      listen = mkOption {
        type = listenType;
        description = ''
          Tailnet-private listener exposed by Tailscale Serve.
        '';
      };

      target = mkOption {
        type = targetType;
        description = ''
          Local loopback target proxied by Tailscale Serve.
        '';
      };
    };
  };

  renderedCommandOpts = {
    options = {
      name = mkOption {
        type = types.str;
        description = ''
          Name of the Tailscale Serve entry represented by this rendered
          command intent.
        '';
      };

      argv = mkOption {
        type = types.listOf types.str;
        description = ''
          Argument vector, including the configured Tailscale CLI path, that a
          later activation step can execute.
        '';
      };
    };
  };

  renderTarget =
    entry: if entry.target.kind == "port" then toString entry.target.port else entry.target.url;

  renderCommand = name: entry: {
    inherit name;
    argv = [
      cfg.cliPath
      "serve"
      "--bg"
      "--yes"
      "--${entry.listen.protocol}=${toString entry.listen.port}"
    ]
    ++ lib.optional (entry.listen.path != null) "--set-path=${entry.listen.path}"
    ++ [ (renderTarget entry) ];
  };
in
{
  options.home.tailscaleServe = {
    enable = mkEnableOption "declarative tailnet-private Tailscale Serve entries";

    cliPath = mkOption {
      type = types.str;
      default = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
      description = ''
        Path to the macOS Tailscale app CLI used by activation-time Serve
        convergence.
      '';
    };

    entries = mkOption {
      type = types.attrsOf (types.submodule entryOpts);
      default = { };
      description = ''
        Named Tailscale Serve entry declarations. Supported entries expose one
        tailnet-private listener and proxy to one local loopback target. The
        empty default keeps the module dormant.
      '';
    };

    _renderedCommands = mkOption {
      type = types.listOf (types.submodule renderedCommandOpts);
      internal = true;
      readOnly = true;
      description = ''
        Internal rendered command state consumed by tests and the later
        activation step. Disabled and empty-entry configurations render no
        command intents.
      '';
    };
  };

  config = {
    assertions = lib.mapAttrsToList (name: entry: {
      assertion =
        entry.listen.path == null
        || builtins.elem entry.listen.protocol [
          "http"
          "https"
        ];
      message = "home.tailscaleServe.entries.${name}.listen.path is only supported for http and https listeners";
    }) cfg.entries;

    home.tailscaleServe._renderedCommands =
      if cfg.enable then lib.mapAttrsToList renderCommand cfg.entries else [ ];
  };
}
