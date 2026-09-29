_: final: _prev:
let
  system = final.stdenv.hostPlatform.system;
  supportedSystems = [
    "aarch64-darwin"
    "x86_64-darwin"
  ];
  requireSupported =
    value:
    if builtins.elem system supportedSystems then
      value
    else
      throw "Unsupported iii-engine system: ${system}";

  # AgentMemory main's compatible iii-engine v0.11.5 release.
  iiiVersion = "0.11.5";
  iiiRevision = "iii/v${iiiVersion}";
  iiiSources = {
    "aarch64-darwin" = final.fetchurl {
      url = "https://github.com/iii-hq/iii/releases/download/${iiiRevision}/iii-aarch64-apple-darwin.tar.gz";
      hash = "sha256-RZ9XrYI1xXl/HT3PjkMzvzRrb3gbqF6hga8cA2OkDvg=";
    };
    "x86_64-darwin" = final.fetchurl {
      url = "https://github.com/iii-hq/iii/releases/download/${iiiRevision}/iii-x86_64-apple-darwin.tar.gz";
      hash = "sha256-rIjKhKcM/DfQDGF+rzdDhXQBmHyxCLqlSJshwnavcxA=";
    };
  };

  iiiEngine = requireSupported (
    final.stdenvNoCC.mkDerivation {
      pname = "iii-engine";
      version = iiiVersion;
      src = iiiSources.${system};
      dontUnpack = true;
      dontFixup = true;

      installPhase = ''
        runHook preInstall
        mkdir -p "$out/bin"
        tar -xzf "$src" -C "$out/bin"
        chmod 0555 "$out/bin/iii"
        runHook postInstall
      '';

      passthru = {
        sourceRevision = iiiRevision;
      };

      meta = with final.lib; {
        description = "Pinned iii persistence engine for AgentMemory";
        homepage = "https://github.com/iii-hq/iii";
        license = licenses.elastic20;
        mainProgram = "iii";
        platforms = supportedSystems;
      };
    }
  );
in
{
  iii-engine = iiiEngine;
}
