{
  pkgs,
  publisher,
  registryUrl ? "https://registry.fly.io",
  registryHost ? "registry.fly.io",
}:
pkgs.writeShellApplication {
  name = "fly-app-publish";
  runtimeInputs = [ pkgs.python3 ];
  text = ''
    set -euo pipefail
    set +x

    if [ "$#" -ne 2 ] || [ "$1" != "--spec" ] || [ -z "$2" ]; then
      echo "fly-app-publish: usage: fly-app-publish --spec <secret-free-spec>" >&2
      exit 2
    fi
    spec_path="$2"
    if [ ! -r "$spec_path" ]; then
      echo "fly-app-publish: spec is not readable" >&2
      exit 1
    fi
    if [ -z "''${FLY_API_TOKEN:-}" ]; then
      echo "fly-app-publish: FLY_API_TOKEN is required" >&2
      exit 1
    fi

    export FLY_APP_PUBLISH_SPEC="$spec_path"
    export FLY_APP_PUBLISHER=${pkgs.lib.escapeShellArg "${publisher}/bin/nix2container"}
    export FLY_APP_REGISTRY_URL=${pkgs.lib.escapeShellArg registryUrl}
    export FLY_APP_REGISTRY_HOST=${pkgs.lib.escapeShellArg registryHost}
    exec ${pkgs.python3}/bin/python3 - <<'PY'
    import base64
    import hashlib
    import http.client
    import json
    import os
    from pathlib import Path
    import re
    import subprocess
    import sys
    from urllib.error import HTTPError, URLError
    from urllib.parse import quote, urlsplit
    from urllib.request import Request, urlopen

    PUBLISHER = os.environ["FLY_APP_PUBLISHER"]
    REGISTRY_URL = os.environ["FLY_APP_REGISTRY_URL"].rstrip("/")
    REGISTRY_HOST = os.environ["FLY_APP_REGISTRY_HOST"]
    TOKEN = os.environ["FLY_API_TOKEN"]
    STORE_HASH = re.compile(r"^[0-9abcdfghijklmnpqrsvwxyz]{32}$")
    APP_NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")
    DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
    MANIFEST_TYPES = {
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    }
    ACCEPT = ", ".join((
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ))

    class PublishError(Exception):
        pass

    def fail(message, status=1):
        print("fly-app-publish: " + message, file=sys.stderr)
        raise SystemExit(status)

    def inspect_manifest(app, tag):
        endpoint = urlsplit(REGISTRY_URL)
        if endpoint.scheme not in ("http", "https") or not endpoint.netloc or endpoint.query or endpoint.fragment:
            raise PublishError("registry endpoint is invalid")
        url = REGISTRY_URL + "/v2/" + quote(app, safe="") + "/manifests/" + quote(tag, safe="")
        auth = base64.b64encode(("x:" + TOKEN).encode("utf-8")).decode("ascii")
        request = Request(url, headers={"Accept": ACCEPT, "Authorization": "Basic " + auth})
        try:
            with urlopen(request, timeout=30) as response:
                body = response.read(4 * 1024 * 1024 + 1)
                if len(body) > 4 * 1024 * 1024:
                    raise PublishError("registry returned an oversized manifest")
                header_digest = response.headers.get("Docker-Content-Digest", "")
        except HTTPError as error:
            if error.code == 404:
                return None
            if error.code in (401, 403):
                raise PublishError("registry inspection failed: authentication rejected") from None
            raise PublishError("registry inspection failed: HTTP status " + str(error.code)) from None
        except (URLError, TimeoutError, OSError, ValueError, http.client.HTTPException):
            raise PublishError("registry inspection failed: network or protocol error") from None

        content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip()
        if content_type not in MANIFEST_TYPES:
            raise PublishError("registry returned an unsupported manifest media type")
        actual_digest = "sha256:" + hashlib.sha256(body).hexdigest()
        if not DIGEST.fullmatch(header_digest) or header_digest != actual_digest:
            raise PublishError("registry manifest digest mismatch")
        return actual_digest

    def image_reference(app, image_path):
        path = Path(image_path)
        if not path.is_absolute() or not path.is_file():
            raise PublishError("derivation image archive is unavailable")
        store_hash = path.name.split("-", 1)[0]
        if not STORE_HASH.fullmatch(store_hash):
            raise PublishError("derivation image archive has no valid Nix store identity")
        tag = store_hash
        ref = REGISTRY_HOST + "/" + app + ":" + tag
        digest = inspect_manifest(app, tag)
        if digest is None:
            result = subprocess.run(
                [PUBLISHER, "push", "--ref", ref, str(path)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                env=os.environ.copy(),
            )
            if result.returncode != 0:
                raise PublishError("pinned publisher failed (status " + str(result.returncode) + ")")
            digest = inspect_manifest(app, tag)
            if digest is None:
                raise PublishError("image is not available after publication")
        return REGISTRY_HOST + "/" + app + "@" + digest

    def resolve_source(app, source):
        if not isinstance(source, dict):
            raise PublishError("image source is malformed")
        existing = source.get("existingImage")
        derivation = source.get("derivation")
        if (existing is None) == (derivation is None):
            raise PublishError("image source must select exactly one existing image or derivation")
        if existing is not None:
            if not isinstance(existing, str) or not existing:
                raise PublishError("existing image reference is invalid")
            return existing
        if not isinstance(derivation, str) or not derivation:
            raise PublishError("derivation image path is invalid")
        return image_reference(app, derivation)

    try:
        with open(os.environ["FLY_APP_PUBLISH_SPEC"], encoding="utf-8") as spec_file:
            spec = json.load(spec_file)
        app = spec.get("name")
        machines = spec.get("machines")
        if not isinstance(app, str) or not app or "/" in app or not isinstance(machines, dict):
            raise PublishError("app specification is malformed")
        resolved = {"machines": {}, "containers": {}}
        for machine_name, machine in machines.items():
            if not isinstance(machine, dict):
                raise PublishError("Machine declaration is malformed")
            if "image" in machine:
                resolved["machines"][machine_name] = resolve_source(app, machine["image"])
            containers = machine.get("containers", {})
            if not isinstance(containers, dict):
                raise PublishError("container declarations are malformed")
            for container_name, container in containers.items():
                if not isinstance(container, dict) or "image" not in container:
                    raise PublishError("container image source is missing")
                resolved["containers"].setdefault(machine_name, {})[container_name] = resolve_source(
                    app, container["image"]
                )
        print(json.dumps({"app": app, "images": resolved}, separators=(",", ":"), sort_keys=True))
    except PublishError as error:
        fail(str(error))
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError, AttributeError):
        fail("could not read a valid app specification")
    PY
  '';
}
