# Home Manager module for `home.deskflow`: the consumer-facing options schema
# for declarative Deskflow (the Synergy 1.x / Barrier successor) configuration.
#
# This module declares ONLY the `options.home.deskflow` schema. The resolved
# snapshot is consumed by `render.nix` (`import ./render.nix { inherit lib; }`
# applied to `cfg`), which maps it to the rendered QSettings INI settings, the
# external server layout, and the trusted-peer file. The read-only `home.file`
# delivery, the computed `server.externalConfigFile` path, and the `render`
# call are added by the module's config block (a later task); they are
# intentionally absent here.
#
# Structural validation (enabled-without-role, empty server screens, dangling
# screen references, malformed fingerprints) lives in `render.nix` and fires
# when the delivered file text is forced. The schema only constrains values
# structurally: the `role` and `tls.keySize` enums reject invalid values at
# option-evaluation time.
{ lib, ... }:
let
  inherit (lib)
    mkEnableOption
    mkOption
    types
    ;

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
}
