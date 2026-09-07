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
      throw "Unsupported agentmemory system: ${system}";

  agentmemoryRev = "e04ba88819c365c9acf9d6661ea802143e728bd6";
  agentmemorySrc = final.fetchFromGitHub {
    owner = "rohitg00";
    repo = "agentmemory";
    rev = agentmemoryRev;
    hash = "sha256-fJ8I8kj7TGvN4T1WPvimSqOrkrC3Ph+QqBE1b8sfs0k=";
  };

  # AgentMemory's compatible iii-engine v0.11.2 release.
  iiiVersion = "0.11.2";
  iiiRevision = "iii/v${iiiVersion}";
  iiiSources = {
    "aarch64-darwin" = final.fetchurl {
      url = "https://github.com/iii-hq/iii/releases/download/${iiiRevision}/iii-aarch64-apple-darwin.tar.gz";
      hash = "sha256-54NMRP77K1ND0ycQKpQUGSRff/9Ef5U3OFegSwM/sb0=";
    };
    "x86_64-darwin" = final.fetchurl {
      url = "https://github.com/iii-hq/iii/releases/download/${iiiRevision}/iii-x86_64-apple-darwin.tar.gz";
      hash = "sha256-K2fl8YgzxBX0yxap4TsOlTVV4MoThoK/JIlKvouAuDY=";
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
  inherit iiiEngine;

  iii-engine = iiiEngine;

  agentmemory = requireSupported (
    final.buildNpmPackage {
      pname = "agentmemory";
      version = "0.9.29";
      src = agentmemorySrc;

      postPatch = ''
        cp ${./agentmemory-deps/package.json} package.json
        cp ${./agentmemory-deps/package-lock.json} package-lock.json
      '';

      npmDeps = final.importNpmLock { npmRoot = ./agentmemory-deps; };
      inherit (final.importNpmLock) npmConfigHook;

      postInstall = ''
        packageRoot="$out/lib/node_modules/@agentmemory/agentmemory"
        test -f "$packageRoot/LICENSE"
        test -f "$packageRoot/README.md"
        test -f "$packageRoot/AGENTS.md"
        test -f "$packageRoot/iii-config.yaml"
        test -f "$packageRoot/docker-compose.yml"
        test -f "$packageRoot/plugin/opencode/agentmemory-capture.ts"
        test -f "$packageRoot/integrations/pi/index.ts"
        test -f "$packageRoot/integrations/pi/security.ts"
      '';

      passthru = {
        sourceRevision = agentmemoryRev;
        inherit
          agentmemorySrc
          iiiEngine
          iiiVersion
          iiiRevision
          ;
        iii-engine = iiiEngine;
      };

      meta = with final.lib; {
        description = "Persistent memory for AI coding agents";
        homepage = "https://github.com/rohitg00/agentmemory";
        license = licenses.asl20;
        mainProgram = "agentmemory";
        platforms = supportedSystems;
      };
    }
  );
}
