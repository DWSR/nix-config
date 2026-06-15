# Derivation-time syntax gate for the rendered Hammerspoon config (delivery path).
#
# Signature: `{ pkgs, lib }: cfg: derivation` whose `$out` is the
# syntax-validated `init.lua` FILE delivered via `xdg.configFile.source`
# (the HM module wires it in a later task). Imported as:
#   mkCheckedConfig = import ./checked-config.nix;
#   mkCheckedConfig { inherit pkgs lib; } cfg
#
# Renders `cfg` to Lua with ./render.nix, parse-checks it with Lua 5.4's
# `luac -p` (a NON-ZERO exit on a parse error fails the build, aborting both
# `darwin-rebuild switch` and `nix flake check`; Requirements 5.1, 5.3), then
# installs the validated text read-only as `$out` (Requirements 3.4, 5.5).
# The Lua 5.4 parser binary shipped by `pkgs.lua5_4` is `luac` (there is no
# `luac5.4`). Deterministic and fully offline: derives only from `cfg`.
{ pkgs, lib }:
cfg:
let
  initLua = import ./render.nix { inherit lib; } cfg;
  initFile = pkgs.writeText "hammerspoon-init-rendered.lua" initLua;
in
pkgs.runCommand "hammerspoon-init.lua" { nativeBuildInputs = [ pkgs.lua5_4 ]; } ''
  luac -p ${initFile}
  install -m 444 ${initFile} "$out"
''
