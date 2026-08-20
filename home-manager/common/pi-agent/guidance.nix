{ pkgs }:
let
  package = pkgs.runCommand "pi-agent-guidance-1.0.0" { } ''
    mkdir -p "$out/share/pi-agent"
    cp ${./instructions.md} "$out/share/pi-agent/instructions.md"
    cp ${./guide.md} "$out/share/pi-agent/guide.md"
    chmod 0444 \
      "$out/share/pi-agent/instructions.md" \
      "$out/share/pi-agent/guide.md"
  '';
in
{
  inherit package;
  instructionResource = {
    inherit package;
    relativePath = "share/pi-agent/instructions.md";
  };
  guideResource = {
    inherit package;
    relativePath = "share/pi-agent/guide.md";
  };
}
