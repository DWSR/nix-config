# Home Manager module for `home.deskflow`: the consumer-facing options schema
# for declarative Deskflow (the Synergy 1.x / Barrier successor) configuration.
#
# This module declares the `options.home.deskflow` schema and, under
# `config = mkIf cfg.enable`, delivers the rendered files read-only. The
# resolved snapshot is consumed by `render.nix` (`import ./render.nix
# { inherit lib; }` applied to the snapshot), which maps it to the rendered
# QSettings INI settings, the external server layout, and the trusted-peer
# file. The config block computes the external-config path once (kept
# lock-step with the layout file's `home.file` delivery path), injects it into
# the render snapshot as `server.externalConfigFile`, and links each rendered
# leaf under `~/Library/Deskflow/` as a read-only store symlink -- so the
# parent directory stays writable for Deskflow's runtime files.
#
# Structural validation (enabled-without-role, empty server screens, dangling
# screen references, malformed fingerprints) lives in `render.nix` and fires
# when the delivered file text is forced. The schema only constrains values
# structurally: the `role` and `tls.keySize` enums reject invalid values at
# option-evaluation time.
{ config, lib, ... }:
let
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    optionalAttrs
    types
    ;

  cfg = config.home.deskflow;

  # One server screen: a name plus its optional per-screen Deskflow options
  # (half-duplex lock toggles and modifier remaps). `name` is required (no
  # default); the renderer reads `name`, `halfDuplex.*`, and `modifierRemap`.
  screenType = types.submodule {
    options = {
      name = mkOption {
        type = types.str;
        description = "Screen name; referenced by links and aliases and matched against the host's Deskflow screen name.";
      };

      halfDuplex = {
        CapsLock = mkOption {
          type = types.bool;
          default = false;
          description = "Treat Caps Lock as a half-duplex key on this screen.";
        };

        NumLock = mkOption {
          type = types.bool;
          default = false;
          description = "Treat Num Lock as a half-duplex key on this screen.";
        };

        ScrollLock = mkOption {
          type = types.bool;
          default = false;
          description = "Treat Scroll Lock as a half-duplex key on this screen.";
        };
      };

      modifierRemap = mkOption {
        type = types.attrsOf (
          types.enum [
            "shift"
            "ctrl"
            "alt"
            "meta"
            "super"
            "none"
          ]
        );
        default = { };
        description = "Per-screen modifier remaps as `from = to`; each target is one of `shift`, `ctrl`, `alt`, `meta`, `super`, `none`.";
      };
    };
  };

  # One server adjacency edge: an outbound `direction` from screen `from` to
  # screen `to`, with optional `(start,end)` portion ranges. Endpoint screens
  # must be defined in `server.screens` (validated by the renderer).
  linkType = types.submodule {
    options = {
      from = mkOption {
        type = types.str;
        description = "Source screen name; must be defined in `server.screens`.";
      };

      direction = mkOption {
        type = types.enum [
          "left"
          "right"
          "up"
          "down"
        ];
        description = "Edge of the source screen this link leaves from.";
      };

      to = mkOption {
        type = types.str;
        description = "Destination screen name; must be defined in `server.screens`.";
      };

      fromRange = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Optional `start,end` portion range on the source edge; null spans the whole edge.";
      };

      toRange = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Optional `start,end` portion range on the destination edge; null spans the whole edge.";
      };
    };
  };

  # The external server-layout file is delivered to one fixed location under
  # ~/Library/Deskflow AND named in the rendered `server/externalConfigFile`
  # setting. Both come from this single source so the setting and the delivered
  # file can never drift (Req 4.2). `serverConfRelPath` is the $HOME-relative
  # key home.file delivers at; `externalConfigFile` is the absolute path
  # Deskflow reads from the settings.
  serverConfRelPath = "Library/Deskflow/deskflow-server.conf";
  externalConfigFile = "${config.home.homeDirectory}/${serverConfRelPath}";

  # Inject the computed external-config path into the snapshot render consumes.
  # It is not an operator-settable option (avoids drift); render reads it only
  # for the server role.
  renderCfg = cfg // {
    server = cfg.server // {
      inherit externalConfigFile;
    };
  };

  rendered = import ./render.nix { inherit lib; } renderCfg;

  # A host writes the trust file for the peers IT trusts, picked by role: a
  # client verifies servers against `trusted-servers`, a server verifies
  # clients against `trusted-clients` (Req 8.3).
  trustFile = if cfg.role == "client" then "trusted-servers" else "trusted-clients";
in
{
  options.home.deskflow = {
    enable = mkEnableOption "declarative Deskflow configuration for this host";

    role = mkOption {
      type = types.nullOr (
        types.enum [
          "client"
          "server"
        ]
      );
      default = null;
      description = "Deskflow role for this host: `client` (connects to a server) or `server` (shares its input). Must be set when the module is enabled (enforced by the renderer).";
    };

    computerName = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Deskflow screen name for this host (`core/computerName`). When null the key is omitted so Deskflow falls back to the machine hostname.";
    };

    port = mkOption {
      type = types.port;
      default = 24800;
      description = "TCP port Deskflow listens on or connects to (`core/port`).";
    };

    tls = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = "Enable TLS for Deskflow connections (`security/tlsEnabled`).";
      };

      checkFingerprints = mkOption {
        type = types.bool;
        default = true;
        description = "Require peer certificate fingerprints to be trusted before connecting (`security/checkPeerFingerprints`).";
      };

      certificateFile = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Absolute path to the TLS identity certificate (`security/certificate`), e.g. an `osConfig.sops` secret path. Referenced by path only and never copied into the Nix store. When null the key is omitted so Deskflow self-generates a certificate.";
      };

      keySize = mkOption {
        type = types.enum [
          2048
          4096
        ];
        default = 2048;
        description = "RSA key size Deskflow uses when self-generating its certificate (`security/keySize`). Only 2048 or 4096 are accepted.";
      };

      trustedFingerprints = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = "Trusted peer certificate fingerprints (SHA-256 64-hex or SHA-1 40-hex; colons tolerated). Rendered read-only to the role-appropriate trust file. An empty list leaves Deskflow's interactive trust behavior intact.";
      };
    };

    log = {
      level = mkOption {
        type = types.enum [
          "FATAL"
          "ERROR"
          "WARNING"
          "NOTE"
          "INFO"
          "DEBUG"
          "DEBUG1"
          "DEBUG2"
        ];
        default = "INFO";
        description = "Deskflow log verbosity (`log/level`), rendered as the integer index into this severity order.";
      };

      toFile = mkOption {
        type = types.bool;
        default = false;
        description = "Whether Deskflow writes its log to a file (`log/toFile`).";
      };

      file = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Absolute path of the Deskflow log file (`log/file`). Omitted when null.";
      };
    };

    gui = {
      startCoreWithGui = mkOption {
        type = types.bool;
        default = true;
        description = "Start the Deskflow core process when the GUI launches (`gui/startCoreWithGui`).";
      };

      closeToTray = mkOption {
        type = types.bool;
        default = true;
        description = "Minimize the Deskflow GUI to the system tray instead of quitting (`gui/closeToTray`).";
      };

      autoHide = mkOption {
        type = types.bool;
        default = false;
        description = "Automatically hide the Deskflow GUI window on start (`gui/autoHide`).";
      };

      enableUpdateCheck = mkOption {
        type = types.bool;
        default = false;
        description = "Check for Deskflow updates on startup (`gui/enableUpdateCheck`). Setting this explicitly avoids the first-run update-check prompt.";
      };

      closeReminder = mkOption {
        type = types.bool;
        default = false;
        description = "Show the reminder that Deskflow continues running after its window closes (`gui/closeReminder`).";
      };

      showGenericClientFailureDialog = mkOption {
        type = types.bool;
        default = false;
        description = "Show modal client connection warnings, including the generic TLS/firewall warning (`gui/showGenericClientFailureDialog`).";
      };

      shownFirstConnectedMessage = mkOption {
        type = types.bool;
        default = true;
        description = "Record that Deskflow's first-connected modal has already been shown (`gui/shownFirstConnectedMessage`).";
      };

      shownServerFirstStartMessage = mkOption {
        type = types.bool;
        default = true;
        description = "Record that Deskflow's first server-start modal has already been shown (`gui/shownServerFirstStartMessage`).";
      };
    };

    client = {
      remoteHost = mkOption {
        type = types.str;
        default = "";
        description = "Address of the Deskflow server this client connects to (`client/remoteHost`). When empty the key is omitted and a TODO placeholder is rendered.";
      };

      invertScroll = {
        x = mkOption {
          type = types.bool;
          default = false;
          description = "Invert horizontal scroll direction (`client/invertXScroll`).";
        };

        y = mkOption {
          type = types.bool;
          default = false;
          description = "Invert vertical scroll direction (`client/invertYScroll`).";
        };
      };

      scrollScale = {
        x = mkOption {
          type = types.float;
          default = 1.0;
          description = "Horizontal scroll scale factor (`client/xScrollScale`); 1.0 is Deskflow's default.";
        };

        y = mkOption {
          type = types.float;
          default = 1.0;
          description = "Vertical scroll scale factor (`client/yScrollScale`); 1.0 is Deskflow's default.";
        };
      };

      languageSync = mkOption {
        type = types.bool;
        default = true;
        description = "Synchronize the keyboard language and layout with the server (`client/languageSync`).";
      };
    };

    server = {
      screens = mkOption {
        type = types.listOf screenType;
        default = [ ];
        description = "Screens in the server layout. A server role requires at least one screen (enforced by the renderer).";
      };

      aliases = mkOption {
        type = types.attrsOf (types.listOf types.str);
        default = { };
        description = "Alternate names for screens as `{ screen = [ altNames ]; }`. Each key must name a screen defined in `screens`.";
      };

      links = mkOption {
        type = types.listOf linkType;
        default = [ ];
        description = "Directional adjacency edges between screens. Every endpoint must name a screen defined in `screens`.";
      };

      options = mkOption {
        type = types.attrsOf types.str;
        default = { };
        description = "Global server options rendered as `name = value` lines in the layout's options section.";
      };
    };
  };

  config = mkIf cfg.enable {
    # Deliver each rendered leaf under ~/Library/Deskflow as a read-only Nix
    # store symlink. home.file links the LEAF only, so the parent
    # ~/Library/Deskflow/ stays a real, writable directory for Deskflow's
    # runtime files -- logs, the .state file, and an unmanaged trust store
    # (Req 5.1, 5.3). A read-only symlink makes QSettings::isWritable() false,
    # so GUI/runtime writes no-op and the declared settings stay the source of
    # truth (Req 5.2) -- the same mechanism as tec.nix's pin file. No
    # certificate or key material is ever delivered: security/certificate is
    # referenced by path only inside render.nix (Req 5.4, 8.1), so no home.file
    # entry below carries it and the module never reads the cert.
    home.file = {
      # The curated QSettings file at the macOS user settings location;
      # always delivered while enabled (Req 1.4, 5.1, 5.2).
      "Library/Deskflow/Deskflow.conf".text = rendered.settings;
    }
    # Server role: the external screen layout, delivered at the SAME path the
    # rendered server/externalConfigFile setting names -- both derive from
    # serverConfRelPath, so they stay lock-step (Req 4.2). rendered.serverConfig
    # is null for a client, so this entry exists only for the server role.
    // optionalAttrs (cfg.role == "server") {
      "${serverConfRelPath}".text = rendered.serverConfig;
    }
    # Trusted peers: the role-appropriate trust file (trusted-servers for a
    # client, trusted-clients for a server), delivered read-only only when
    # fingerprints are provided. rendered.trustText is null otherwise, leaving
    # the trust file unmanaged and writable so Deskflow's interactive trust
    # stays intact (Req 8.3, 8.5).
    // optionalAttrs (rendered.trustText != null) {
      "Library/Deskflow/tls/${trustFile}".text = rendered.trustText;
    };
  };
}
