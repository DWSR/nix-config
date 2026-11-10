{
  pkgs,
  publisher,
}:
pkgs.writeShellApplication {
  name = "fly-app-deploy";
  runtimeInputs = [
    pkgs.coreutils
    pkgs.python3
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
    runtime_dir=$(mktemp -d)
    trap 'rm -rf -- "$runtime_dir"' EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM

    export HOME="$runtime_dir/home"
    export DOCKER_CONFIG="$runtime_dir/docker"
    mkdir -m 700 "$HOME" "$DOCKER_CONFIG"

    if ! printf '%s' "$FLY_API_TOKEN" | ${pkgs.python3}/bin/python3 -c '
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
    publisher_status=0
    if ${publisher}/bin/fly-app-publish --spec "$spec_path" >"$runtime_dir/stdout" 2>"$runtime_dir/stderr"; then
      publisher_status=0
    else
      publisher_status=$?
    fi

    ${pkgs.python3}/bin/python3 - "$runtime_dir/stdout" "$runtime_dir/stderr" <<'PY'
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
        output = Path(name).read_bytes()
        for secret in secrets:
            if secret:
                output = output.replace(secret, b"[REDACTED]")
        destination.write(output)
    PY

    exit "$publisher_status"
  '';
}
