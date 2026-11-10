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
#
# After every CLI deploy the reconciler enumerates the app's Machines and maps
# each stable declaration key to a Fly Machine ID. A Machine is module-managed
# when it carries the module identity marker (`fly_app_module_key` metadata,
# written for Machines created through the Machines API) or a Fly Launch
# process group (`fly_process_group` metadata). Machines with neither marker
# are unrelated and are reported but excluded from the managed set. Ambiguous
# matches and surplus managed Machines fail without deleting anything.
#
# The reconciler then creates missing declared Machines and fully updates every
# declared Machine through the Fly Machines API, preserving Fly Launch
# ownership metadata and writing the module identity marker. Finally it
# re-reads the managed set through the API and verifies that every declared
# Machine carries its full declared configuration, image, and identity, and
# that the managed count matches the declaration. It never deletes Machines.
#
# Fly can update an existing Machine in place for its image, guest,
# environment, and service settings and most other config fields, but it
# cannot attach, detach, or swap the volumes mounted on an existing Machine
# (only a mount path may change).
# Before any Machine is mutated the reconciler compares the declared and
# existing mounted volume sets and rejects an in-place change with a named
# replacement-required error, naming the Machine and the conflicting volumes.
# It does not delete or recreate the Machine to work around that constraint.
#
# After the CLI stage the reconciler re-enumerates Machines through the
# Machines API, not only through the CLI listing, before creating anything. If
# an earlier run failed after the API accepted a create or update but before
# the run observed the result, a retry maps the stable declaration identity to
# the Machine that already exists and updates it instead of creating a
# duplicate. A failed create or update reports the affected app and Machine,
# states that the deployment is incomplete, and does not claim a rollback.
# The Machines API defaults to https://api.machines.dev; `FLY_MACHINES_API`
# overrides that base URL for tests and compatible endpoints.
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
    import copy
    import http.client
    import json
    import math
    import os
    import re
    import shutil
    import subprocess
    import sys
    import tempfile
    import urllib.error
    import urllib.parse
    import urllib.request

    APP_NAME = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
    BARE_KEY = re.compile(r"^[A-Za-z0-9_-]+$")
    MODULE_IDENTITY_KEY = "fly_app_module_key"
    LAUNCH_IDENTITY_KEY = "fly_process_group"
    MACHINES_API_ENV = "FLY_MACHINES_API"
    MACHINES_API_DEFAULT = "https://api.machines.dev"
    MACHINES_API_TIMEOUT_SECONDS = 30
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


    class ReplacementRequired(ReconcileError):
        """A declared Machine change needs a replacement, not an in-place update."""


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


    def machine_record(entry, app):
        if not isinstance(entry, dict):
            fail("Fly returned an invalid Machine entry for app '{}'".format(app))
        machine_id = entry.get("id")
        if not isinstance(machine_id, str) or not machine_id.strip():
            fail("Fly returned a Machine without a stable ID for app '{}'".format(app))
        config = entry.get("config")
        if not isinstance(config, dict):
            fail(
                "Fly returned a Machine without a configuration for app '{}': "
                "{}".format(app, machine_id)
            )
        region = entry.get("region")
        if not isinstance(region, str) or not region:
            region = None
        return machine_id, config, region


    def machine_identity(machine_id, config, app):
        """Return the stable declaration identity of a module-managed Machine."""
        metadata = config.get("metadata")
        if metadata is None:
            return None
        if not isinstance(metadata, dict):
            fail(
                "Fly returned a Machine with invalid identity metadata for app "
                "'{}': {}".format(app, machine_id)
            )
        for key in (MODULE_IDENTITY_KEY, LAUNCH_IDENTITY_KEY):
            if key not in metadata:
                continue
            value = metadata[key]
            if not isinstance(value, str) or not value.strip():
                fail(
                    "Fly returned a Machine with invalid identity metadata '{}' "
                    "for app '{}': {}".format(key, app, machine_id)
                )
            return value
        return None


    def has_managed_identity(app, machines):
        return any(
            machine_identity(machine_id, config, app) is not None
            for machine_id, config, _region in machines
        )


    def match_machines(app, declared, machines):
        """Map declaration keys to Fly Machine IDs and reject bad managed sets."""
        candidates = {}
        unmanaged = []
        surplus = []
        for machine_id, config, _region in machines:
            identity = machine_identity(machine_id, config, app)
            if identity is None:
                unmanaged.append(machine_id)
                continue
            if identity not in declared:
                surplus.append((machine_id, identity))
                continue
            candidates.setdefault(identity, []).append(machine_id)

        ambiguous = {
            identity: sorted(ids)
            for identity, ids in candidates.items()
            if len(ids) > 1
        }
        if ambiguous or surplus:
            problems = []
            for identity in sorted(ambiguous):
                problems.append(
                    "ambiguous matches for declared Machine '{}': {} (surplus "
                    "duplicates are never deleted)".format(
                        identity, ", ".join(ambiguous[identity])
                    )
                )
            for machine_id, identity in sorted(surplus):
                problems.append(
                    "surplus module-managed Machine '{}' with identity '{}' "
                    "(this reconciler never deletes Machines)".format(
                        machine_id, identity
                    )
                )
            fail(
                "cannot reconcile the Machine set for app '{}': {}".format(
                    app, "; ".join(problems)
                )
            )

        matches = {identity: ids[0] for identity, ids in candidates.items()}
        missing = sorted(set(declared) - set(matches))
        return matches, missing, sorted(unmanaged)


    def report_machine_set(app, matches, missing, unmanaged, token):
        mapping = " ".join(
            "{}={}".format(identity, matches[identity]) for identity in sorted(matches)
        )
        lines = [
            "fly-app-reconcile: matched Machines for app '{}': {}".format(
                app, mapping or "none"
            )
        ]
        if missing:
            lines.append(
                "fly-app-reconcile: missing declared Machines for app '{}': {}; "
                "creating them through the Machines API".format(
                    app, " ".join(missing)
                )
            )
        if unmanaged:
            lines.append(
                "fly-app-reconcile: ignoring unmanaged Machines for app '{}': "
                "{}".format(app, " ".join(unmanaged))
            )
        for line in lines:
            print(redact(line, token), file=sys.stderr)


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
        return [machine_record(entry, app) for entry in machines]


    def machines_api_base():
        base = os.environ.get(MACHINES_API_ENV, MACHINES_API_DEFAULT).rstrip("/")
        if not base:
            fail("the Fly Machines API base URL must not be empty")
        return base


    def machines_api(app, suffix, token, method="GET", payload=None):
        url = "{}/v1/apps/{}/machines{}".format(
            machines_api_base(),
            urllib.parse.quote(app, safe=""),
            suffix,
        )
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "Authorization": "Bearer " + token,
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
        action = "read"
        if method == "POST":
            action = "create" if suffix == "" else "update"
        try:
            with urllib.request.urlopen(
                request, timeout=MACHINES_API_TIMEOUT_SECONDS
            ) as response:
                status = response.status
                body = response.read()
        except urllib.error.HTTPError as error:
            detail = ""
            try:
                detail = error.read().decode("utf-8", "replace").strip()
            except (OSError, http.client.HTTPException):
                pass
            if error.code in (401, 403):
                fail(
                    "Fly Machines API authentication failed for app '{}'; "
                    "check FLY_API_TOKEN".format(app)
                )
            message = (
                "Fly Machines API {} request for app '{}' failed with HTTP "
                "{}".format(action, app, error.code)
            )
            if detail:
                message += ": " + detail
            fail(redact(message, token))
        except (
            urllib.error.URLError,
            http.client.HTTPException,
            TimeoutError,
            OSError,
        ) as error:
            reason = getattr(error, "reason", error)
            fail(
                "could not reach the Fly Machines API for app '{}': {}".format(
                    app, reason
                )
            )
        if status < 200 or status >= 300:
            fail(
                "Fly Machines API {} request for app '{}' returned HTTP "
                "{}".format(action, app, status)
            )
        if not body:
            return None
        try:
            return json.loads(body)
        except ValueError:
            fail("Fly Machines API returned invalid JSON for app '{}'".format(app))


    def list_api_machines(app, token):
        payload = machines_api(app, "", token)
        machines = payload.get("machines") if isinstance(payload, dict) else payload
        if not isinstance(machines, list):
            fail(
                "Fly Machines API returned an invalid Machine list for app "
                "'{}'".format(app)
            )
        return [machine_record(entry, app) for entry in machines]


    def create_machine(app, machine_name, config, region, token):
        payload = {"config": config}
        if region:
            payload["region"] = region
        try:
            result = machines_api(app, "", token, method="POST", payload=payload)
        except ReconcileError as error:
            raise ReconcileError(
                "Machine '{}' for app '{}' could not be created: {}; the "
                "deployment is incomplete and no rollback was attempted".format(
                    machine_name, app, error
                )
            ) from error
        machine_id = result.get("id") if isinstance(result, dict) else None
        if not isinstance(machine_id, str) or not machine_id.strip():
            fail(
                "the Fly Machines API did not return an ID for created "
                "Machine '{}' of app '{}'".format(machine_name, app)
            )
        print(
            redact(
                "fly-app-reconcile: created Machine '{}' for app '{}' as "
                "{}".format(machine_name, app, machine_id),
                token,
            ),
            file=sys.stderr,
        )
        return machine_id


    def update_machine(app, machine_name, machine_id, config, token):
        try:
            machines_api(
                app,
                "/" + urllib.parse.quote(machine_id, safe=""),
                token,
                method="POST",
                payload={"config": config},
            )
        except ReconcileError as error:
            raise ReconcileError(
                "Machine '{}' for app '{}' could not be updated: {}; the "
                "deployment is incomplete and no rollback was attempted; "
                "retry to reconcile the same Machines".format(
                    machine_name, app, error
                )
            ) from error
        print(
            redact(
                "fly-app-reconcile: updated Machine '{}' for app '{}' "
                "({})".format(machine_name, app, machine_id),
                token,
            ),
            file=sys.stderr,
        )


    def desired_machine_config(machine_name, machine, resolved, existing_config):
        """Build the full Machines API config for one declared Machine."""
        if not isinstance(machine, dict):
            fail("Machine '{}' must be a JSON object".format(machine_name))
        if not isinstance(resolved, dict):
            fail(
                "resolved image data for Machine '{}' is missing".format(
                    machine_name
                )
            )
        declared = machine.get("config", {})
        if not isinstance(declared, dict):
            fail("Machine '{}' config must be a JSON object".format(machine_name))
        config = copy.deepcopy(declared)

        containers = machine.get("containers", {})
        if not isinstance(containers, dict):
            fail(
                "Machine '{}' containers must be a JSON object".format(machine_name)
            )
        resolved_containers = resolved.get("containers", {})
        if not isinstance(resolved_containers, dict):
            fail(
                "resolved container image data for Machine '{}' is invalid".format(
                    machine_name
                )
            )
        if containers:
            config.pop("image", None)
            rendered = []
            for container_name in sorted(containers):
                container = containers[container_name]
                if not isinstance(container, dict):
                    fail(
                        "container '{}' of Machine '{}' must be a JSON "
                        "object".format(container_name, machine_name)
                    )
                container_config = container.get("config", {})
                if not isinstance(container_config, dict):
                    fail(
                        "container '{}' of Machine '{}' config must be a JSON "
                        "object".format(container_name, machine_name)
                    )
                entry = copy.deepcopy(container_config)
                entry["name"] = container_name
                entry["image"] = resolved_reference(
                    resolved_containers.get(container_name),
                    "container '{}' of Machine '{}'".format(
                        container_name, machine_name
                    ),
                    container.get("image"),
                )
                rendered.append(entry)
            config["containers"] = rendered
        else:
            config.pop("containers", None)
            config["image"] = resolved_reference(
                resolved.get("image"),
                "Machine '{}'".format(machine_name),
                machine.get("image"),
            )

        existing_metadata = {}
        if existing_config is not None:
            candidate = existing_config.get("metadata")
            if candidate is not None:
                if not isinstance(candidate, dict):
                    fail(
                        "Fly returned invalid metadata for declared Machine "
                        "'{}'".format(machine_name)
                    )
                existing_metadata = candidate
        declared_metadata = config.get("metadata", {})
        if declared_metadata is None:
            declared_metadata = {}
        if not isinstance(declared_metadata, dict):
            fail(
                "Machine '{}' metadata must be a JSON object".format(machine_name)
            )
        metadata = copy.deepcopy(declared_metadata)
        for key, value in existing_metadata.items():
            if key.startswith("fly_") and key != MODULE_IDENTITY_KEY:
                metadata[key] = value
        metadata[MODULE_IDENTITY_KEY] = machine_name
        config["metadata"] = metadata
        return config


    def mounted_volumes(config, where):
        """Return the sorted volume identities attached to a Machine config."""
        mounts = config.get("mounts")
        if mounts is None:
            return []
        if not isinstance(mounts, list):
            fail("{} has an invalid mounts property".format(where))
        volumes = []
        for entry in mounts:
            if not isinstance(entry, dict):
                fail("{} has an invalid mount entry".format(where))
            volume = entry.get("volume") or entry.get("name")
            if not isinstance(volume, str) or not volume:
                fail(
                    "{} has a mount entry without a volume identity".format(where)
                )
            volumes.append(volume)
        if len(set(volumes)) != len(volumes):
            fail("{} mounts the same volume more than once".format(where))
        return sorted(volumes)


    def check_replacement(app, machine_name, desired, existing):
        """Reject an in-place change that Fly only permits by replacement."""
        if existing is None:
            return
        desired_volumes = mounted_volumes(
            desired, "the declared Machine '{}'".format(machine_name)
        )
        existing_volumes = mounted_volumes(
            existing, "Fly Machine '{}'".format(machine_name)
        )
        if desired_volumes == existing_volumes:
            return
        raise ReplacementRequired(
            "Machine '{}' for app '{}' requires replacement: the immutable "
            "'mounts' volume set cannot be attached, detached, or swapped on "
            "an existing Machine (declared volumes: {}; existing volumes: "
            "{}). This reconciler never deletes or recreates Machines; "
            "declare a new logical Machine key or remove the Machine "
            "manually.".format(
                machine_name,
                app,
                ", ".join(desired_volumes) or "none",
                ", ".join(existing_volumes) or "none",
            )
        )


    def container_configs(config, where):
        containers = config.get("containers")
        if not isinstance(containers, list):
            fail("{} has no container list".format(where))
        result = {}
        for entry in containers:
            if not isinstance(entry, dict):
                fail("{} contains an invalid container".format(where))
            name = entry.get("name")
            if not isinstance(name, str) or not name:
                fail("{} contains a container without a name".format(where))
            if name in result:
                fail(
                    "{} contains duplicate container name '{}'".format(where, name)
                )
            result[name] = entry
        return result


    def compare_config(expected, actual, path, problems):
        if not isinstance(actual, dict):
            problems.append("{} is not an object".format(".".join(path)))
            return
        for key in sorted(expected):
            where = path + [key]
            label = ".".join(where)
            if key not in actual:
                problems.append("missing " + label)
                continue
            wanted = expected[key]
            found = actual[key]
            if key == "containers" and isinstance(wanted, list):
                if not isinstance(found, list):
                    problems.append(label + " is not a container list")
                    continue
                wanted_containers = container_configs({"containers": wanted}, label)
                found_containers = container_configs({"containers": found}, label)
                if sorted(wanted_containers) != sorted(found_containers):
                    problems.append(
                        "{} has containers {} but the declaration requires "
                        "{}".format(
                            label,
                            sorted(found_containers),
                            sorted(wanted_containers),
                        )
                    )
                for name in sorted(wanted_containers):
                    if name in found_containers:
                        compare_config(
                            wanted_containers[name],
                            found_containers[name],
                            where + [name],
                            problems,
                        )
            elif isinstance(wanted, dict):
                compare_config(wanted, found, where, problems)
            elif wanted != found:
                problems.append(
                    "{} is {!r} but the declaration requires {!r}".format(
                        label, found, wanted
                    )
                )


    def verify_machines(app, declared, desired, token):
        final_machines = list_api_machines(app, token)
        matches, missing, _unmanaged = match_machines(app, declared, final_machines)
        if missing:
            fail(
                "the Machines API reconciliation did not create declared "
                "Machines for app '{}': {}".format(app, " ".join(missing))
            )
        if len(matches) != len(declared):
            fail(
                "Fly reports {} module-managed Machines for app '{}' but the "
                "declaration requires {}".format(len(matches), app, len(declared))
            )
        configs = {
            machine_id: config for machine_id, config, _region in final_machines
        }
        problems = []
        for machine_name in sorted(declared):
            compare_config(
                desired[machine_name],
                configs[matches[machine_name]],
                [machine_name],
                problems,
            )
        if problems:
            fail(
                "the Machines API reconciliation for app '{}' did not retain "
                "the declared configuration: {}".format(app, "; ".join(problems))
            )
        return matches


    def report_reconciled(app, matches, token):
        mapping = " ".join(
            "{}={}".format(identity, matches[identity]) for identity in sorted(matches)
        )
        print(
            redact(
                "fly-app-reconcile: verified {} module-managed Machines for "
                "app '{}': {}".format(len(matches), app, mapping or "none"),
                token,
            ),
            file=sys.stderr,
        )


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
            existing_machines = list_machines(flyctl, name, environment, token)
            first_deploy = not has_managed_identity(name, existing_machines)
            deploy(
                flyctl,
                name,
                config_path,
                reference,
                first_deploy,
                environment,
                token,
            )
            # Keep the CLI listing as a post-deploy health check, then
            # re-enumerate through the Machines API before deciding what is
            # missing. The API listing is authoritative for stable identities:
            # it also sees a Machine whose create response was lost to an
            # earlier run, which a retry must update instead of duplicating.
            list_machines(flyctl, name, environment, token)
            api_machines = list_api_machines(name, token)
            matches, missing, unmanaged = match_machines(
                name, machines, api_machines
            )
            report_machine_set(name, matches, missing, unmanaged, token)
            existing_configs = {
                machine_id: config
                for machine_id, config, _region in api_machines
            }
            desired = {}
            for machine_name in sorted(machines):
                desired[machine_name] = desired_machine_config(
                    machine_name,
                    machines[machine_name],
                    resolved_machines.get(machine_name, {}),
                    existing_configs.get(matches.get(machine_name)),
                )
            # Validate every replacement-only change before mutating anything,
            # so a rejected deployment leaves the managed set untouched.
            for machine_name in sorted(machines):
                if machine_name in matches:
                    check_replacement(
                        name,
                        machine_name,
                        desired[machine_name],
                        existing_configs[matches[machine_name]],
                    )
            region = next(
                (
                    machine_region
                    for _machine_id, _config, machine_region in api_machines
                    if machine_region
                ),
                None,
            )
            for machine_name in sorted(machines):
                if machine_name in matches:
                    update_machine(
                        name,
                        machine_name,
                        matches[machine_name],
                        desired[machine_name],
                        token,
                    )
                else:
                    create_machine(
                        name,
                        machine_name,
                        desired[machine_name],
                        region,
                        token,
                    )
            verified = verify_machines(name, machines, desired, token)
            report_reconciled(name, verified, token)
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
        except ReplacementRequired as error:
            print(
                "fly-app-reconcile: replacement-required: "
                + redact(str(error), token),
                file=sys.stderr,
            )
            return 1
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
