{ pkgs, name }:
# fabro-sandbox-env-reconcile: keep Fabro's persisted `default` environment
# pointing at the sandbox image the guest just loaded.
#
# The loader (scripts/fabro-sandbox-image-load.nix) records the image's
# content digest to /run/fabro-sandbox/digest. This script reads that digest,
# forms the immutable reference `<name>@<digest>`, and reconciles Fabro's
# `default` environment to it through the environments API:
#
#   1. `ref="${name}@$(cat /run/fabro-sandbox/digest)"`.
#   2. GET /api/v1/environments/default with the dev token. A 404 is reported
#      (`declared=<ref> persisted=<missing>`) rather than repaired: `default`
#      is seeded by install, so reconciliation updates, it does not create.
#   3. If `.image.docker` already equals `ref`, exit 0 without writing
#      (idempotent).
#   4. Otherwise PUT the persisted environment back with `image.docker`
#      replaced, guarded by `If-Match: "<revision>"` so a concurrent writer
#      cannot be clobbered. The body keeps every other field (provider,
#      resources, network, lifecycle, labels, env) verbatim and drops the
#      server-managed `id`/`revision`.
#
# `name` is the image name (fabro.sandboxImage.name) baked in at build time;
# the digest is read at run time, so an unchanged image leaves the unit (and
# the persisted environment) untouched. FABRO_DEV_TOKEN comes from the
# sops-rendered `fabro-env` file (EnvironmentFile) and never enters the image.
#
# Any failure reports the declared and persisted references (and, where one
# exists, the HTTP status) so the operator can see what diverged.
pkgs.writeShellApplication {
  name = "fabro-sandbox-env-reconcile";
  runtimeInputs = [
    pkgs.curl
    pkgs.jq
    pkgs.coreutils
  ];
  text = ''
    set -euo pipefail

    api_base="''${FABRO_API_BASE:-http://127.0.0.1:32276/api/v1}"
    endpoint="$api_base/environments/default"
    digest_file="/run/fabro-sandbox/digest"

    : "''${FABRO_DEV_TOKEN:?fabro-sandbox-env-reconcile: FABRO_DEV_TOKEN must be set (sops fabro-env)}"

    if [ ! -r "$digest_file" ]; then
      echo "fabro-sandbox-env-reconcile: declared digest file is missing: $digest_file" >&2
      exit 1
    fi

    # The immutable reference Fabro should run: `<name>@<digest>`.
    ref="${name}@$(cat "$digest_file")"

    body_file="$(mktemp)"
    put_body="$(mktemp)"
    trap 'rm -f "$body_file" "$put_body"' EXIT

    # GET the persisted `default` environment. Capture the body and the HTTP
    # status so a 404 (missing) and any other failure can be reported
    # distinctly.
    if ! status="$(
      curl -sS -o "$body_file" -w '%{http_code}' \
        -H "Authorization: Bearer $FABRO_DEV_TOKEN" \
        "$endpoint"
    )"; then
      echo "fabro-sandbox-env-reconcile: GET $endpoint failed (transport error): declared=$ref" >&2
      exit 1
    fi

    if [ "$status" = "404" ]; then
      echo "fabro-sandbox-env-reconcile: declared=$ref persisted=<missing>" >&2
      exit 1
    fi

    if [ "$status" != "200" ]; then
      persisted="$(jq -r '.image.docker // "<unknown>"' "$body_file" 2>/dev/null || printf '%s' '<unknown>')"
      echo "fabro-sandbox-env-reconcile: GET $endpoint failed (HTTP $status): declared=$ref persisted=$persisted" >&2
      exit 1
    fi

    revision="$(jq -r '.revision' "$body_file")"
    persisted="$(jq -r '.image.docker // ""' "$body_file")"

    # Already reconciled: leave the persisted environment untouched.
    if [ "$persisted" = "$ref" ]; then
      echo "fabro-sandbox-env-reconcile: default environment already at $ref (no change)"
      exit 0
    fi

    # Replace the environment, preserving every field except the
    # server-managed id/revision, with image.docker pointed at the digest.
    jq --arg ref "$ref" 'del(.id, .revision) | .image.docker = $ref' "$body_file" > "$put_body"

    if ! put_status="$(
      curl -sS -o /dev/null -w '%{http_code}' -X PUT \
        -H "Authorization: Bearer $FABRO_DEV_TOKEN" \
        -H "If-Match: \"$revision\"" \
        -H "Content-Type: application/json" \
        --data @"$put_body" \
        "$endpoint"
    )"; then
      echo "fabro-sandbox-env-reconcile: PUT $endpoint failed (transport error): declared=$ref persisted=$persisted" >&2
      exit 1
    fi

    if [ "$put_status" != "200" ]; then
      echo "fabro-sandbox-env-reconcile: PUT $endpoint failed (HTTP $put_status): declared=$ref persisted=$persisted" >&2
      exit 1
    fi

    echo "fabro-sandbox-env-reconcile: default environment updated to $ref"
  '';
}
