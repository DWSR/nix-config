{ inputs, ... }:
final: _prev:
let
  totalRecall = inputs.total-recall;
  system = final.stdenv.hostPlatform.system;
  # Versions and fixed hashes are copied from total-recall's iii pin and the
  # iii worker registry. Any update changes an audited line in this table.
  packages = {
    # iii 0.24.0; aarch64-linux SRI hash: sha256-YI8a0WM0jngYpV94ShHi7+KwPYE1MquWokMhHEJ57zA=
    iii = {
      version = "0.24.0";
      url = "https://github.com/iii-hq/iii/releases/download/iii%2Fv0.24.0/iii-aarch64-unknown-linux-gnu.tar.gz";
      hash = "sha256-YI8a0WM0jngYpV94ShHi7+KwPYE1MquWokMhHEJ57zA=";
      binary = "iii";
    };
    # database 0.5.26; aarch64-linux SHA-256: a6a7434665fcaa6e91b73c935d5a157e376fabce079076b276f9173d0f84c17f
    database = {
      version = "0.5.26";
      url = "https://cdn.iii.cloud/workers/database/0.5.26/database-aarch64-unknown-linux-gnu.tar.gz";
      hash = "sha256-pqdDRmX8qm6RtzyTXVoVfjdvq84HkHaydvkXPQ+EwX8=";
      binary = "database";
    };
    # queue 0.21.26; aarch64-linux SHA-256: 3a181c65e9fb2c5dae9dbc665033af6645b20c33f15b8d50b91cdf97604dd6f9
    queue = {
      version = "0.21.26";
      url = "https://cdn.iii.cloud/workers/queue/0.21.26/queue-aarch64-unknown-linux-gnu.tar.gz";
      hash = "sha256-OhgcZen7LF2unbxmUDOvZkWyDDPxW41QuRzfl2BN1vk=";
      binary = "queue";
    };
    # cron 0.21.28; aarch64-linux SHA-256: 1b4db9de12ddb22399591fdab918441da93a5fb76c1c834223268d558f745370
    cron = {
      version = "0.21.28";
      url = "https://cdn.iii.cloud/workers/cron/0.21.28/cron-aarch64-unknown-linux-gnu.tar.gz";
      hash = "sha256-G0253hLdsiOZWR/auRhEHak6X7dsHINCIyaNVY90U3A=";
      binary = "cron";
    };
  };

  mkBinary =
    name: spec:
    final.stdenvNoCC.mkDerivation {
      pname = "total-recall-${name}";
      inherit (spec) version;
      src = final.fetchurl {
        inherit (spec) url hash;
      };
      sourceRoot = ".";
      dontConfigure = true;
      dontBuild = true;
      dontFixup = true;

      installPhase = ''
        runHook preInstall
        install -Dm755 ${spec.binary} "$out/bin/${spec.binary}"
        runHook postInstall
      '';

      meta = with final.lib; {
        description = "Pinned ${name} binary for the total-recall guest";
        mainProgram = spec.binary;
        platforms = [ "aarch64-linux" ];
      };
    };

  upstream = totalRecall.packages.${system};
in
{
  total-recall-iii = mkBinary "iii" packages.iii;
  total-recall-database = mkBinary "database" packages.database;
  total-recall-queue = mkBinary "queue" packages.queue;
  total-recall-cron = mkBinary "cron" packages.cron;

  total-recall-harness-ingestion = upstream.harness-ingestion;
  total-recall-harness-event-persistence = upstream.harness-event-persistence;
  total-recall-session-post-processing = upstream.session-post-processing;
  total-recall-opencode-plugin = upstream.opencode-harness-events;
  total-recall-pi-extension = upstream.pi-harness-events;
  total-recall-mcp-worker = upstream.mcp-worker;
}
