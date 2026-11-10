{ pkgs, publisherProgram }:
let
  runtime = pkgs.writeText "fly-app-deploy-runtime.py" ''
    import base64
    import json
    import os
    from pathlib import Path
    import shutil
    import subprocess
    import sys
    import tempfile
    import urllib.parse

    REDACTED = "[REDACTED]"

    def fail(message):
        print("fly-app-deploy: " + message, file=sys.stderr)
        return 1

    def redacted(data, token):
        if not data:
            return data
        secret_forms = {
            token.encode(),
            base64.b64encode(token.encode()),
            base64.b64encode(("x:" + token).encode()),
            json.dumps(token)[1:-1].encode(),
            urllib.parse.quote(token, safe="").encode(),
        }
        for secret in sorted(secret_forms, key=len, reverse=True):
            if secret:
                data = data.replace(secret, REDACTED.encode())
        return data

    def cleanup_runtime(runtime_root, config_path):
        cleanup_error = None
        if config_path is not None:
            try:
                config_path.unlink(missing_ok=True)
            except OSError as error:
                cleanup_error = error
        try:
            shutil.rmtree(runtime_root)
        except OSError as error:
            cleanup_error = error
        if cleanup_error is not None:
            raise cleanup_error

    def main():
        token = os.environ.get("FLY_API_TOKEN", "")
        if not token.strip():
            return fail("FLY_API_TOKEN is required")
        if len(sys.argv) < 2 or sys.argv[1] != "--spec" or len(sys.argv) != 3:
            return fail("expected --spec <secret-free-spec-path>")

        runtime_root = None
        config_path = None
        try:
            runtime_root = tempfile.mkdtemp(prefix="fly-app-deploy-")
            os.chmod(runtime_root, 0o700)
            root = Path(runtime_root)
            home = root / "home"
            docker_config = root / "docker"
            home.mkdir(mode=0o700)
            docker_config.mkdir(mode=0o700)

            credential = base64.b64encode(("x:" + token).encode()).decode("ascii")
            config = {"auths": {"registry.fly.io": {"auth": credential}}}
            config_path = docker_config / "config.json"
            descriptor = os.open(
                config_path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(config, stream, separators=(",", ":"))
                stream.write("\n")

            env = os.environ.copy()
            env.update({
                "HOME": str(home),
                "DOCKER_CONFIG": str(docker_config),
                "XDG_CONFIG_HOME": str(home / ".config"),
                "FLY_API_TOKEN": token,
                "NO_COLOR": "1",
            })
            try:
                result = subprocess.run(
                    ["${publisherProgram}/bin/fly-app-publish", *sys.argv[1:]],
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=False,
                )
            except OSError:
                return fail("could not start the image publisher")

            sys.stdout.buffer.write(redacted(result.stdout, token))
            sys.stderr.buffer.write(redacted(result.stderr, token))
            return result.returncode
        except (OSError, ValueError):
            return fail("could not prepare private runtime credentials")
        finally:
            if runtime_root is not None:
                try:
                    cleanup_runtime(runtime_root, config_path)
                except OSError:
                    print(
                        "fly-app-deploy: could not remove private runtime credentials",
                        file=sys.stderr,
                    )
                    raise SystemExit(1)

    if __name__ == "__main__":
        raise SystemExit(main())
  '';
in
pkgs.writeShellScriptBin "fly-app-deploy" ''
  exec ${pkgs.python3}/bin/python3 ${runtime} "$@"
''
