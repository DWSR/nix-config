# Pinned iii runtime and iii registry workers for total-recall
# (spec install-total-recall-on-fabro-vm, task 1.2; requirements 1.2, 1.4,
# 1.5, 1.6).
#
# Every artifact in this overlay is a fixed-hash `fetchurl`. Nothing here
# resolves a URL or looks up a worker at build time: there is no registry
# lookup, no unpinned built-in fetcher, and no fallback source, so an
# evaluation gets exactly the bytes recorded below. The upstream total-recall
# workers and adapters are re-exported untouched from the locked flake input.
#
# Pins (read 2026-11-03, matching `research.md`):
#   iii      0.24.0   github.com/iii-hq/iii release `iii/v0.24.0`
#                     sha256-YI8a0WM0jngYpV94ShHi7+KwPYE1MquWokMhHEJ57zA=
#   database 0.5.26   cdn.iii.cloud registry sha256
#                     a6a7434665fcaa6e91b73c935d5a157e376fabce079076b276f9173d0f84c17f
#   queue    0.21.26   cdn.iii.cloud registry sha256
#                     3a181c65e9fb2c5dae9dbc665033af6645b20c33f15b8d50b91cdf97604dd6f9
#   cron     0.21.28   cdn.iii.cloud registry sha256
#                     1b4db9de12ddb22399591fdab918441da93a5fb76c1c834223268d558f745370
#
# A bump is a reviewable diff: change `version`, the `url`, and the `hash`
# (plus the comment above) together, so the reviewed patch shows both the old
# and the new pin.
#
# Registry workers are pinned for `aarch64-linux` only: the fabro guest is the
# only host that runs them, so any other system is a recorded gap that fails
# loudly instead of silently resolving another archive.
{ inputs }:
final: _prev:
let
  inherit (final) lib;

  system = final.stdenv.hostPlatform.system;

  requirePinnedSystem =
    value:
    if system == "aarch64-linux" then
      value
    else
      throw "total-recall: no pinned aarch64-linux release is recorded for ${system}; add its URL and hash in overlays/total-recall.nix";

  # iii 0.24.0 supplies the worker registry and the stream/configuration
  # listeners the guest module configures in task 4.1.
  iiiVersion = "0.24.0";
  iiiRelease = {
    "aarch64-linux" = {
      target = "aarch64-unknown-linux-gnu";
      hash = "sha256-YI8a0WM0jngYpV94ShHi7+KwPYE1MquWokMhHEJ57zA=";
    };
  };

  iii = requirePinnedSystem (
    final.stdenvNoCC.mkDerivation {
      pname = "total-recall-iii";
      version = iiiVersion;

      src = final.fetchurl {
        url = "https://github.com/iii-hq/iii/releases/download/iii%2Fv${iiiVersion}/iii-${iiiRelease.${system}.target}.tar.gz";
        inherit (iiiRelease.${system}) hash;
      };

      # The release archive holds one `iii` binary at its root.
      sourceRoot = ".";

      # Prebuilt glibc-layout binary: rewrite its interpreter and RPATH so it
      # can exec on the NixOS guest.
      nativeBuildInputs = [ final.autoPatchelfHook ];
      buildInputs = [ final.stdenv.cc.cc.lib ];

      installPhase = ''
        runHook preInstall
        install -Dm755 iii "$out/bin/iii"
        runHook postInstall
      '';

      # iii ships under "Apache-2.0 AND Elastic-2.0" (upstream
      # `LICENSE.spdx`). No `meta.license` is declared, matching the upstream
      # total-recall flake's own iii derivation: the guest's package set does
      # not set `allowUnfree`, and enabling that guest-wide policy is outside
      # this task. The terms are recorded here and in `research.md` so a
      # later policy change can add `license = lib.licenses.elastic20` without
      # touching the rest of the derivation.
      meta = {
        description = "Pinned iii ${iiiVersion} runtime engine for total-recall";
        homepage = "https://github.com/iii-hq/iii";
        mainProgram = "iii";
        platforms = [ "aarch64-linux" ];
      };
    }
  );

  # Each registry archive holds a single executable named after the worker,
  # directly under the unpack root (no leading directory).
  mkWorker =
    {
      pname,
      version,
      hash,
    }:
    requirePinnedSystem (
      final.stdenvNoCC.mkDerivation {
        pname = "total-recall-${pname}";
        inherit version;

        src = final.fetchurl {
          url = "https://cdn.iii.cloud/workers/${pname}/${version}/${pname}-aarch64-unknown-linux-gnu.tar.gz";
          inherit hash;
        };

        # The archive unpacks to the bare executable, so keep the build root.
        sourceRoot = ".";

        # Prebuilt glibc-layout binary: rewrite its interpreter and RPATH so
        # it can exec on the NixOS guest.
        nativeBuildInputs = [ final.autoPatchelfHook ];
        buildInputs = [ final.stdenv.cc.cc.lib ];

        installPhase = ''
          runHook preInstall
          install -Dm755 ${pname} "$out/bin/${pname}"
          runHook postInstall
        '';

        meta = {
          description = "iii registry worker ${pname} ${version} for total-recall";
          homepage = "https://workers.iii.dev/workers/${pname}";
          license = lib.licenses.asl20;
          mainProgram = pname;
          platforms = [ "aarch64-linux" ];
        };
      }
    );

  # The locked total-recall flake exports the Rust workers and the TypeScript
  # adapters; re-export them under repository names without patching them.
  totalRecallPackages = inputs.total-recall.packages.${system};
in
{
  total-recall-iii = iii;

  total-recall-database = mkWorker {
    pname = "database";
    version = "0.5.26";
    # sha256:a6a7434665fcaa6e91b73c935d5a157e376fabce079076b276f9173d0f84c17f
    hash = "sha256-pqdDRmX8qm6RtzyTXVoVfjdvq84HkHaydvkXPQ+EwX8=";
  };

  total-recall-queue = mkWorker {
    pname = "queue";
    version = "0.21.26";
    # sha256:3a181c65e9fb2c5dae9dbc665033af6645b20c33f15b8d50b91cdf97604dd6f9
    hash = "sha256-OhgcZen7LF2unbxmUDOvZkWyDDPxW41QuRzfl2BN1vk=";
  };

  total-recall-cron = mkWorker {
    pname = "cron";
    version = "0.21.28";
    # sha256:1b4db9de12ddb22399591fdab918441da93a5fb76c1c834223268d558f745370
    hash = "sha256-G0253hLdsiOZWR/auRhEHak6X7dsHINCIyaNVY90U3A=";
  };

  total-recall-harness-ingestion = totalRecallPackages.harness-ingestion;

  total-recall-harness-event-persistence = totalRecallPackages.harness-event-persistence;

  total-recall-session-post-processing = totalRecallPackages.session-post-processing;

  total-recall-opencode-plugin = totalRecallPackages.opencode-harness-events;

  total-recall-pi-extension = totalRecallPackages.pi-harness-events;

  total-recall-mcp-worker = totalRecallPackages.mcp-worker;
}
