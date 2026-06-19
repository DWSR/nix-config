# Brightness-on-AC consumer of the `home.hammerspoon` framework: an optional
# `hs.battery.watcher` that maximizes the built-in display brightness when the
# power source switches to AC. Unlike the caffeinate/mic-mute siblings (which
# inject their Lua unconditionally), this consumer is guarded by its own
# `home.hammerspoon.maximizeBrightnessOnAc.enable` option, so the behaviour can
# be toggled per host. When enabled it appends ./brightness-ac.lua to the
# framework's `extraConfig` (module-merged with the other consumers); the chunk
# binds no hotkey and defines no global.
{
  config,
  lib,
  ...
}:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.home.hammerspoon.maximizeBrightnessOnAc;
in
{
  options.home.hammerspoon.maximizeBrightnessOnAc.enable = mkEnableOption ''
    maximising the built-in display brightness (`hs.brightness.set(100)`) when the
    power source switches to AC, via an `hs.battery.watcher`. Has no effect unless
    `home.hammerspoon.enable` is also set'';

  config = mkIf cfg.enable {
    home.hammerspoon.extraConfig = builtins.readFile ./brightness-ac.lua;
  };
}
