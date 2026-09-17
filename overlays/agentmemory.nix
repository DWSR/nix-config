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

      patches = [
        ./agentmemory-patches/opencode-capture.patch
        ./agentmemory-patches/opencode-cache-stability.patch
        ./agentmemory-patches/bm25-index-cap.patch
        ./agentmemory-patches/disable-otel.patch
      ];

      postPatch = ''
        cp ${./agentmemory-deps/package.json} package.json
        cp ${./agentmemory-deps/package-lock.json} package-lock.json
      '';

      npmDeps = final.importNpmLock { npmRoot = ./agentmemory-deps; };
      inherit (final.importNpmLock) npmConfigHook;
      nativeBuildInputs = [ final.makeWrapper ];

      postInstall = ''
        packageRoot="$out/lib/node_modules/@agentmemory/agentmemory"
        mkdir -p "$packageRoot/integrations"
        cp -R ${agentmemorySrc}/integrations/pi "$packageRoot/integrations/"

        test -f "$packageRoot/LICENSE"
        test -f "$packageRoot/README.md"
        test -f "$packageRoot/AGENTS.md"
        test -f "$packageRoot/iii-config.yaml"
        test -f "$packageRoot/docker-compose.yml"
        test -f "$packageRoot/plugin/opencode/agentmemory-capture.ts"
        test -f "$packageRoot/integrations/pi/index.ts"
        test -f "$packageRoot/integrations/pi/security.ts"

        # Keep the upstream CLI as the runtime entrypoint, but make its
        # compatible iii binary available on PATH so it never falls back to
        # an imperative network installer.
        rm "$out/bin/agentmemory"
        makeWrapper ${final.nodejs}/bin/node "$out/bin/agentmemory" \
          --prefix PATH : ${iiiEngine}/bin \
          --set AGENTMEMORY_III_VERSION ${iiiVersion} \
          --run '
            if [ -z "''${III_ENGINE_PORT-}" ] && [ -z "''${III_ENGINE_URL-}" ]; then
              restPort="''${III_REST_PORT-}"
              portArgPending=0
              for arg in "$@"; do
                if [ "$portArgPending" -eq 1 ]; then
                  restPort="$arg"
                  portArgPending=0
                else
                  case "$arg" in
                    --port)
                      portArgPending=1
                      ;;
                    --port=*)
                      restPort="''${arg#--port=}"
                      ;;
                  esac
                fi
              done
              case "$restPort" in
                (""|*[!0-9]*) ;;
                (*)
                  if [ "$restPort" -gt 0 ] && [ "$restPort" -le 65535 ]; then
                    enginePort=$((restPort + 46023))
                    if [ "$enginePort" -gt 65535 ]; then
                      enginePort=$(((enginePort - 1024) % 64512 + 1024))
                    fi
                    export III_ENGINE_PORT="$enginePort"
                  fi
                  ;;
              esac
            fi
          ' \
          --add-flags "$packageRoot/dist/cli.mjs"

        # The upstream `mcp` command is the stock authenticated REST proxy
        # with its documented local fallback. Expose it as a stable binary
        # without introducing a second shim implementation.
        makeWrapper "$out/bin/agentmemory" "$out/bin/agentmemory-mcp" \
          --add-flags mcp

        grep -q 'host: 127.0.0.1' "$packageRoot/iii-config.yaml"
        ! grep -q 'host: 0.0.0.0' "$packageRoot/iii-config.yaml"
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
