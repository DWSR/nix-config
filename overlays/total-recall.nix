# total-recall: pinned iii runtime, iii registry workers, and aliases for the
# upstream total-recall workers/adapters installed on the fabro guest and
# workstations (design "C1: Package overlay").
#
# Every artifact below is a fixed-hash archive; nothing is resolved through a
# registry lookup or an unhashed URL at build time. Upstream sources are not
# patched. The prebuilt Linux archives are only ELF-normalised (interpreter and
# runpath rewritten to the Nix store) so they execute on NixOS.
#
# Bumps: change the version and hash together and keep this block current so a
# bump is a reviewable diff.
#
# iii 0.24.0 (research.md R2)
#   aarch64-linux:  sha256-YI8a0WM0jngYpV94ShHi7+KwPYE1MquWokMhHEJ57zA=
#   aarch64-darwin: sha256-xCqLwRauaHLb9GIrLuRJEDKgbNK3UxKvuCqPbGR6ChI=
# database 0.5.26 (registry, aarch64-linux)
#   sha256 a6a7434665fcaa6e91b73c935d5a157e376fabce079076b276f9173d0f84c17f
# queue 0.21.26 (registry, aarch64-linux)
#   sha256 3a181c65e9fb2c5dae9dbc665033af6645b20c33f15b8d50b91cdf97604dd6f9
# cron 0.21.28 (registry, aarch64-linux)
#   sha256 1b4db9de12ddb22399591fdab918441da93a5fb76c1c834223268d558f745370
{ inputs }:
final: _prev:
let
  system = final.stdenv.hostPlatform.system;

  # The pinned total-recall flake exports the Rust workers and the OpenCode,
  # Pi, and MCP adapters for the build system.
  upstream = inputs.total-recall.packages.${system};

  iiiVersion = "0.24.0";
  iiiTargets = {
    "aarch64-linux" = {
      target = "aarch64-unknown-linux-gnu";
      hash = "sha256-YI8a0WM0jngYpV94ShHi7+KwPYE1MquWokMhHEJ57zA=";
    };
    "aarch64-darwin" = {
      target = "aarch64-apple-darwin";
      hash = "sha256-xCqLwRauaHLb9GIrLuRJEDKgbNK3UxKvuCqPbGR6ChI=";
    };
  };
  iiiTarget =
    iiiTargets.${system}
      or (throw "total-recall-iii: no pinned iii ${iiiVersion} archive for ${system}");

  # Registry worker versions and aarch64-linux hashes read from
  # https://workers.iii.dev on 2026-11-03 (research.md R5). Upstream publishes
  # no Nix definition for these workers, so they are pinned here.
  registryWorkers = {
    "aarch64-linux" = {
      database = {
        version = "0.5.26";
        hash = "sha256-pqdDRmX8qm6RtzyTXVoVfjdvq84HkHaydvkXPQ+EwX8=";
      };
      queue = {
        version = "0.21.26";
        hash = "sha256-OhgcZen7LF2unbxmUDOvZkWyDDPxW41QuRzfl2BN1vk=";
      };
      cron = {
        version = "0.21.28";
        hash = "sha256-G0253hLdsiOZWR/auRhEHak6X7dsHINCIyaNVY90U3A=";
      };
    };
  };
  workers =
    registryWorkers.${system}
      or (throw "total-recall: the iii registry workers are pinned for aarch64-linux only, not ${system}");

  mkPrebuilt =
    {
      pname,
      version,
      src,
      mainProgram ? pname,
      description,
      homepage,
      license,
      platforms,
    }:
    final.stdenvNoCC.mkDerivation {
      inherit pname version src;

      sourceRoot = ".";
      strictDeps = true;

      # Rewrite only the ELF interpreter/runpath of the prebuilt Linux
      # archives so they run on NixOS. No upstream source is modified.
      nativeBuildInputs = final.lib.optionals final.stdenv.isLinux [ final.autoPatchelfHook ];
      buildInputs = final.lib.optionals final.stdenv.isLinux [ final.stdenv.cc.cc.lib ];

      # The Darwin archives are ad-hoc signed; fixup would strip them and
      # invalidate the signature.
      dontFixup = final.stdenv.isDarwin;

      installPhase = ''
        runHook preInstall
        install -Dm755 ${mainProgram} "$out/bin/${mainProgram}"
        runHook postInstall
      '';

      meta = {
        inherit
          description
          homepage
          license
          mainProgram
          platforms
          ;
        sourceProvenance = [ final.lib.sourceTypes.binaryNativeCode ];
      };
    };

  mkRegistryWorker =
    name:
    { version, hash }:
    mkPrebuilt {
      pname = "total-recall-${name}";
      inherit version;
      src = final.fetchurl {
        url = "https://cdn.iii.cloud/workers/${name}/${version}/${name}-aarch64-unknown-linux-gnu.tar.gz";
        inherit hash;
      };
      mainProgram = name;
      description = "Pinned iii ${name} worker (${version})";
      homepage = "https://workers.iii.dev/workers/${name}";
      license = final.lib.licenses.asl20;
      platforms = [ "aarch64-linux" ];
    };
in
{
  total-recall-iii = mkPrebuilt {
    pname = "total-recall-iii";
    version = iiiVersion;
    src = final.fetchurl {
      url = "https://github.com/iii-hq/iii/releases/download/iii%2Fv${iiiVersion}/iii-${iiiTarget.target}.tar.gz";
      inherit (iiiTarget) hash;
    };
    mainProgram = "iii";
    description = "Pinned iii engine runtime (${iiiVersion})";
    homepage = "https://github.com/iii-hq/iii";
    license = final.lib.licenses.elastic20;
    platforms = builtins.attrNames iiiTargets;
  };

  total-recall-database = mkRegistryWorker "database" workers.database;
  total-recall-queue = mkRegistryWorker "queue" workers.queue;
  total-recall-cron = mkRegistryWorker "cron" workers.cron;

  # Upstream exports, re-exported under the repository's stable names (C1).
  total-recall-harness-ingestion = upstream.harness-ingestion;
  total-recall-harness-event-persistence = upstream.harness-event-persistence;
  total-recall-session-post-processing = upstream.session-post-processing;
  total-recall-opencode-plugin = upstream.opencode-harness-events;
  total-recall-pi-extension = upstream.pi-harness-events;
  total-recall-mcp-worker = upstream.mcp-worker;
}
