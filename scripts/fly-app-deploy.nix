{ pkgs, publisherProgram }:
pkgs.writeShellApplication {
  name = "fly-app-deploy";
  runtimeInputs = [ pkgs.python3 ];
  text = ''
    exec ${pkgs.python3}/bin/python3 - "$@" <<'PY'
    import base64
    import json
    import os
    import pathlib
    import shutil
    import subprocess
    import sys
    import tempfile

    def fail(message, status=1):
        print(f"fly-app-deploy: {message}", file=sys.stderr)
        raise SystemExit(status)

    if len(sys.argv) != 3 or sys.argv[1] != "--spec":
        fail("usage: fly-app-deploy --spec <secret-free-store-path>", 64)
    spec_path = sys.argv[2]

    token = os.environ.get("FLY_API_TOKEN", "")
    if not token or not token.strip():
        fail("FLY_API_TOKEN is required and must be non-empty")
    if "\n" in token or "\r" in token:
        fail("FLY_API_TOKEN must not contain line breaks")

    docker_config = None
    publisher_status = None
    setup_failed = False
    cleanup_failed = False
    try:
        docker_config = tempfile.mkdtemp(prefix="fly-app-docker-")
        os.chmod(docker_config, 0o700)
        config_path = pathlib.Path(docker_config) / "config.json"
        credential = base64.b64encode(("x:" + token).encode("utf-8")).decode("ascii")
        descriptor = os.open(config_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as config_file:
            json.dump({"auths": {"registry.fly.io": {"auth": credential}}}, config_file)
            config_file.write("\n")

        publisher_env = os.environ.copy()
        publisher_env.pop("FLY_API_TOKEN", None)
        publisher_env.pop("DOCKER_AUTH_CONFIG", None)
        publisher_env["XDG_STATE_HOME"] = os.environ.get(
            "XDG_STATE_HOME",
            os.path.join(os.path.expanduser("~"), ".local", "state"),
        )
        publisher_env["XDG_DATA_HOME"] = os.environ.get(
            "XDG_DATA_HOME",
            os.path.join(os.path.expanduser("~"), ".local", "share"),
        )
        publisher_env["XDG_CONFIG_HOME"] = docker_config
        publisher_env["XDG_CACHE_HOME"] = docker_config
        publisher_env["HOME"] = docker_config
        publisher_env["DOCKER_CONFIG"] = docker_config
        publisher_env["DOCKER_CONFIG_JSON"] = os.path.join(docker_config, "config.json")
        result = subprocess.run(
            ["${publisherProgram}/bin/fly-app-publish", "--spec", spec_path],
            env=publisher_env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        publisher_status = result.returncode
    except (OSError, UnicodeError):
        setup_failed = True
    finally:
        if docker_config is not None:
            try:
                shutil.rmtree(docker_config)
            except OSError:
                cleanup_failed = True

    if setup_failed or cleanup_failed:
        fail("could not prepare or clean up temporary registry credentials")
    if publisher_status:
        fail(
            "image publisher failed (exit status {}; output suppressed to protect credentials)".format(
                publisher_status
            ),
            publisher_status if 0 < publisher_status < 126 else 1,
        )
    PY
  '';
}
