{ pkgs, name }:
# fabro-sandbox-env-reconcile: reconcile Fabro's persisted `default`
# environment to the sandbox image digest the loader recorded for this
# switch.
#
# The loader (scripts/fabro-sandbox-image-load.nix) writes the image manifest
# digest to /run/fabro-sandbox/digest. This script forms the immutable
# reference `<name>@<digest>` (`name` is baked in at build time) and makes
# Fabro's persisted `default` environment point at it through the environments
# API. `default` is seeded by install, so the record always exists: a 404 is
# reported, never repaired (Requirements 4.5, 4.6).
#
# Flow (design "Environment Reconciler", Requirements 4.1, 4.2, 4.4, 4.5, 4.6):
#   1. GET /api/v1/environments/default with the dev token.
#   2. 404 -> report `declared=<ref> persisted=<missing>` and fail.
#      Otherwise read `revision` and `.image.docker`.
#   3. If `.image.docker` already equals `<ref>`, exit 0 (idempotent).
#   4. Otherwise PUT with `If-Match: "<revision>"` and the persisted
#      environment minus `id`/`revision` with `image.docker` replaced; a
#      non-200 status reports both references and the HTTP status.
#
# The dev token (FABRO_DEV_TOKEN) is supplied by the unit's sops-rendered
# EnvironmentFile; no secret is embedded here. The API base is Fabro's
# loopback listener (configurations/fabro-vm/fabro.nix: `server.api.url`).
pkgs.writeShellApplication {
  name = "fabro-sandbox-env-reconcile";
  runtimeInputs = [
    pkgs.curl
    pkgs.jq
    pkgs.coreutils
  ];
  text = ''
    set -euo pipefail

    # Fabro's loopback `default` environment endpoint; the reconciler runs as
    # root in the guest.
    endpoint="http://127.0.0.1:32276/api/v1/environments/default"

    # The declared reference: the digest the loader recorded this switch.
    ref="${name}@$(cat /run/fabro-sandbox/digest)"

    # The dev token comes from the sops-rendered EnvironmentFile; refuse to
    # run without it rather than issuing an unauthenticated request.
    : "''${FABRO_DEV_TOKEN:?FABRO_DEV_TOKEN is required}"

    # GET the persisted `default` environment, capturing the status and body.
    body_file="$(mktemp)"
    trap 'rm -f "$body_file"' EXIT

    status="$(curl -sS -X GET \
      -H "Authorization: Bearer $FABRO_DEV_TOKEN" \
      -o "$body_file" \
      -w '%{http_code}' \
      "$endpoint")"
    body="$(cat "$body_file")"

    if [ "$status" = "404" ]; then
      echo "fabro-sandbox-env-reconcile: declared=$ref persisted=<missing> (GET $endpoint returned HTTP 404)" >&2
      exit 1
    fi

    if [ "$status" != "200" ]; then
      echo "fabro-sandbox-env-reconcile: declared=$ref persisted=<unknown> (GET $endpoint returned HTTP $status)" >&2
      exit 1
    fi

    persisted="$(printf '%s' "$body" | jq -r '.image.docker')"
    # The JSON-quoted revision for the If-Match precondition (the ETag value).
    revision="$(printf '%s' "$body" | jq -c '.revision')"

    # Idempotent: the persisted image already matches the declared reference.
    if [ "$persisted" = "$ref" ]; then
      echo "fabro-sandbox-env-reconcile: declared=$ref persisted=$persisted (unchanged)"
      exit 0
    fi

    # Update the persisted environment in place: preserve every field except
    # the server-owned `id`/`revision` and point `image.docker` at the declared
    # digest reference. `default` is seeded by install, so this updates the
    # existing record rather than creating a duplicate.
    put_body="$(printf '%s' "$body" | jq --arg ref "$ref" 'del(.id, .revision) | .image.docker = $ref')"

    put_status="$(curl -sS -X PUT \
      -H "Authorization: Bearer $FABRO_DEV_TOKEN" \
      -H 'Content-Type: application/json' \
      -H "If-Match: $revision" \
      --data "$put_body" \
      -o "$body_file" \
      -w '%{http_code}' \
      "$endpoint")"

    if [ "$put_status" != "200" ]; then
      echo "fabro-sandbox-env-reconcile: declared=$ref persisted=$persisted (PUT $endpoint returned HTTP $put_status)" >&2
      exit 1
    fi

    echo "fabro-sandbox-env-reconcile: declared=$ref persisted=$persisted (updated)"
  '';
}
