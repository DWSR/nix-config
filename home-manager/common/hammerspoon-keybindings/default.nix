# Home Manager module for `home.hammerspoon`: the consumer-facing options
# schema plus the enabled-config delivery.
#
# `render.nix` consumes the schema as `cfg = { keybindings, extraConfig,
# reloadOnConfigChange }`. When enabled, this module delivers the syntax-gated
# `xdg.configFile."hammerspoon/init.lua"` under XDG, sets the `MJConfigFile`
# user default to that path, and installs a login `launchd.agents` agent that
# starts Hammerspoon (Req 1.7). The one-time manual Accessibility grant is
# documented on the `enable` option.
#
# Binding allowlist/arity validation (duplicate hotkeys, exactly-one action,
# key allowlist) lives in `render.nix`, not here. The schema only rejects
# unknown modifiers structurally, via the `mods` enum (Requirement 3.9).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib)
    mkEnableOption
    mkOption
    types
    ;

  cfg = config.home.hammerspoon;

  # A binding's single action: exactly one of the three fields is non-null
  # for valid input. The one-of arity (Requirement 3.8 / 2.2) is enforced by
  # the renderer, not the type, so each field is independently nullable.
  actionType = types.submodule {
    options = {
      applescript = mkOption {
        type = types.nullOr types.lines;
        default = null;
        description = "AppleScript source to run via `hs.osascript.applescript` when the hotkey fires.";
      };

      command = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Command-line invocation to run via `hs.execute` (login shell) when the hotkey fires.";
      };

      lua = mkOption {
        type = types.nullOr types.lines;
        default = null;
        description = "Inline Lua snippet executed verbatim when the hotkey fires (general escape hatch for `hs` APIs).";
      };
    };
  };

  # One declarative keybinding: a hotkey (modifier set + key) plus one action
  # (Requirement 3.1). Deep `key` allowlist validation stays in the renderer;
  # `mods` is constrained here so an unknown modifier is rejected by the option
  # type at eval time (Requirement 3.9).
  bindingType = types.submodule {
    options = {
      mods = mkOption {
        type = types.listOf (
          types.enum [
            "cmd"
            "ctrl"
            "alt"
            "shift"
          ]
        );
        default = [ ];
        description = "Modifier keys held with `key`. Each entry must be one of `cmd`, `ctrl`, `alt`, `shift`.";
      };

      key = mkOption {
        type = types.str;
        description = "The non-modifier key (e.g. `F12`, a single printable character, or a named key such as `space`). Validated against the renderer's allowlist.";
      };

      description = mkOption {
        type = types.str;
        default = "";
        description = "Human-readable description emitted as a comment above the rendered bind.";
      };

      action = mkOption {
        type = actionType;
        description = "The action to perform when the hotkey fires. Set exactly one of `applescript`, `command`, or `lua`.";
      };
    };
  };
in
{
  options.home.hammerspoon = {
    enable = mkEnableOption ''
      declarative Hammerspoon global keybindings. Each host requires a
      one-time manual macOS Accessibility grant (System Settings > Privacy &
      Security > Accessibility) before any binding fires'';

    keybindings = mkOption {
      type = types.listOf bindingType;
      default = [ ];
      description = "Declarative global keybindings rendered into the Hammerspoon configuration. Each entry maps a hotkey (modifiers + key) to exactly one action.";
    };

    extraConfig = mkOption {
      type = types.lines;
      default = "";
      description = "Free-form Lua appended to the generated configuration, ahead of the bind calls. Escape hatch for watchers, menubar items, helper functions, and other non-hotkey setup.";
    };

    reloadOnConfigChange = mkOption {
      type = types.bool;
      default = true;
      description = "Whether to emit an `hs.pathwatcher` watcher that reloads Hammerspoon when the live configuration changes (auto-reload after a rebuild).";
    };
  };

  # When enabled, deliver the syntax-validated config under XDG, point
  # Hammerspoon at it, and start it at login. The one-time manual Accessibility
  # grant is documented on the `enable` option.
  config = lib.mkIf cfg.enable {
    # Deliver the syntax-gated init.lua under XDG (Req 3.4 readable, 6.1 under
    # XDG). The `source` IS the syntax gate's `$out`, so an invalid render fails
    # the build rather than delivering a broken config.
    xdg.configFile."hammerspoon/init.lua".source = import ./checked-config.nix { inherit pkgs lib; } {
      inherit (cfg) keybindings extraConfig reloadOnConfigChange;
    };

    # Point Hammerspoon at the relocated config (Req 6.2). The value is the
    # absolute XDG path derived from `config.xdg.configHome` (never a hardcoded
    # home path); NSUserDefaults stores it verbatim with no env expansion.
    targets.darwin.defaults."org.hammerspoon.Hammerspoon".MJConfigFile =
      "${config.xdg.configHome}/hammerspoon/init.lua";

    # Req 6.3: nothing is written under ~/.hammerspoon — no `home.file` entry
    # there; the MJConfigFile default also relocates hs.configdir/Spoons.

    # Start Hammerspoon at login so the declared bindings are active without a
    # manual launch (Req 1.7). Target the STABLE nix-darwin Nix Apps copy at
    # `/Applications/Nix Apps/Hammerspoon.app`, not the per-build store path, so
    # the agent survives version bumps and preserves the TCC grant. `KeepAlive
    # = false`: start once at load, do not respawn on quit. Until the one-time
    # Accessibility grant (documented on `enable`), the launched process is
    # inert and `hs.accessibilityState(true)` prompts for it (Req 2.1-2.3).
    launchd.agents.hammerspoon = {
      enable = true;
      config = {
        ProgramArguments = [ "/Applications/Nix Apps/Hammerspoon.app/Contents/MacOS/Hammerspoon" ];
        RunAtLoad = true;
        KeepAlive = false;
      };
    };
  };
}
