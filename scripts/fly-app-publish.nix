# Publishes derivation-backed Fly images through the pinned nix-snapshotter
# push interface and confirms their manifest digests in the Fly registry.
# A spec's `derivation` image source is the OCI archive produced by
# lib/fly-app-image.nix (`image`/`archive`), and `nixSnapshotter` is the
# package whose `nix2container` the flake overlay pins.
{
  pkgs,
  nixSnapshotter ? pkgs.nix-snapshotter,
  registryHost ? "registry.fly.io",
  registryScheme ? "https",
}:
let
  inherit (pkgs) lib;

  python = pkgs.python3;

  program = pkgs.writeText "fly-app-publish.py" ''
    #!/usr/bin/env python3
    """Publish derivation-backed Fly images and inspect the Fly registry."""

    import base64
    import hashlib
    import http.client
    import json
    import os
    import re
    import shutil
    import subprocess
    import sys
    import tempfile
    import urllib.error
    import urllib.parse
    import urllib.request

    ACCEPT = ", ".join(
        [
            "application/vnd.oci.image.index.v1+json",
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
            "application/vnd.docker.distribution.manifest.v2+json",
        ]
    )
    APP_NAME = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
    STORE_PATH = re.compile(r"^/nix/store/([0-9abcdfghijklmnpqrsvwxyz]{32})-[^/]+$")
    DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
    TIMEOUT_SECONDS = 30
    USAGE = "usage: fly-app-publish --spec <secret-free-spec>"


    class PublishError(Exception):
        """A publication or inspection failure that must fail the deployment."""


    def fail(message):
        raise PublishError(message)


    def redact(text, token):
        encoded = token.encode("utf-8")
        for secret in (
            token,
            base64.b64encode(encoded).decode("ascii"),
            base64.b64encode(b"x:" + encoded).decode("ascii"),
        ):
            if secret:
                text = text.replace(secret, "[REDACTED]")
        return text


    def registry_url(app, reference):
        return "{}://{}/v2/{}/manifests/{}".format(
            os.environ["FLY_REGISTRY_SCHEME"],
            os.environ["FLY_REGISTRY_HOST"],
            urllib.parse.quote(app, safe=""),
            urllib.parse.quote(reference, safe=":"),
        )


    def inspect_manifest(app, reference, token):
        """Return the confirmed manifest digest, None when absent, or fail hard.

        Only an explicit HTTP 404 counts as absence. Authentication, transport,
        and server failures are raised so they can never masquerade as absence.
        """
        encoded = base64.b64encode(b"x:" + token.encode("utf-8")).decode("ascii")
        request = urllib.request.Request(
            registry_url(app, reference),
            headers={"Authorization": "Basic " + encoded, "Accept": ACCEPT},
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                status = response.status
                body = response.read()
                header_digest = response.headers.get("Docker-Content-Digest")
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            if error.code in (401, 403):
                fail(
                    "Fly registry authentication failed while inspecting '{}'; "
                    "check FLY_API_TOKEN".format(reference)
                )
            fail(
                "Fly registry inspection of '{}' failed with HTTP {}; "
                "the image is not known to be absent".format(reference, error.code)
            )
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError) as error:
            reason = getattr(error, "reason", error)
            fail(
                "could not reach the Fly registry while inspecting '{}': {}".format(
                    reference, reason
                )
            )
        if status != 200:
            fail(
                "Fly registry inspection of '{}' returned HTTP {}; "
                "the image is not known to be absent".format(reference, status)
            )
        computed = "sha256:" + hashlib.sha256(body).hexdigest()
        if header_digest is not None:
            if DIGEST.match(header_digest) is None:
                fail(
                    "Fly registry returned a malformed Docker-Content-Digest "
                    "for '{}'".format(reference)
                )
            if header_digest != computed:
                fail(
                    "Fly registry digest header for '{}' does not match the "
                    "manifest content".format(reference)
                )
        return computed


    def create_docker_config(token, runtime_dir):
        """Create private Docker-compatible credentials for the pinned publisher."""
        config_dir = os.path.join(runtime_dir, "docker")
        os.makedirs(config_dir, mode=0o700)
        os.chmod(config_dir, 0o700)
        config_path = os.path.join(config_dir, "config.json")
        auth = base64.b64encode(b"x:" + token.encode("utf-8")).decode("ascii")
        descriptor = os.open(
            config_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as credentials:
            json.dump(
                {"auths": {os.environ["FLY_REGISTRY_HOST"]: {"auth": auth}}},
                credentials,
            )
        return config_dir


    def publish_image(archive, reference, environment, token):
        publisher = os.environ["FLY_NIX2CONTAINER"]
        if not os.path.isfile(publisher):
            fail("the pinned nix-snapshotter publisher is unavailable")
        if not os.path.isfile(archive):
            fail(
                "image derivation '{}' is not realized as an OCI archive; "
                "build the app specification before deploying".format(archive)
            )
        result = subprocess.run(
            [publisher, "push", "--ref", reference, archive],
            env=environment,
            capture_output=True,
            text=True,
        )
        diagnostics = (result.stdout + result.stderr).strip()
        if result.returncode != 0:
            message = "image publication failed for '{}'".format(reference)
            if diagnostics:
                message += ": " + diagnostics
            fail(message)
        if diagnostics:
            print(redact(diagnostics, token), file=sys.stderr)


    def load_spec(path):
        if not path or not os.path.isfile(path):
            fail("the app specification is not readable: {}".format(path))
        try:
            with open(path, encoding="utf-8") as handle:
                spec = json.load(handle)
        except (OSError, ValueError) as error:
            fail("could not read the app specification: {}".format(error))
        if not isinstance(spec, dict):
            fail("the app specification must be a JSON object")
        name = spec.get("name")
        if not isinstance(name, str) or APP_NAME.match(name) is None:
            fail("the app specification must declare a valid Fly app name")
        machines = spec.get("machines", {})
        if not isinstance(machines, dict):
            fail("the app specification machines must be a JSON object")
        return name, machines


    def image_source(holder, where):
        source = holder.get("image")
        if not isinstance(source, dict):
            fail("{} must declare exactly one image source".format(where))
        existing = source.get("existingImage")
        derivation = source.get("derivation")
        if (existing is None) == (derivation is None):
            fail(
                "{} must declare exactly one of existingImage or "
                "derivation".format(where)
            )
        if existing is not None:
            if (
                not isinstance(existing, str)
                or not existing
                or any(character.isspace() for character in existing)
            ):
                fail("{} has an invalid existing image reference".format(where))
            return {"kind": "existingImage", "source": existing}
        if not isinstance(derivation, str):
            fail("{} has an invalid derivation image source".format(where))
        match = STORE_PATH.match(derivation)
        if match is None:
            fail(
                "{} must use a realized /nix/store image derivation, "
                "got '{}'".format(where, derivation)
            )
        return {"kind": "derivation", "source": derivation, "tag": "nix-" + match.group(1)}


    def collect_images(machines):
        entries = []
        machine_images = {}
        for machine_name in sorted(machines):
            machine = machines[machine_name]
            if not isinstance(machine, dict):
                fail("machine '{}' must be a JSON object".format(machine_name))
            containers = machine.get("containers", {})
            if not isinstance(containers, dict):
                fail(
                    "machine '{}' containers must be a JSON object".format(
                        machine_name
                    )
                )
            if "image" in machine and containers:
                fail(
                    "machine '{}' cannot mix Machine and container image "
                    "declarations".format(machine_name)
                )
            output = {}
            if "image" in machine:
                entry = image_source(machine, "machine '{}'".format(machine_name))
                output["image"] = entry
                entries.append(entry)
            output["containers"] = {}
            for container_name in sorted(containers):
                container = containers[container_name]
                if not isinstance(container, dict):
                    fail(
                        "container '{}' of machine '{}' must be a JSON "
                        "object".format(container_name, machine_name)
                    )
                entry = image_source(
                    container,
                    "container '{}' of machine '{}'".format(
                        container_name, machine_name
                    ),
                )
                output["containers"][container_name] = entry
                entries.append(entry)
            if "image" not in output and not output["containers"]:
                fail("machine '{}' must declare at least one image".format(machine_name))
            deploy_container = machine.get("deployContainer")
            if deploy_container is not None:
                if (
                    not isinstance(deploy_container, str)
                    or deploy_container not in output["containers"]
                ):
                    fail(
                        "machine '{}' selects an unknown deployContainer".format(
                            machine_name
                        )
                    )
                output["deployContainer"] = deploy_container
            machine_images[machine_name] = output
        return entries, machine_images


    def resolve_images(app, entries, token, environment):
        unique = {}
        for entry in entries:
            unique.setdefault((entry["kind"], entry["source"]), entry)
        images = []
        for key in sorted(unique):
            entry = unique[key]
            if entry["kind"] == "existingImage":
                images.append(
                    {
                        "kind": "existingImage",
                        "source": entry["source"],
                        "reference": entry["source"],
                        "digest": None,
                        "published": False,
                    }
                )
                continue
            reference = "{}/{}:{}".format(
                os.environ["FLY_REGISTRY_HOST"], app, entry["tag"]
            )
            digest = inspect_manifest(app, entry["tag"], token)
            published = False
            if digest is None:
                print("fly-app-publish: publishing " + reference, file=sys.stderr)
                publish_image(entry["source"], reference, environment, token)
                digest = inspect_manifest(app, entry["tag"], token)
                if digest is None:
                    fail(
                        "publication of '{}' was not confirmed by the Fly "
                        "registry".format(reference)
                    )
                published = True
            else:
                print(
                    "fly-app-publish: image "
                    + reference
                    + " is already available; not republishing",
                    file=sys.stderr,
                )
            images.append(
                {
                    "kind": "derivation",
                    "source": entry["source"],
                    "reference": reference,
                    "digest": digest,
                    "published": published,
                }
            )
        return images


    def resolve_machines(machine_images, images):
        lookup = {(image["kind"], image["source"]): image for image in images}
        resolved = {}
        for machine_name in sorted(machine_images):
            machine = machine_images[machine_name]
            output = {"containers": {}}
            if "image" in machine:
                output["image"] = lookup[
                    (machine["image"]["kind"], machine["image"]["source"])
                ]
            for container_name in sorted(machine["containers"]):
                entry = machine["containers"][container_name]
                output["containers"][container_name] = lookup[
                    (entry["kind"], entry["source"])
                ]
            if "deployContainer" in machine:
                output["deployImage"] = output["containers"][machine["deployContainer"]]
            resolved[machine_name] = output
        return resolved


    def main(argv):
        token = os.environ.get("FLY_API_TOKEN", "")
        if not token:
            print("fly-app-publish: FLY_API_TOKEN is required", file=sys.stderr)
            return 1
        if "\n" in token or "\r" in token:
            print(
                "fly-app-publish: FLY_API_TOKEN must not contain line breaks",
                file=sys.stderr,
            )
            return 1
        if len(argv) != 2 or argv[0] != "--spec" or not argv[1]:
            print("fly-app-publish: " + USAGE, file=sys.stderr)
            return 2

        runtime_dir = None
        try:
            app, machines = load_spec(argv[1])
            entries, machine_images = collect_images(machines)
            environment = os.environ.copy()
            environment.pop("FLY_API_TOKEN", None)
            if not environment.get("DOCKER_CONFIG"):
                runtime_dir = tempfile.mkdtemp(prefix="fly-app-publish.")
                os.chmod(runtime_dir, 0o700)
                environment["DOCKER_CONFIG"] = create_docker_config(
                    token, runtime_dir
                )
            images = resolve_images(app, entries, token, environment)
            payload = {
                "app": app,
                "registry": os.environ["FLY_REGISTRY_HOST"],
                "images": images,
                "machines": resolve_machines(machine_images, images),
            }
            json.dump(payload, sys.stdout, indent=2, sort_keys=True)
            sys.stdout.write("\n")
            return 0
        except PublishError as error:
            print("fly-app-publish: " + redact(str(error), token), file=sys.stderr)
            return 1
        finally:
            if runtime_dir is not None:
                shutil.rmtree(runtime_dir, ignore_errors=True)


    raise SystemExit(main(sys.argv[1:]))
  '';
in
pkgs.writeShellApplication {
  name = "fly-app-publish";
  runtimeInputs = [
    pkgs.coreutils
    python
  ];
  text = ''
    if [ "$#" -ne 2 ] || [ "$1" != "--spec" ] || [ -z "$2" ]; then
      echo "fly-app-publish: usage: fly-app-publish --spec <secret-free-spec>" >&2
      exit 2
    fi

    exec env \
      FLY_REGISTRY_SCHEME=${lib.escapeShellArg registryScheme} \
      FLY_REGISTRY_HOST=${lib.escapeShellArg registryHost} \
      FLY_NIX2CONTAINER=${lib.escapeShellArg "${nixSnapshotter}/bin/nix2container"} \
      ${python}/bin/python3 ${program} "$@"
  '';
}
