# MCP server packages — all built as npm packages from the npm registry or GitHub
{ inputs }:
final: _prev:
let
  # Builder for Google Cloud MCP servers that all follow the same pattern:
  # npm registry tarball + local package-lock for importNpmLock
  mkGcloudMcp =
    {
      pname,
      version,
      hash,
      description,
    }:
    final.buildNpmPackage rec {
      inherit pname version;
      src = final.fetchurl {
        url = "https://registry.npmjs.org/@google-cloud/${pname}/-/${pname}-${version}.tgz";
        inherit hash;
      };
      postPatch = ''
        cp ${./${pname}/package.json} package.json
        cp ${./${pname}/package-lock.json} package-lock.json
      '';
      npmDeps = final.importNpmLock { npmRoot = ./${pname}; };
      npmConfigHook = final.importNpmLock.npmConfigHook;
      dontNpmBuild = true;
      meta = with final.lib; {
        inherit description;
        homepage = "https://github.com/googleapis/gcloud-mcp";
        license = licenses.asl20;
        mainProgram = pname;
      };
    };
in
{
  mcp-hub = inputs.mcphub.packages.${final.stdenv.hostPlatform.system}.default;

  mcp-obsidian = final.buildNpmPackage {
    pname = "mcp-obsidian";
    version = "0.1.0";

    src = final.fetchFromGitHub {
      owner = "Piotr1215";
      repo = "mcp-obsidian";
      rev = "c99c0644b0229cd880c31ccd16a5fe1347e43078";
      hash = "sha256-6zGlPO4w7iiLJluTvDVEnY7Z/R2pov9Xlu0Qp7xmy7Q=";
    };

    npmDeps = final.importNpmLock {
      npmRoot = final.fetchFromGitHub {
        owner = "Piotr1215";
        repo = "mcp-obsidian";
        rev = "c99c0644b0229cd880c31ccd16a5fe1347e43078";
        hash = "sha256-6zGlPO4w7iiLJluTvDVEnY7Z/R2pov9Xlu0Qp7xmy7Q=";
      };
    };
    npmConfigHook = final.importNpmLock.npmConfigHook;
    dontNpmBuild = true;

    postInstall = ''
      makeWrapper ${final.nodejs}/bin/node $out/bin/mcp-obsidian \
        --add-flags "$out/lib/node_modules/obsidian-mcp-filesystem/src/index.js"
    '';

    nativeBuildInputs = [ final.makeWrapper ];

    meta = with final.lib; {
      description = "MCP server for Obsidian vault filesystem operations";
      homepage = "https://github.com/Piotr1215/mcp-obsidian";
      license = licenses.mit;
      mainProgram = "mcp-obsidian";
    };
  };

  chrome-devtools-mcp = final.stdenv.mkDerivation {
    pname = "chrome-devtools-mcp";
    version = "0.21.0";

    src = final.fetchurl {
      url = "https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-0.21.0.tgz";
      hash = "sha256-KMHWSSctf6ihIT792yZeTqaYuHqmUanN2SJje5PI184=";
    };

    dontBuild = true;
    nativeBuildInputs = [ final.makeWrapper ];

    installPhase = ''
      mkdir -p $out/lib/chrome-devtools-mcp
      cp -r . $out/lib/chrome-devtools-mcp/
      makeWrapper ${final.nodejs}/bin/node $out/bin/chrome-devtools-mcp \
        --add-flags "$out/lib/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js"
    '';

    meta = with final.lib; {
      description = "MCP server for Chrome DevTools";
      homepage = "https://github.com/ChromeDevTools/chrome-devtools-mcp";
      license = licenses.asl20;
      mainProgram = "chrome-devtools-mcp";
    };
  };

  claude-agent-acp = final.buildNpmPackage rec {
    pname = "claude-agent-acp";
    version = "0.25.3";

    src = final.fetchurl {
      url = "https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp/-/claude-agent-acp-${version}.tgz";
      hash = "sha256-67LPraeZuPkp3fTXi5InAgR4jHGrseWtjE86gRWAVtk=";
    };

    postPatch = ''
      cp ${./claude-agent-acp/package.json} package.json
      cp ${./claude-agent-acp/package-lock.json} package-lock.json
    '';

    npmDeps = final.importNpmLock { npmRoot = ./claude-agent-acp; };
    npmConfigHook = final.importNpmLock.npmConfigHook;
    dontNpmBuild = true;

    meta = with final.lib; {
      description = "ACP adapter for Claude Code via the Claude Agent SDK";
      homepage = "https://github.com/agentclientprotocol/claude-agent-acp";
      license = licenses.asl20;
      mainProgram = "claude-agent-acp";
    };
  };

  buildkite-mcp-server = final.buildGoModule {
    pname = "buildkite-mcp-server";
    version = "1.0.0";

    src = final.fetchFromGitHub {
      owner = "buildkite";
      repo = "buildkite-mcp-server";
      tag = "v1.0.0";
      hash = "sha256-1o/Co34WjtdzlOlDDMfhFo+6wLUj3UFDgcVKrzsXbEk=";
    };

    vendorHash = "sha256-CHe/sCQj4+BLG0mDoNsu8mPBUdKyMgA4BT4T1iQh5ts=";
    subPackages = [ "cmd/buildkite-mcp-server" ];

    meta = with final.lib; {
      description = "MCP server for Buildkite pipelines, builds, jobs, and tests";
      homepage = "https://github.com/buildkite/buildkite-mcp-server";
      license = licenses.mit;
      mainProgram = "buildkite-mcp-server";
    };
  };

  browsermcp = final.buildNpmPackage rec {
    pname = "browsermcp";
    version = "0.1.3";

    src = final.fetchurl {
      url = "https://registry.npmjs.org/@browsermcp/mcp/-/mcp-${version}.tgz";
      hash = "sha256-KtNMKRRcqAxfLn2OyQ4FiWl7GTOLK0WoPJGNSQekz5Y=";
    };

    postPatch = ''
      cp ${./browsermcp/package.json} package.json
      cp ${./browsermcp/package-lock.json} package-lock.json
    '';

    npmDeps = final.importNpmLock { npmRoot = ./browsermcp; };
    npmConfigHook = final.importNpmLock.npmConfigHook;
    dontNpmBuild = true;

    meta = with final.lib; {
      description = "MCP server for browser automation using Browser MCP";
      homepage = "https://browsermcp.io";
      license = licenses.asl20;
      mainProgram = "mcp-server-browsermcp";
    };
  };

  slack-mcp-server = final.buildGoModule {
    pname = "slack-mcp-server";
    version = "1.2.3";
    vendorHash = "sha256-mR+UFQRi98OTCyNISy3e7QTGKusd8XhNW4iz57QvpZE=";
    doCheck = false;

    src = final.fetchFromGitHub {
      owner = "korotovsky";
      repo = "slack-mcp-server";
      tag = "v1.2.3";
      hash = "sha256-AfmuQfV3RqFBw9b8B4aFM0EOuFQrUlUpTnMmQcyvCfU=";
    };
  };

  fastmail-mcp = final.buildNpmPackage {
    pname = "fastmail-mcp";
    version = "1.8.2";

    src = final.fetchFromGitHub {
      owner = "MadLlama25";
      repo = "fastmail-mcp";
      tag = "v1.8.2";
      hash = "sha256-/+fmVf2BUq+vBSOK+igfrp5fkU+RPGkYtYkBEFmZbMY=";
    };

    npmDepsHash = "sha256-/jfgV/H1i+XXM+KMrAtq5XK/a+5BZ1JoEvdxq/r6hkk=";

    meta = with final.lib; {
      description = "MCP server for Fastmail API integration";
      homepage = "https://github.com/MadLlama25/fastmail-mcp";
      license = licenses.mit;
      mainProgram = "fastmail-mcp";
    };
  };

  # Google Cloud MCP servers — all use the same template
  gcloud-mcp = mkGcloudMcp {
    pname = "gcloud-mcp";
    version = "0.5.3";
    hash = "sha256-Q2ujZBp7PH+wS7RASl1y0uWJFk42NHSLnhBpl9206to=";
    description = "MCP server for Google Cloud via gcloud CLI";
  };

  observability-mcp = mkGcloudMcp {
    pname = "observability-mcp";
    version = "0.2.3";
    hash = "sha256-osa+MSVVXZBHS/zA+1vBaybPOsuNzsNOn58zRSU2RzE=";
    description = "MCP server for Google Cloud Observability";
  };

  storage-mcp = mkGcloudMcp {
    pname = "storage-mcp";
    version = "0.3.3";
    hash = "sha256-bXqx4EqmYta8Z1S34FSG/uhZ8OEkHcgR3wen+EDqoh4=";
    description = "MCP server for Google Cloud Storage";
  };

  backupdr-mcp = mkGcloudMcp {
    pname = "backupdr-mcp";
    version = "0.1.0";
    hash = "sha256-cUZc5oWUlCgtcnY6uWnw316+2GG8MlO6vru3/29pr5A=";
    description = "MCP server for Google Cloud Backup and DR";
  };
}
