{ inputs, ... }:
final: _prev:
let
  system = final.stdenv.hostPlatform.system;
  totalRecall = inputs.total-recall.packages.${system};

  # The registry currently supplies runtime binaries for the guest architecture only.
  requireGuestSystem =
    package:
    if system == "aarch64-linux" then
      package
    else
      throw "total-recall runtime packages are only available on aarch64-linux (requested ${system})";

  # Bump iiiVersion and this archive hash together when upgrading the runtime.
  # iii 0.24.0: sha256-YI8a0WM0jngYpV94ShHi7+KwPYE1MquWokMhHEJ57zA=
  iiiVersion = "0.24.0";
  iii = requireGuestSystem (
    final.stdenvNoCC.mkDerivation {
      pname = "total-recall-iii";
      version = iiiVersion;
      src = final.fetchurl {
        url = "https://github.com/iii-hq/iii/releases/download/iii%2Fv${iiiVersion}/iii-aarch64-unknown-linux-gnu.tar.gz";
        hash = "sha256-YI8a0WM0jngYpV94ShHi7+KwPYE1MquWokMhHEJ57zA=";
      };
      dontUnpack = true;
      dontFixup = true;

      installPhase = ''
        runHook preInstall
        mkdir -p "$out/bin"
        tar -xzf "$src" -C "$out/bin" --no-same-owner
        chmod 0555 "$out/bin/iii"
        runHook postInstall
      '';

      meta = {
        description = "Pinned iii runtime for total-recall";
        homepage = "https://github.com/iii-hq/iii";
        license = final.lib.licenses.elastic20;
        mainProgram = "iii";
        platforms = [ "aarch64-linux" ];
      };
    }
  );

  # Registry package versions and aarch64-linux content hashes. Review each pair on bump.
  # database 0.5.26: sha256-pqdDRmX8qm6RtzyTXVoVfjdvq84HkHaydvkXPQ+EwX8=
  # queue 0.21.26: sha256-OhgcZen7LF2unbxmUDOvZkWyDDPxW41QuRzfl2BN1vk=
  # cron 0.21.28: sha256-G0253hLdsiOZWR/auRhEHak6X7dsHINCIyaNVY90U3A=
  registryWorker =
    {
      name,
      version,
      hash,
    }:
    requireGuestSystem (
      final.stdenvNoCC.mkDerivation {
        pname = "total-recall-${name}";
        inherit version;
        src = final.fetchurl {
          url = "https://cdn.iii.cloud/workers/${name}/${version}/${name}-aarch64-unknown-linux-gnu.tar.gz";
          inherit hash;
        };
        dontUnpack = true;
        dontFixup = true;

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/bin"
          tar -xzf "$src" -C "$out/bin" --no-same-owner
          chmod 0555 "$out/bin/${name}"
          runHook postInstall
        '';

        meta = {
          description = "Pinned iii ${name} worker";
          homepage = "https://workers.iii.dev/workers/${name}";
          license = final.lib.licenses.asl20;
          mainProgram = name;
          platforms = [ "aarch64-linux" ];
        };
      }
    );
in
{
  total-recall-iii = iii;
  total-recall-database = registryWorker {
    name = "database";
    version = "0.5.26";
    hash = "sha256-pqdDRmX8qm6RtzyTXVoVfjdvq84HkHaydvkXPQ+EwX8=";
  };
  total-recall-queue = registryWorker {
    name = "queue";
    version = "0.21.26";
    hash = "sha256-OhgcZen7LF2unbxmUDOvZkWyDDPxW41QuRzfl2BN1vk=";
  };
  total-recall-cron = registryWorker {
    name = "cron";
    version = "0.21.28";
    hash = "sha256-G0253hLdsiOZWR/auRhEHak6X7dsHINCIyaNVY90U3A=";
  };

  total-recall-harness-ingestion = totalRecall.harness-ingestion;
  total-recall-harness-event-persistence = totalRecall.harness-event-persistence;
  total-recall-session-post-processing = totalRecall.session-post-processing;
  total-recall-opencode-plugin = totalRecall.opencode-harness-events;
  total-recall-pi-extension = totalRecall.pi-harness-events;
  total-recall-mcp-worker = totalRecall.mcp-worker;
}
