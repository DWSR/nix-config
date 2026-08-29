{ pkgs }:
let
  render = import ../../home-manager/common/hammerspoon-timezone-menubar/render.nix;
  rendered = render [
    {
      label = "Toronto";
      timeZone = "America/Toronto";
    }
    {
      label = "UTC";
      timeZone = "Etc/UTC";
    }
    {
      label = "Vancouver";
      timeZone = "America/Vancouver";
    }
  ];
  escaped = render [
    {
      label = ''Quote " and slash \\'';
      timeZone = "Etc/UTC";
    }
  ];
  renderedFile = pkgs.writeText "hammerspoon-timezone-menubar.lua" rendered;
in
assert pkgs.lib.hasPrefix "-- hammerspoon-timezone-menubar: compact world clocks\n" rendered;
assert pkgs.lib.hasInfix ''{ label = "Toronto", timeZone = "America/Toronto" },'' rendered;
assert pkgs.lib.hasInfix ''label = "Quote \" and slash \\\\"'' escaped;
pkgs.runCommand "hammerspoon-timezone-menubar-render-test"
  {
    nativeBuildInputs = [ pkgs.lua5_4 ];
  }
  ''
    luac -p ${renderedFile}
    lua ${./runtime.test.lua} ${./fake-hs.lua} ${renderedFile}
    touch "$out"
  ''
