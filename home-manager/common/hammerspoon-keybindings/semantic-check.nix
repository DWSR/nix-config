# Hermetic, CI-only semantic validation check for the rendered Hammerspoon config.
#
# Signature: `{ pkgs, lib, ... }: cfg: derivation` whose `$out` is a success
# marker. The annotation LIBRARY is the Task 3.2 overlay output
# `pkgs.hammerspoonHsAnnotations` (a directory of `hs.*` LuaCATS files generated
# from the pinned bundle's docs.json) -- NOT the `hammerspoon` app bundle. The
# design's nominal `hammerspoon` formal is tolerated via `...` (callers may pass
# it) but is unused here, because the annotations are a standalone overlay attr,
# not derived from the bundle in this check. Imported as:
#   mkSemanticCheck = import ./semantic-check.nix;
#   mkSemanticCheck { inherit pkgs lib; } cfg
#
# Renders `cfg` with ./render.nix, writes a `.luarc.json` that points
# lua-language-server at the `hs` annotations (Lua 5.4 runtime, third-party
# addon fetching disabled, undefined field/global forced to Error), and runs
# `lua-language-server --check` fully OFFLINE with HOME/cache/log/meta redirected
# to build-temp (the store install dir is read-only, so meta/log MUST be
# redirected). A non-zero LuaLS exit -- its behavior on diagnostics at/above the
# check level -- fails the build (the load-bearing gate, Requirement 5.4); a
# non-empty `check.json` is a belt-and-braces guard for older LuaLS that exits 0
# while recording diagnostics. Surfaced only as a flake check (Task 8.3), never
# wired into the delivered config, so an annotation-coverage gap fails
# `nix flake check`, never `darwin-rebuild switch`. Runs with no network and no
# running Hammerspoon / Accessibility grant (Requirements 5.2, 5.4, 5.5).
{ pkgs, lib, ... }:
cfg:
let
  initLua = import ./render.nix { inherit lib; } cfg;
  initFile = pkgs.writeText "hammerspoon-init-rendered.lua" initLua;

  # LuaLS config: point workspace.library at the generated `hs` annotations and
  # force undefined-field/undefined-global to Error so member existence gates
  # (with `--checklevel=Error`). `hs` is deliberately NOT in diagnostics.globals
  # -- listing it there would make `hs` opaque and disable member checking.
  # checkThirdParty=false keeps the run offline (no addon fetch/prompt).
  luarc = pkgs.writeText "hammerspoon-luarc.json" (
    builtins.toJSON {
      runtime.version = "Lua 5.4";
      workspace = {
        library = [ "${pkgs.hammerspoonHsAnnotations}" ];
        checkThirdParty = false;
      };
      diagnostics.severity = {
        "undefined-field" = "Error";
        "undefined-global" = "Error";
      };
    }
  );
in
pkgs.runCommand "hammerspoon-config-semantic"
  {
    nativeBuildInputs = [ pkgs.lua-language-server ];
  }
  ''
    set -eu

    # Redirect every writable path LuaLS touches into build-temp ($TMPDIR): the
    # store install dir is read-only, so HOME/cache/meta/log must not default
    # there. mktemp honours $TMPDIR, so no /tmp literal is used.
    export HOME="$(mktemp -d)"
    export XDG_CACHE_HOME="$(mktemp -d)"

    work="$(mktemp -d)"
    mkdir -p "$work/ws" "$work/log" "$work/meta"
    cp ${initFile} "$work/ws/init.lua"
    cp ${luarc} "$work/ws/.luarc.json"

    # Primary gate: LuaLS exits non-zero on a diagnostic at/above --checklevel.
    status=0
    lua-language-server --check "$work/ws" \
      --configpath "$work/ws/.luarc.json" \
      --logpath "$work/log" \
      --metapath "$work/meta" \
      --checklevel=Error || status=$?

    if [ "$status" -ne 0 ]; then
      echo "hammerspoon semantic check FAILED: lua-language-server reported diagnostics (exit $status); see the undefined-field/undefined-global diagnostics above." >&2
      exit 1
    fi

    # Belt-and-braces: older LuaLS exits 0 but records diagnostics in check.json
    # (current 3.18.1 writes none and relies solely on the exit code above).
    if [ -f "$work/log/check.json" ]; then
      compact="$(tr -d '[:space:]' < "$work/log/check.json")"
      if [ -n "$compact" ] && [ "$compact" != "{}" ]; then
        echo "hammerspoon semantic check FAILED: lua-language-server check.json reported diagnostics:" >&2
        cat "$work/log/check.json" >&2
        exit 1
      fi
    fi

    touch "$out"
  ''
