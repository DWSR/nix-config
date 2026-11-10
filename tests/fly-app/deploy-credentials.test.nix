{ pkgs }:
let
  publisher = pkgs.writeShellScriptBin "fly-app-publish" ''
    exec ${pkgs.python3}/bin/python3 - "$@" <<'PY'
    import base64
    import hashlib
    import json
    import os
    import pathlib
    import stat
    import sys
    import traceback

    def report_test_error(error_type, error, _traceback):
        pathlib.Path(os.environ["PUBLISHER_RECORD"] + ".error").write_text(
            "".join(traceback.format_exception_only(error_type, error)),
            encoding="utf-8",
        )

    sys.excepthook = report_test_error
    docker_config = pathlib.Path(os.environ["DOCKER_CONFIG"])
    if not docker_config.name.startswith("fly-app-docker-"):
        raise SystemExit("Docker credentials are not in a private temporary directory")
    if docker_config.stat().st_uid != os.getuid():
        raise SystemExit("Docker credential directory has an unexpected owner")
    config_path = docker_config / "config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    auth = config["auths"]["registry.fly.io"]["auth"]
    decoded = base64.b64decode(auth, validate=True)
    if not decoded.startswith(b"x:"):
        raise SystemExit("registry auth did not use the Fly Docker username")
    if hashlib.sha256(auth.encode()).hexdigest() != os.environ["EXPECTED_AUTH_SHA256"]:
        raise SystemExit("registry auth did not match the runtime token")
    if stat.S_IMODE(docker_config.stat().st_mode) != 0o700:
        raise SystemExit("Docker credential directory is not private")
    if stat.S_IMODE(config_path.stat().st_mode) != 0o600:
        raise SystemExit("Docker credential file is not private")
    if "FLY_API_TOKEN" in os.environ or "DOCKER_AUTH_CONFIG" in os.environ:
        raise SystemExit("publisher inherited raw registry authentication environment")
    if pathlib.Path.home() != docker_config:
        raise SystemExit("publisher HOME is not isolated from persistent auth state")
    if pathlib.Path(os.environ["DOCKER_CONFIG_JSON"]) != config_path:
        raise SystemExit("publisher did not receive the temporary Docker config path")
    for variable in ("XDG_CONFIG_HOME", "XDG_CACHE_HOME"):
        if pathlib.Path(os.environ[variable]) != docker_config:
            raise SystemExit(f"publisher {variable} is not temporary")
    if os.environ["XDG_STATE_HOME"] != "/fixture/persistent-state":
        raise SystemExit("publisher non-secret state was redirected into temporary storage")
    if sys.argv[1:] != ["--spec", os.environ["EXPECTED_SPEC"]]:
        raise SystemExit("publisher received unexpected command arguments")

    pathlib.Path(os.environ["PUBLISHER_RECORD"]).write_text(
        str(docker_config) + "\n" + hashlib.sha256(auth.encode()).hexdigest(),
        encoding="utf-8",
    )
    token = decoded[2:].decode("utf-8")
    print("publisher stdout token=" + token)
    print("publisher stderr auth=" + auth, file=sys.stderr)
    sys.exit(int(os.environ.get("PUBLISHER_EXIT", "0")))
    PY
  '';
  deployProgram = import ../../scripts/fly-app-deploy.nix {
    inherit pkgs;
    publisherProgram = publisher;
  };
in
pkgs.runCommand "fly-app-deploy-credentials-test"
  {
    nativeBuildInputs = [ pkgs.python3 ];
  }
  ''
    python3 - ${deployProgram}/bin/fly-app-deploy <<'PY'
    import base64
    import hashlib
    import json
    import os
    import pathlib
    import subprocess
    import sys
    import tempfile

    deploy = sys.argv[1]
    token = "fly-fixture-" + os.urandom(24).hex()
    auth = base64.b64encode(b"x:" + token.encode()).decode()
    env_base = os.environ.copy()
    env_base.update({
        "FLY_API_TOKEN": token,
        "DOCKER_AUTH_CONFIG": "must-not-pass-through",
        "XDG_CONFIG_HOME": "/fixture/persistent-config",
        "XDG_CACHE_HOME": "/fixture/persistent-cache",
        "XDG_STATE_HOME": "/fixture/persistent-state",
        "XDG_DATA_HOME": "/fixture/persistent-data",
        "EXPECTED_AUTH_SHA256": hashlib.sha256(auth.encode()).hexdigest(),
        "EXPECTED_SPEC": "/fixture/app-spec.json",
    })

    def run(extra_env):
        with tempfile.TemporaryDirectory(prefix="fly-app-credentials-test-") as directory:
            env = env_base.copy()
            env.update(extra_env)
            env["PUBLISHER_RECORD"] = os.path.join(directory, "publisher-record")
            result = subprocess.run(
                [deploy, "--spec", env["EXPECTED_SPEC"]],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            record_path = pathlib.Path(env["PUBLISHER_RECORD"])
            record = record_path.read_text(encoding="utf-8").splitlines() if record_path.exists() else []
            error_path = pathlib.Path(env["PUBLISHER_RECORD"] + ".error")
            error = error_path.read_text(encoding="utf-8") if error_path.exists() else ""
            return result, record, error

    for missing in (None, ""):
        env = env_base.copy()
        env.pop("FLY_API_TOKEN", None)
        if missing is not None:
            env["FLY_API_TOKEN"] = missing
        with tempfile.TemporaryDirectory(prefix="fly-app-credentials-missing-") as directory:
            env["PUBLISHER_RECORD"] = os.path.join(directory, "publisher-record")
            result = subprocess.run(
                [deploy, "--spec", "/fixture/app-spec.json"],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            if result.returncode == 0 or "FLY_API_TOKEN is required" not in result.stderr:
                raise SystemExit("missing/empty FLY_API_TOKEN was not rejected clearly")
            if pathlib.Path(env["PUBLISHER_RECORD"]).exists():
                raise SystemExit("publisher ran without a runtime token")

    env = env_base.copy()
    env["FLY_API_TOKEN"] = token + "\nnot-a-valid-token"
    with tempfile.TemporaryDirectory(prefix="fly-app-credentials-newline-") as directory:
        env["PUBLISHER_RECORD"] = os.path.join(directory, "publisher-record")
        result = subprocess.run(
            [deploy, "--spec", "/fixture/app-spec.json"],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode == 0 or "must not contain line breaks" not in result.stderr:
            raise SystemExit("line-broken token was not rejected")
        if pathlib.Path(env["PUBLISHER_RECORD"]).exists():
            raise SystemExit("publisher ran with a malformed token")

    for exit_status in ("0", "23"):
        result, record, publisher_error = run({"PUBLISHER_EXIT": exit_status})
        if result.returncode != int(exit_status):
            raise SystemExit(
                f"publisher exit {exit_status} was not propagated: {result.returncode}; "
                f"stdout={result.stdout!r} stderr={result.stderr!r} publisher_error={publisher_error!r}"
            )
        if token in result.stdout or token in result.stderr or auth in result.stdout or auth in result.stderr:
            raise SystemExit("publisher diagnostics exposed runtime credentials")
        publisher_auth = base64.b64encode(b"x:" + token.encode()).decode()
        if publisher_auth in result.stdout or publisher_auth in result.stderr:
            raise SystemExit("publisher diagnostics exposed encoded registry credentials")
        if len(record) != 2 or record[1] != hashlib.sha256(auth.encode()).hexdigest():
            raise SystemExit("publisher did not receive the expected temporary Docker auth")
        if pathlib.Path(record[0]).exists():
            raise SystemExit("temporary Docker credentials survived publisher completion")

    result, record, publisher_error = run({"PUBLISHER_EXIT": "127"})
    if result.returncode == 0:
        raise SystemExit("publisher exit status 127 was reported as success")
    if token in result.stdout or token in result.stderr or auth in result.stdout or auth in result.stderr:
        raise SystemExit("publisher failure diagnostics exposed runtime credentials")
    if len(record) != 2 or pathlib.Path(record[0]).exists():
        raise SystemExit("temporary Docker credentials were not cleaned after publisher failure")

    deployed_artifact = pathlib.Path(deploy).read_bytes()
    if token.encode() in deployed_artifact:
        raise SystemExit("runtime token appeared in the deploy program")
    if auth.encode() in deployed_artifact:
        raise SystemExit("derived registry auth appeared in the deploy program")
    print("runtime Fly credentials are private, temporary, redacted, and failure-safe")
    PY
    touch "$out"
  ''
