# Runs one selected Fly app deployment synchronously: create private runtime
# registry credentials, publish the app's derivation-backed images, then apply
# app settings and full Machine configurations with the resolved images. The
# publisher and reconciler receive the same selected specification, and either
# failure propagates its nonzero status instead of reporting success.
{
  pkgs,
  publisher,
  reconciler,
}:
let
  python = pkgs.python3;

  redactor = pkgs.writeText "fly-app-deploy-redact.py" ''
    import base64
    import os
    from pathlib import Path
    import sys

    token = os.environ["FLY_API_TOKEN"].encode("utf-8")
    secrets = (
        token,
        base64.b64encode(token),
        base64.b64encode(b"x:" + token),
    )
    for name, destination in ((sys.argv[1], sys.stdout.buffer), (sys.argv[2], sys.stderr.buffer)):
        path = Path(name)
        output = path.read_bytes() if path.exists() else b""
        for secret in secrets:
            if secret:
                output = output.replace(secret, b"[REDACTED]")
        destination.write(output)
  '';

  validator = pkgs.writeText "fly-app-deploy-validate.py" ''
    import json
    import sys

    def load(path, label):
        try:
            with open(path, encoding="utf-8") as handle:
                document = json.load(handle)
        except (OSError, ValueError) as error:
            print(
                "fly-app-deploy: could not read the {}: {}".format(label, error),
                file=sys.stderr,
            )
            raise SystemExit(1)
        if not isinstance(document, dict):
            print(
                "fly-app-deploy: the {} must be a JSON object".format(label),
                file=sys.stderr,
            )
            raise SystemExit(1)
        return document

    spec = load(sys.argv[1], "app specification")
    payload = load(sys.argv[2], "resolved image payload")
    name = spec.get("name")
    if not isinstance(name, str) or not name:
        print(
            "fly-app-deploy: the app specification must declare a Fly app name",
            file=sys.stderr,
        )
        raise SystemExit(1)
    if payload.get("app") != name:
        print(
            "fly-app-deploy: the resolved image payload targets app '{}' but the "
            "selected specification is app '{}'".format(payload.get("app"), name),
            file=sys.stderr,
        )
        raise SystemExit(1)
  '';
in
pkgs.writeShellApplication {
  name = "fly-app-deploy";
  runtimeInputs = [
    pkgs.coreutils
    python
  ];
  text = ''
    set -euo pipefail
    set +x

    if [ "$#" -ne 2 ] || [ "$1" != "--spec" ] || [ -z "$2" ]; then
      echo "fly-app-deploy: usage: fly-app-deploy --spec <secret-free-spec>" >&2
      exit 2
    fi
    spec_path="$2"
    if [ ! -r "$spec_path" ]; then
      echo "fly-app-deploy: spec is not readable" >&2
      exit 1
    fi

    if [ -z "''${FLY_API_TOKEN:-}" ]; then
      echo "fly-app-deploy: FLY_API_TOKEN is required" >&2
      exit 1
    fi
    if [[ "$FLY_API_TOKEN" == *$'\n'* || "$FLY_API_TOKEN" == *$'\r'* ]]; then
      echo "fly-app-deploy: FLY_API_TOKEN must not contain line breaks" >&2
      exit 1
    fi

    umask 077
    runtime_dir=$(mktemp -d "''${TMPDIR:-/tmp}/fly-app-deploy.XXXXXX")
    trap 'rm -rf -- "$runtime_dir"' EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM

    export HOME="$runtime_dir/home"
    export DOCKER_CONFIG="$runtime_dir/docker"
    mkdir -m 700 "$HOME" "$DOCKER_CONFIG"

    if ! printf '%s' "$FLY_API_TOKEN" | ${python}/bin/python3 -c '
    import base64
    import json
    import os
    import sys

    token = sys.stdin.buffer.read()
    config = {
        "auths": {
            "registry.fly.io": {
                "auth": base64.b64encode(b"x:" + token).decode("ascii")
            }
        }
    }
    path = os.path.join(os.environ["DOCKER_CONFIG"], "config.json")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as credentials:
        json.dump(config, credentials)
    '; then
      echo "fly-app-deploy: could not create private registry credentials" >&2
      exit 1
    fi

    export FLY_API_TOKEN

    publish_stdout="$runtime_dir/publish.stdout"
    publish_stderr="$runtime_dir/publish.stderr"
    reconcile_stdout="$runtime_dir/reconcile.stdout"
    reconcile_stderr="$runtime_dir/reconcile.stderr"

    publisher_status=0
    if ${publisher}/bin/fly-app-publish --spec "$spec_path" >"$publish_stdout" 2>"$publish_stderr"; then
      publisher_status=0
    else
      publisher_status=$?
    fi

    if [ "$publisher_status" -ne 0 ]; then
      ${python}/bin/python3 ${redactor} "$publish_stdout" "$publish_stderr"
      exit "$publisher_status"
    fi

    if [ ! -s "$publish_stdout" ]; then
      ${python}/bin/python3 ${redactor} "$publish_stdout" "$publish_stderr"
      echo "fly-app-deploy: publisher produced no resolved image payload" >&2
      exit 1
    fi

    if ! ${python}/bin/python3 ${validator} "$spec_path" "$publish_stdout"; then
      ${python}/bin/python3 ${redactor} "$publish_stdout" "$publish_stderr"
      exit 1
    fi

    ${python}/bin/python3 ${redactor} "$publish_stdout" "$publish_stderr"

    reconciler_status=0
    if ${reconciler}/bin/fly-app-reconcile --spec "$spec_path" --images "$publish_stdout" >"$reconcile_stdout" 2>"$reconcile_stderr"; then
      reconciler_status=0
    else
      reconciler_status=$?
    fi

    ${python}/bin/python3 ${redactor} "$reconcile_stdout" "$reconcile_stderr"
    exit "$reconciler_status"
  '';
}
