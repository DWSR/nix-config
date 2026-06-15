# Fixture keybinding/config sets for the hammerspoon-keybindings renderer +
# syntax-gate tests (Task 8.2) and the semantic check (Task 8.3),
# _Boundary: Verification_.
#
# Plain data (takes no `lib`), so `import ./fixtures.nix` yields the attrset
# directly. Each value is a `cfg = { keybindings, extraConfig,
# reloadOnConfigChange }` accepted by the pure renderer
# (`home-manager/common/hammerspoon-keybindings/render.nix`).
#
# - `validMulti` / `empty` drive the render-content asserts (Req 4.2) and the
#   valid-Lua syntax gate (Req 5.1).
# - `duplicate` / `zeroAction` / `twoAction` / `emptyKey` / `badMod` / `badKey`
#   each trip exactly one of the renderer's eval-time `throw`s (Req 4.3).
# - `syntaxError` renders without throwing but carries a Lua syntax error in
#   `extraConfig`, so `luac -p` on the rendered output must fail (Req 5.3).
# - `bogus` renders to valid Lua but references a nonexistent `hs` API module in
#   `extraConfig`, so the semantic check's lua-language-server member-existence
#   gate must reject it with an `undefined-field` diagnostic (Req 5.4).
let
  commandAction = c: {
    command = c;
    applescript = null;
    lua = null;
  };
  applescriptAction = a: {
    command = null;
    applescript = a;
    lua = null;
  };
  luaAction = l: {
    command = null;
    applescript = null;
    lua = l;
  };
in
{
  # Representative set: one binding per action type, a description comment, a
  # free-form extraConfig line, and the reload watcher enabled.
  validMulti = {
    keybindings = [
      {
        mods = [
          "ctrl"
          "cmd"
          "shift"
        ];
        key = "F12";
        description = "Toggle microphone mute";
        action = commandAction "/run/current-system/sw/bin/true";
      }
      {
        mods = [
          "cmd"
          "alt"
        ];
        key = "A";
        description = "Notify via AppleScript";
        action = applescriptAction ''display notification "hi"'';
      }
      {
        mods = [ "cmd" ];
        key = "space";
        description = "";
        action = luaAction "hs.reload()";
      }
    ];
    extraConfig = "-- operator supplied extra config";
    reloadOnConfigChange = true;
  };

  # Empty set: header-only config, no binds, reload disabled so no watcher.
  empty = {
    keybindings = [ ];
    extraConfig = "";
    reloadOnConfigChange = false;
  };

  # Two bindings resolve to the same hotkey identity (cmd+ctrl+a) despite
  # differing modifier order and key case.
  duplicate = {
    keybindings = [
      {
        mods = [
          "ctrl"
          "cmd"
        ];
        key = "a";
        description = "first";
        action = luaAction "hs.alert.show('1')";
      }
      {
        mods = [
          "cmd"
          "ctrl"
        ];
        key = "A";
        description = "second";
        action = luaAction "hs.alert.show('2')";
      }
    ];
    extraConfig = "";
    reloadOnConfigChange = true;
  };

  # Binding declares no action (all three variants null).
  zeroAction = {
    keybindings = [
      {
        mods = [ "cmd" ];
        key = "j";
        description = "no action";
        action = {
          command = null;
          applescript = null;
          lua = null;
        };
      }
    ];
    extraConfig = "";
    reloadOnConfigChange = true;
  };

  # Binding declares two actions (command + lua).
  twoAction = {
    keybindings = [
      {
        mods = [ "cmd" ];
        key = "k";
        description = "two actions";
        action = {
          command = "/run/current-system/sw/bin/true";
          applescript = null;
          lua = "hs.reload()";
        };
      }
    ];
    extraConfig = "";
    reloadOnConfigChange = true;
  };

  # Binding with an empty key (incomplete binding).
  emptyKey = {
    keybindings = [
      {
        mods = [ "cmd" ];
        key = "";
        description = "missing key";
        action = luaAction "hs.reload()";
      }
    ];
    extraConfig = "";
    reloadOnConfigChange = true;
  };

  # Binding with an unsupported modifier ("hyper").
  badMod = {
    keybindings = [
      {
        mods = [ "hyper" ];
        key = "a";
        description = "bad modifier";
        action = luaAction "hs.reload()";
      }
    ];
    extraConfig = "";
    reloadOnConfigChange = true;
  };

  # Binding with an unsupported key ("F21", just past the F1-F20 allowlist).
  badKey = {
    keybindings = [
      {
        mods = [ "cmd" ];
        key = "F21";
        description = "bad key";
        action = luaAction "hs.reload()";
      }
    ];
    extraConfig = "";
    reloadOnConfigChange = true;
  };

  # Renders cleanly (no eval-time throw) but the extraConfig is broken Lua, so
  # the rendered output must fail `luac -p`.
  syntaxError = {
    keybindings = [
      {
        mods = [
          "cmd"
          "shift"
        ];
        key = "r";
        description = "valid binding alongside broken extraConfig";
        action = luaAction "hs.reload()";
      }
    ];
    extraConfig = "this is ))) not valid lua";
    reloadOnConfigChange = true;
  };

  # Renders to valid Lua (no eval-time throw; parses under luac) but references
  # a nonexistent `hs` API module, so the semantic check's member-existence gate
  # (lua-language-server) must reject it with `undefined-field` naming
  # `bogusModule` (Req 5.4).
  bogus = {
    keybindings = [ ];
    extraConfig = "hs.bogusModule.foo()";
    reloadOnConfigChange = false;
  };
}
