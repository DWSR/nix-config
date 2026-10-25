{
  lib,
  writeShellApplication,
  coreutils,
  jq,
  curl,
  gnutar,
  nix,
  name,
  archive,
  digest,
  smoke,
}:
# fabro-sandbox-verify: operator-facing verification harness for the repo-built
# sandbox image (spec `nix-built-container-for-default-fabro-environmen`,
# task 7.5; Requirements 2.1, 3.1, 4.2, 6.3, 6.4).
#
# Task 7.5 is the end-to-end verification stage: build the image twice from
# identical inputs and confirm the digest is unchanged (2.1); confirm the loader
# recorded the digest and the reconciler pointed Fabro's `default` environment
# at `<name>@<digest>` (3.1, 4.2); and run the tools/store/daemon smoke check
# (6.3, 6.4). Those steps need a switched guest, so this script packages the
# runbook as one executable the operator runs on the guest instead of
# reconstructing it from prose:
#
#   - `reproducibility` compares the digest derivation with the digest recorded
#     in the archive's `index.json`, then rebuilds the archive derivation with
#     `nix-store --realise --check`. `--check` errors when the second build
#     differs from the first, which is exactly the reproducibility failure.
#   - `wiring` reads the loader-recorded digest, forms `<name>@<digest>`, and
#     compares it with `.image.docker` returned by
#     GET /api/v1/environments/default.
#   - `smoke` runs the installed `fabro-sandbox-smoke` (home, `/usr/bin/env`,
#     tools, certs, store, daemon, flake registry).
#   - `all` runs the three in order; re-running it after a contents change
#     confirms the digest and the environment reference both move.
#
# The archive, digest, and smoke store paths are baked in at build time (the
# guest's own derivations); every one is overridable through an env var so the
# same script can be pointed at fixtures. Failures follow the repo's
# `[<tool>-failure: <label>] <detail>` convention.
writeShellApplication {
  name = "fabro-sandbox-verify";
  runtimeInputs = [
    coreutils
    jq
    curl
    gnutar
    nix
  ];
  text = ''
    set -euo pipefail

    version="0.1.0"

    name="''${FABRO_SANDBOX_NAME:-${name}}"
    archive="''${FABRO_SANDBOX_ARCHIVE:-${archive}}"
    digest_path="''${FABRO_SANDBOX_DIGEST_PATH:-${digest}}"
    digest_file="''${FABRO_SANDBOX_DIGEST_FILE:-/run/fabro-sandbox/digest}"
    api_base="''${FABRO_API_BASE:-http://127.0.0.1:32276/api/v1}"
    smoke_bin="''${FABRO_SANDBOX_SMOKE_BIN:-${lib.getExe smoke}}"

    body_file=""
    cleanup() {
      if [ -n "$body_file" ]; then
        rm -f "$body_file"
      fi
    }
    trap cleanup EXIT

    fail() {
      printf 'fabro-sandbox-verify: [verify-failure: %s] %s\n' "$1" "$2" >&2
      exit 1
    }

    usage() {
      cat <<'USAGE'
    fabro-sandbox-verify — verify the repo-built sandbox image end to end on the guest.

    USAGE:
      fabro-sandbox-verify <subcommand>

    SUBCOMMANDS:
      reproducibility  Build the image from identical inputs a second time and
                       confirm the digest is unchanged (Requirement 2.1). Compares
                       the digest derivation with the digest in the archive's
                       index.json, then rebuilds the archive derivation with
                       `nix-store --realise --check` so a non-reproducible build
                       fails with [verify-failure: not_reproducible].
      wiring           Confirm the loader recorded the digest and Fabro's `default`
                       environment references <name>@<digest> through the
                       environments API (Requirements 3.1, 4.2).
      smoke            Run fabro-sandbox-smoke (home, /usr/bin/env, tools,
                       certs, store, daemon, flake registry)
                       (Requirements 6.3, 6.4).
      all              Run reproducibility, wiring, and smoke in order. Re-run
                       after a contents change to confirm the digest and the
                       environment reference both move.

    ENVIRONMENT OVERRIDES:
      FABRO_SANDBOX_NAME         Image name (default: ${name}).
      FABRO_SANDBOX_ARCHIVE      OCI archive store path (default: ${archive}).
      FABRO_SANDBOX_DIGEST_PATH  Digest derivation store path (default: ${digest}).
      FABRO_SANDBOX_DIGEST_FILE  Loader-recorded digest file (default: /run/fabro-sandbox/digest).
      FABRO_API_BASE             Fabro API base (default: http://127.0.0.1:32276/api/v1).
      FABRO_DEV_TOKEN            Bearer token for the environments API (required by wiring).
      FABRO_SANDBOX_SMOKE_BIN    fabro-sandbox-smoke executable (default: ${lib.getExe smoke}).

    OPTIONS:
      -h, --help     Print this help and exit 0.
      -V, --version  Print the version banner and exit 0.

    Failures print `fabro-sandbox-verify: [verify-failure: <label>] <detail>`.
    USAGE
    }

    run_reproducibility() {
      if [ ! -e "$archive" ]; then
        fail archive_missing "sandbox image archive not found: $archive"
      fi
      if [ ! -r "$digest_path" ]; then
        fail digest_missing "sandbox image digest not found: $digest_path"
      fi

      declared="$(cat "$digest_path")"
      extracted="$(tar -xOf "$archive" index.json | jq -r '.manifests[0].digest')"

      if [ -z "$extracted" ] || [ "$extracted" = "null" ]; then
        fail digest_extract "archive index.json has no manifest digest: $archive"
      fi
      if [ "$declared" != "$extracted" ]; then
        fail digest_mismatch "declared=$declared extracted=$extracted"
      fi

      # Rebuild the archive derivation and compare it with the existing output:
      # this is the "build twice" step. `--check` errors when the rebuild
      # differs, which is exactly the reproducibility failure to catch.
      drv="$(nix-store --query --deriver "$archive")"
      if [ -z "$drv" ] || [ "$drv" = "unknown-deriver" ]; then
        fail deriver_missing "no derivation recorded for $archive"
      fi
      if ! nix-store --realise "$drv" >/dev/null 2>&1; then
        fail not_reproducible "cannot realise the archive derivation: $drv"
      fi
      if ! nix-store --realise --check "$drv" >/dev/null 2>&1; then
        fail not_reproducible "archive is not bit-reproducible: $drv"
      fi

      printf 'fabro-sandbox-verify: [reproducibility] digest %s reproduced from %s\n' "$declared" "$archive"
    }

    run_wiring() {
      if [ ! -r "$digest_file" ]; then
        fail digest_missing "loader did not record the image digest: $digest_file"
      fi
      digest="$(cat "$digest_file")"
      ref="$name@$digest"

      if [ -z "''${FABRO_DEV_TOKEN:-}" ]; then
        fail token_missing "FABRO_DEV_TOKEN must be set (sops fabro-env) to query the environments API"
      fi

      endpoint="$api_base/environments/default"
      body_file="$(mktemp)"

      if ! status="$(curl -sS -o "$body_file" -w '%{http_code}' -H "Authorization: Bearer $FABRO_DEV_TOKEN" "$endpoint")"; then
        fail get_transport "GET $endpoint failed (transport error): declared=$ref"
      fi
      if [ "$status" != "200" ]; then
        persisted="$(jq -r '.image.docker // "<unknown>"' "$body_file" 2>/dev/null || printf '%s' '<unknown>')"
        fail get_status "GET $endpoint failed (HTTP $status): declared=$ref persisted=$persisted"
      fi

      persisted="$(jq -r '.image.docker // ""' "$body_file")"
      if [ "$persisted" != "$ref" ]; then
        fail reference_mismatch "declared=$ref persisted=$persisted"
      fi

      printf 'fabro-sandbox-verify: [wiring] default environment references %s\n' "$ref"
    }

    run_smoke() {
      if [ ! -x "$smoke_bin" ]; then
        fail smoke_missing "fabro-sandbox-smoke is not executable: $smoke_bin"
      fi
      if ! "$smoke_bin"; then
        fail smoke_failed "fabro-sandbox-smoke failed (home, env, tools, certs, store, daemon, or registry probe)"
      fi
      printf 'fabro-sandbox-verify: [smoke] fabro-sandbox-smoke passed\n'
    }

    run_all() {
      run_reproducibility
      run_wiring
      run_smoke
      printf 'fabro-sandbox-verify: all checks passed\n'
    }

    case "''${1:-}" in
      -h | --help)
        usage
        ;;
      -V | --version)
        printf 'fabro-sandbox-verify %s\n' "$version"
        ;;
      reproducibility)
        run_reproducibility
        ;;
      wiring)
        run_wiring
        ;;
      smoke)
        run_smoke
        ;;
      all)
        run_all
        ;;
      "")
        usage >&2
        fail invalid_arguments "no subcommand given (expected: reproducibility|wiring|smoke|all)"
        ;;
      *)
        fail invalid_arguments "unknown subcommand: $1 (expected: reproducibility|wiring|smoke|all)"
        ;;
    esac
  '';
}
