# Applies a Fly app's declared settings through the Fly CLI without a remote
# build. The reconciler consumes the secret-free specification emitted by
# modules/fly-app.nix and the resolved image payload emitted by
# scripts/fly-app-publish.nix.
#
# The selected primary image is the image of every Machine's declared
# `deployContainer`, or the only image when no deployContainer is declared.
# Conflicting explicit deploy containers or multiple implicit images fail
# rather than deploying an arbitrary one.
#
# `flyctl deploy` always receives `--ha=false`, so a first deployment creates
# only the declared process groups instead of automatic spare Machines. Later
# deployments also receive `--update-only`, which keeps the existing
# process-group counts and leaves creation of missing declared Machines to the
# direct API reconciliation that follows this CLI stage.
{
  pkgs,
  flyctl ? pkgs.flyctl,
}:
let
  inherit (pkgs) lib;

  python = pkgs.python3;

  program = pkgs.writeText "fly-app-reconcile.py" ''
    #!/usr/bin/env python3
    """Render secret-free fly.toml and deploy the selected app image with flyctl."""

    import base64
    import json
    import math
    import os
    import re
    import shutil
    import subprocess
    import sys
    import tempfile

    APP_NAME = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
    BARE_KEY = re.compile(r"^[A-Za-z0-9_-]+$")
    USAGE = (
        "usage: fly-app-reconcile --spec <secret-free-spec> "
        "--images <resolved-images>"
    )


    class ReconcileError(Exception):
        """A deployment failure that must be reported without leaking secrets."""


    class DeployRejected(ReconcileError):
        """flyctl rejected the deployment and its exit status should propagate."""

        def __init__(self, message, status):
            super().__init__(message)
            self.status = status


    def fail(message):
        raise ReconcileError(message)


    def redact(text, token):
        if not token:
            return text
        encoded = token.encode("utf-8")
        for secret in (
            token,
            base64.b64encode(encoded).decode("ascii"),
            base64.b64encode(b"x:" + encoded).decode("ascii"),
        ):
            if secret:
                text = text.replace(secret, "[REDACTED]")
        return text


    def load_json(path, label):
        if not path or not os.path.isfile(path):
            fail("the {} is not readable: {}".format(label, path))
        try:
            with open(path, encoding="utf-8") as handle:
                document = json.load(handle)
        except (OSError, ValueError) as error:
            fail("could not read the {}: {}".format(label, error))
        if not isinstance(document, dict):
            fail("the {} must be a JSON object".format(label))
        return document


    def load_spec(path):
        spec = load_json(path, "app specification")
        name = spec.get("name")
        if not isinstance(name, str) or APP_NAME.match(name) is None:
            fail("the app specification must declare a valid Fly app name")
        settings = spec.get("settings", {})
        if not isinstance(settings, dict):
            fail("the app specification settings must be a JSON object")
        machines = spec.get("machines", {})
        if not isinstance(machines, dict):
            fail("the app specification machines must be a JSON object")
        return name, settings, machines


    def load_images(path):
        payload = load_json(path, "resolved image payload")
        app = payload.get("app")
        if not isinstance(app, str) or not app:
            fail("the resolved image payload must declare the target app")
        machines = payload.get("machines")
        if not isinstance(machines, dict):
            fail("the resolved image payload machines must be a JSON object")
        return app, machines


    def toml_string(value):
        output = ['"']
        for character in value:
            if character == "\\":
                output.append("\\\\")
            elif character == '"':
                output.append('\\"')
            elif character == "\b":
                output.append("\\b")
            elif character == "\t":
                output.append("\\t")
            elif character == "\n":
                output.append("\\n")
            elif character == "\f":
                output.append("\\f")
            elif character == "\r":
                output.append("\\r")
            elif ord(character) < 0x20 or ord(character) == 0x7F:
                output.append("\\u{:04X}".format(ord(character)))
            else:
                output.append(character)
        output.append('"')
        return "".join(output)


    def toml_key(key):
        if not isinstance(key, str) or not key:
            fail("app setting keys must be non-empty strings")
        return key if BARE_KEY.match(key) is not None else toml_string(key)


    def toml_value(value, where):
        if value is None:
            fail("app setting '{}' is null; TOML has no null value".format(where))
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, int):
            if not -(2**63) <= value < 2**63:
                fail("app setting '{}' is outside the TOML integer range".format(where))
            return str(value)
        if isinstance(value, float):
            if not math.isfinite(value):
                fail("app setting '{}' is not a finite TOML number".format(where))
            rendered = repr(value)
            if "." not in rendered and "e" not in rendered.lower():
                rendered += ".0"
            return rendered
        if isinstance(value, str):
            return toml_string(value)
        if isinstance(value, list):
            if any(isinstance(item, dict) for item in value):
                fail(
                    "app setting '{}' mixes table elements with plain array "
                    "values".format(where)
                )
            return "[" + ", ".join(
                toml_value(item, "{}[]".format(where)) for item in value
            ) + "]"
        if isinstance(value, dict):
            fail(
                "app setting '{}' must be rendered as a TOML table, not a "
                "scalar".format(where)
            )
        fail("app setting '{}' has no TOML representation".format(where))


    def section_header(lines, header):
        if lines and lines[-1] != "":
            lines.append("")
        lines.append(header)


    def partition_table(table, path):
        if not isinstance(table, dict):
            fail("app setting '{}' must be a JSON object".format(".".join(path)))
        scalars = []
        children = []
        for key in sorted(table):
            value = table[key]
            child_path = path + [key]
            where = ".".join(child_path)
            if isinstance(value, dict):
                children.append((key, value, False))
            elif isinstance(value, list) and value and all(
                isinstance(item, dict) for item in value
            ):
                children.append((key, value, True))
            elif isinstance(value, list) and any(
                isinstance(item, dict) for item in value
            ):
                fail(
                    "app setting '{}' mixes table elements with plain array "
                    "values".format(where)
                )
            else:
                scalars.append((key, value))
        return scalars, children


    def render_scalars(lines, path, scalars):
        for key, value in scalars:
            lines.append(
                "{} = {}".format(
                    toml_key(key),
                    toml_value(value, ".".join(path + [key])),
                )
            )


    def render_children(lines, path, children):
        for key, value, is_array in children:
            child_path = path + [key]
            if is_array:
                header = "[[" + ".".join(
                    toml_key(part) for part in child_path
                ) + "]]"
                for item in value:
                    if not isinstance(item, dict):
                        fail(
                            "app setting '{}' must contain TOML tables".format(
                                ".".join(child_path)
                            )
                        )
                    section_header(lines, header)
                    render_table_body(lines, child_path, item)
            else:
                render_table(lines, child_path, value)


    def render_table(lines, path, table):
        scalars, children = partition_table(table, path)
        if path:
            header = "[" + ".".join(toml_key(part) for part in path) + "]"
            section_header(lines, header)
        render_scalars(lines, path, scalars)
        render_children(lines, path, children)


    def render_table_body(lines, path, table):
        """Render a table array element after its [[header]] line."""
        scalars, children = partition_table(table, path)
        render_scalars(lines, path, scalars)
        render_children(lines, path, children)


    def render_fly_toml(name, settings):
        lines = ["app = " + toml_string(name)]
        render_table(lines, [], settings)
        while lines and lines[-1] == "":
            lines.pop()
        return "\n".join(lines) + "\n"


    def validate_declared_source(entry, source, where):
        if not isinstance(source, dict):
            fail("{} must declare exactly one image source".format(where))
        existing = source.get("existingImage")
        derivation = source.get("derivation")
        if (existing is None) == (derivation is None):
            fail(
                "{} must declare exactly one of existingImage or derivation".format(
                    where
                )
            )
        if existing is not None:
            if (
                entry.get("kind") != "existingImage"
                or entry.get("source") != existing
                or entry.get("reference") != existing
            ):
                fail(
                    "resolved image data for {} does not match the declared "
                    "image source".format(where)
                )
        elif (
            entry.get("kind") != "derivation"
            or entry.get("source") != derivation
        ):
            fail(
                "resolved image data for {} does not match the declared image "
                "source".format(where)
            )


    def resolved_reference(entry, where, source):
        if not isinstance(entry, dict):
            fail("resolved image data for {} is missing".format(where))
        reference = entry.get("reference")
        if (
            not isinstance(reference, str)
            or not reference
            or any(character.isspace() for character in reference)
        ):
            fail("resolved image data for {} has no valid registry reference".format(where))
        validate_declared_source(entry, source, where)
        return reference


    def select_primary_image(name, machines, resolved_machines):
        explicit = []
        implicit = []
        for machine_name in sorted(machines):
            machine = machines[machine_name]
            if not isinstance(machine, dict):
                fail("Machine '{}' must be a JSON object".format(machine_name))
            resolved = resolved_machines.get(machine_name)
            if not isinstance(resolved, dict):
                fail(
                    "resolved image data for Machine '{}' is missing; publish "
                    "the selected app specification before reconciling".format(
                        machine_name
                    )
                )
            containers = machine.get("containers", {})
            if not isinstance(containers, dict):
                fail("Machine '{}' containers must be a JSON object".format(machine_name))
            deploy_container = machine.get("deployContainer")
            if deploy_container is not None:
                if (
                    not isinstance(deploy_container, str)
                    or deploy_container not in containers
                ):
                    fail(
                        "Machine '{}' selects an unknown deployContainer".format(
                            machine_name
                        )
                    )
                container = containers[deploy_container]
                if not isinstance(container, dict):
                    fail(
                        "container '{}' of Machine '{}' must be a JSON "
                        "object".format(deploy_container, machine_name)
                    )
                resolved_containers = resolved.get("containers", {})
                entry = (
                    resolved_containers.get(deploy_container)
                    if isinstance(resolved_containers, dict)
                    else None
                )
                explicit.append(
                    (
                        machine_name,
                        deploy_container,
                        resolved_reference(
                            entry,
                            "container '{}' of Machine '{}'".format(
                                deploy_container, machine_name
                            ),
                            container.get("image"),
                        ),
                    )
                )
            elif containers:
                if len(containers) != 1:
                    fail(
                        "Machine '{}' has multiple containers and must "
                        "declare deployContainer".format(machine_name)
                    )
                container_name = next(iter(containers))
                container = containers[container_name]
                if not isinstance(container, dict):
                    fail(
                        "container '{}' of Machine '{}' must be a JSON "
                        "object".format(container_name, machine_name)
                    )
                resolved_containers = resolved.get("containers", {})
                entry = (
                    resolved_containers.get(container_name)
                    if isinstance(resolved_containers, dict)
                    else None
                )
                implicit.append(
                    (
                        machine_name,
                        container_name,
                        resolved_reference(
                            entry,
                            "container '{}' of Machine '{}'".format(
                                container_name, machine_name
                            ),
                            container.get("image"),
                        ),
                    )
                )
            elif "image" in machine:
                implicit.append(
                    (
                        machine_name,
                        None,
                        resolved_reference(
                            resolved.get("image"),
                            "Machine '{}'".format(machine_name),
                            machine.get("image"),
                        ),
                    )
                )
            else:
                fail(
                    "Machine '{}' has no image-bearing declaration".format(
                        machine_name
                    )
                )

        candidates = explicit or implicit
        if not candidates:
            fail("no declared Machine provides a deploy image for app '{}'".format(name))
        references = sorted({candidate[2] for candidate in candidates})
        if len(references) != 1:
            details = ", ".join(
                "{}={}".format(candidate[0], candidate[2])
                for candidate in candidates
            )
            fail(
                "cannot select a single primary deploy image for app '{}'; "
                "{}".format(name, details)
            )
        return references[0]


    def list_machines(flyctl, app, environment, token):
        result = subprocess.run(
            [flyctl, "machine", "list", "--app", app, "--json"],
            env=environment,
            capture_output=True,
            text=True,
        )
        diagnostics = (result.stdout + result.stderr).strip()
        if result.returncode != 0:
            message = "could not list Fly Machines for app '{}'".format(app)
            if diagnostics:
                message += ": " + diagnostics
            fail(message)
        try:
            payload = json.loads(result.stdout)
        except ValueError:
            fail("Fly returned an invalid Machine list for app '{}'".format(app))
        machines = payload.get("machines") if isinstance(payload, dict) else payload
        if not isinstance(machines, list):
            fail("Fly returned an invalid Machine list for app '{}'".format(app))
        return len(machines) > 0


    def deploy(flyctl, app, config_path, reference, first_deploy, environment, token):
        command = [
            flyctl,
            "deploy",
            "--app",
            app,
            "--config",
            config_path,
            "--image",
            reference,
            "--now",
            "--ha=false",
            "--yes",
        ]
        if not first_deploy:
            command.append("--update-only")
        result = subprocess.run(
            command,
            env=environment,
            capture_output=True,
            text=True,
        )
        diagnostics = (result.stdout + result.stderr).strip()
        if diagnostics:
            print(redact(diagnostics, token), file=sys.stderr)
        if result.returncode != 0:
            raise DeployRejected(
                "Fly rejected deployment for app '{}' (flyctl exit status {})".format(
                    app, result.returncode
                ),
                result.returncode,
            )


    def write_config(runtime_dir, rendered):
        path = os.path.join(runtime_dir, "fly.toml")
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        return path


    def main(argv):
        token = os.environ.get("FLY_API_TOKEN", "")
        if not token:
            print("fly-app-reconcile: FLY_API_TOKEN is required", file=sys.stderr)
            return 1
        if "\n" in token or "\r" in token:
            print(
                "fly-app-reconcile: FLY_API_TOKEN must not contain line breaks",
                file=sys.stderr,
            )
            return 1
        if (
            len(argv) != 4
            or argv[0] != "--spec"
            or argv[2] != "--images"
            or not argv[1]
            or not argv[3]
        ):
            print("fly-app-reconcile: " + USAGE, file=sys.stderr)
            return 2

        runtime_dir = None
        try:
            name, settings, machines = load_spec(argv[1])
            payload_app, resolved_machines = load_images(argv[3])
            if payload_app != name:
                fail(
                    "the resolved image payload targets a different app '{}' "
                    "than the specification '{}'".format(payload_app, name)
                )
            if "app" in settings:
                fail(
                    "app setting 'app' must not override the declared Fly app "
                    "identity"
                )
            if "build" in settings:
                fail(
                    "app setting 'build' is not supported; image sources are "
                    "declared on Machines"
                )
            reference = select_primary_image(name, machines, resolved_machines)
            rendered = render_fly_toml(name, settings)
            flyctl = os.environ.get("FLY_RECONCILE_FLYCTL", "")
            if not flyctl or not os.path.isfile(flyctl):
                fail("the pinned Fly CLI is unavailable")

            environment = os.environ.copy()
            runtime_dir = tempfile.mkdtemp(prefix="fly-app-reconcile.")
            os.chmod(runtime_dir, 0o700)
            config_path = write_config(runtime_dir, rendered)
            first_deploy = not list_machines(flyctl, name, environment, token)
            deploy(
                flyctl,
                name,
                config_path,
                reference,
                first_deploy,
                environment,
                token,
            )
            print(
                "fly-app-reconcile: deployed app '{}' with image '{}'".format(
                    name, reference
                ),
                file=sys.stderr,
            )
            return 0
        except DeployRejected as error:
            print(
                "fly-app-reconcile: " + redact(str(error), token),
                file=sys.stderr,
            )
            return error.status
        except ReconcileError as error:
            print(
                "fly-app-reconcile: " + redact(str(error), token),
                file=sys.stderr,
            )
            return 1
        except OSError as error:
            print(
                "fly-app-reconcile: "
                + redact("runtime failure: {}".format(error), token),
                file=sys.stderr,
            )
            return 1
        finally:
            if runtime_dir is not None:
                shutil.rmtree(runtime_dir, ignore_errors=True)


    raise SystemExit(main(sys.argv[1:]))
  '';
in
pkgs.writeShellApplication {
  name = "fly-app-reconcile";
  runtimeInputs = [
    pkgs.coreutils
    python
  ];
  text = ''
    if [ "$#" -ne 4 ] || [ "$1" != "--spec" ] || [ -z "$2" ] || [ "$3" != "--images" ] || [ -z "$4" ]; then
      echo "fly-app-reconcile: usage: fly-app-reconcile --spec <secret-free-spec> --images <resolved-images>" >&2
      exit 2
    fi

    exec env \
      FLY_RECONCILE_FLYCTL=${lib.escapeShellArg "${flyctl}/bin/flyctl"} \
      ${python}/bin/python3 ${program} "$@"
  '';
}
