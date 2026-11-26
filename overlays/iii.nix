_: final: _prev:
let
  system = final.stdenv.hostPlatform.system;
  supportedSystems = [
    "aarch64-linux"
    "aarch64-darwin"
  ];
  requireSupported =
    value:
    if builtins.elem system supportedSystems then value else throw "Unsupported iii system: ${system}";

  # Registry snapshot 2026-11-16: pure pinned data, no evaluation-time
  # resolution. The manifest is the only source of worker versions, archive
  # binary names, URLs, and digests.
  manifest = import ./iii-workers.nix;

  # iii 0.26.0 release assets (research.md § Engine release facts). The
  # tag-pinned URL and the recorded SHA-256 make each fetch immutable; the
  # engine is the upstream archive, never an installer or a local binary.
  iiiVersion = "0.26.0";
  iiiRevision = "iii/v${iiiVersion}";
  engineSources = {
    "aarch64-linux" = {
      url = "https://github.com/iii-hq/iii/releases/download/${iiiRevision}/iii-aarch64-unknown-linux-gnu.tar.gz";
      hash = "sha256-4u5E0es48OM30+d7O4YB2ib/G9k0zIpMhJubz0FKtAs=";
    };
    "aarch64-darwin" = {
      url = "https://github.com/iii-hq/iii/releases/download/${iiiRevision}/iii-aarch64-apple-darwin.tar.gz";
      hash = "sha256-JzApagiuWEN1ey55E61ltigpAcmLlR28IwGODrQl4oU=";
    };
  };

  iii = requireSupported (
    final.stdenvNoCC.mkDerivation {
      pname = "iii";
      version = iiiVersion;
      src = final.fetchurl { inherit (engineSources.${system}) url hash; };
      dontUnpack = true;
      # The archives are single-executable tarballs; the ELF interpreter and
      # RPATH are the only Linux fixups, so never rewrite the pinned bytes.
      dontStrip = true;
      dontFixup = final.stdenv.hostPlatform.isDarwin;

      nativeBuildInputs = final.lib.optionals final.stdenv.hostPlatform.isLinux [
        final.autoPatchelfHook
      ];
      buildInputs = final.lib.optionals final.stdenv.hostPlatform.isLinux [
        final.glibc
        final.stdenv.cc.cc.lib
      ];

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

      meta = {
        description = "Pinned iii persistence engine";
        homepage = "https://github.com/iii-hq/iii";
        mainProgram = "iii";
        platforms = supportedSystems;
      };
    }
  );

  # One generic derivation builds any cataloged worker: the manifest supplies
  # the version, the per-system fixed-output source, and the archive-root
  # executable name. Linux prebuilts get the same interpreter/RPATH fixup as
  # the engine; Darwin keeps the original Mach-O bytes.
  mkWorker =
    name: entry:
    let
      target =
        entry.targets.${system} or (throw "iii-worker ${name} has no pinned artifact for system ${system}");
    in
    final.stdenvNoCC.mkDerivation {
      pname = "iii-worker-${name}";
      inherit (entry) version;
      src = final.fetchurl { inherit (target) url hash; };
      dontUnpack = true;
      # The archives hold one prebuilt executable; never rewrite the pinned
      # bytes beyond the Linux ELF interpreter/RPATH fixup.
      dontStrip = true;
      dontFixup = final.stdenv.hostPlatform.isDarwin;

      nativeBuildInputs = final.lib.optionals final.stdenv.hostPlatform.isLinux [
        final.autoPatchelfHook
      ];
      buildInputs = final.lib.optionals final.stdenv.hostPlatform.isLinux [
        final.glibc
        final.stdenv.cc.cc.lib
      ];

      installPhase = ''
        runHook preInstall
        mkdir -p "$out/bin"
        tar -xzf "$src" -C "$out/bin"
        test -x "$out/bin/${entry.binary}" || {
          echo "iii-worker ${name}: ${entry.binary} is not the archive-root executable on ${system}" >&2
          exit 1
        }
        chmod 0555 "$out/bin/${entry.binary}"
        runHook postInstall
      '';

      passthru = {
        workerName = name;
        iiiEngineVersion = manifest.engineVersion;
      };

      meta = {
        description = "Pinned iii ${manifest.engineVersion} worker ${name}";
        homepage = "https://github.com/iii-hq/workers";
        mainProgram = entry.binary;
        platforms = supportedSystems;
      };
    };

  iiiWorkers = requireSupported (builtins.mapAttrs mkWorker manifest.workers);

  # `judge-openai` hardcodes OpenAI's Decisions endpoint, so the registry
  # artifact cannot be pointed at the loopback LiteLLM gateway. Build the
  # pinned 0.4.1 source with two deliberate patches:
  #
  #   * the endpoint constant becomes the compile-time
  #     `JUDGE_OPENAI_ENDPOINT` value (the module passes LiteLLM's
  #     `/v1/decisions` URL);
  #   * `gpt-6-luna-decisions` joins the supported-model list, the logical
  #     LiteLLM model that carries the ChatGPT subscription token.
  #
  # The console UI feature is off: its build script expects npm-built
  # `dist/` assets that the source checkout does not carry. This project is
  # headless and configures the worker through the engine's configuration
  # entry, so the UI functions are not needed.
  judgeOpenAiLitellm = requireSupported (
    final.rustPlatform.buildRustPackage {
      pname = "iii-worker-judge-openai-litellm";
      version = "0.4.1";

      src = final.fetchFromGitHub {
        owner = "iii-hq";
        repo = "workers";
        rev = "069502227cb1b207d1979df659798c770fafa14b";
        hash = "sha256-gYpkSmc2m2TrFMBiYdqjLYKXS3wOWmJqyLXHnZMQ5oI=";
      };

      cargoRoot = "judge-openai";
      buildAndTestSubdir = "judge-openai";
      cargoHash = "sha256-RhjDeAphzGas1JIHYN0T0PsFjnGqkt/qvBVWSus2ZOU=";
      cargoBuildFlags = [ "--no-default-features" ];
      doCheck = false;

      env.JUDGE_OPENAI_ENDPOINT = "http://127.0.0.1:4000/v1/decisions";

      postPatch = ''
        substituteInPlace judge-openai/src/client.rs \
          --replace-fail \
            'const ENDPOINT: &str = "https://api.openai.com/v1/decisions";' \
            'const ENDPOINT: &str = env!("JUDGE_OPENAI_ENDPOINT");'
        substituteInPlace judge-openai/src/lib.rs \
          --replace-fail \
            'pub const SUPPORTED_MODELS: &[&str] = &["gpt-6-luna"];' \
            'pub const SUPPORTED_MODELS: &[&str] = &["gpt-6-luna", "gpt-6-luna-decisions"];'
      '';

      passthru = {
        endpoint = "http://127.0.0.1:4000/v1/decisions";
        sourceRevision = "069502227cb1b207d1979df659798c770fafa14b";
      };

      meta = {
        description = "iii judge-openai provider built to call LiteLLM's Decisions endpoint";
        homepage = "https://github.com/iii-hq/workers";
        mainProgram = "judge-openai";
        platforms = supportedSystems;
      };
    }
  );
in
{
  inherit iii;
  iii-workers = iiiWorkers;
  inherit judgeOpenAiLitellm;
}
