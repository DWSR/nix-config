# Mic-mute consumer of the `home.hammerspoon` framework: declares the single
# global ⌃⌘⇧F12 binding whose inline-Lua action calls `micMuteToggle()`, and
# delivers the toggle's runtime via the framework's `extraConfig` escape hatch.
#
# The framework renderer emits `extraConfig` ahead of the bind calls, so the
# global `micMuteToggle` defined in ./mic-mute.lua is in scope for the bind's
# `lua` action. `enable` is set once in ../default.nix; module-merge
# concatenates these `keybindings` and `extraConfig` into the framework config.
_: {
  home.hammerspoon = {
    keybindings = [
      {
        mods = [
          "ctrl"
          "cmd"
          "shift"
        ];
        key = "F12";
        description = "Toggle microphone mute on the default input device";
        action = {
          applescript = null;
          command = null;
          lua = "micMuteToggle()";
        };
      }
    ];

    extraConfig = builtins.readFile ./mic-mute.lua;
  };
}
