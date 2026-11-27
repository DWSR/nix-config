"""Capture and compare the pre-migration flake-layout compatibility baseline.

The baseline is the contract every area-flake migration slice is compared
against (design "Integration and Migration Notes" 1, "Baseline first"):

* ``selectors``: root outputs per system (checks, apps, dev shells, packages,
  formatter, overlays, lib, host configurations).
* ``registry``: the personal host's legacy ``nix.registry`` names and
  ``/etc/nix/path`` aliases.
* ``host_wiring``: the personal host's representative package and SOPS runtime
  wiring (semantic names and paths, never derivation paths or secret values).
* ``pins``: representative external input identities from ``flake.lock``.
* ``ci``: the actual CI jobs, dispatch conditions/outputs/control-flow fingerprint,
  flake-check exclusions, and required commands.
* ``secrets``: structural encrypted-store and SOPS rule inventory.
* ``runner_blockers``: checks the CI flake-check lane cannot run; recorded
  separately from failures per requirement 4.4.

``capture`` evaluates the live flake (through ``observation.nix``) and merges
the repository facts. ``verify`` compares an observation against the recorded
baseline: a removed selector, registry alias, search-path target, host identity,
CI job, exclusion, required command, or secret store is a failure; an added one
is reported. Pin, host-package, and runner-label changes are reported as
changes for reviewer comparison rather than as failures. Checks that cannot
run in the current runner context are listed under ``blockers`` and never
counted as passes.

This module is dependency-free so it runs inside ``nix flake check`` with the
sandbox ``python3``.
"""

import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DEFAULT_BASELINE = HERE / "baseline.json"
OBSERVATION_NIX = HERE / "observation.nix"

SYSTEMS = ("aarch64-darwin", "x86_64-darwin", "aarch64-linux")
PER_SYSTEM_KINDS = ("checks", "apps", "devShells", "packages")
FLAT_KINDS = (
    "formatter",
    "overlays",
    "lib",
    "darwinConfigurations",
    "nixosConfigurations",
)
# Host-wiring values that encode an identity or runtime path (not a version).
IDENTITY_HOST_KEYS = (
    "personal_host",
    "darwin_hosts",
    "nixos_hosts",
    "personal_sops_age_key",
    "personal_sops_default_store",
    "fabro_sops_age_key",
    "fabro_sops_default_store",
    "personal_sops_secrets",
    "fabro_sops_secrets",
)
PIN_INPUTS = (
    "nixpkgs",
    "nixpkgs-unstable",
    "nixpkgs-image",
    "opencode",
    "nix-snapshotter",
    "agentmemory",
    "pi",
    "nixos-lima",
    "rsync34",
    "sops-nix",
    "darwin",
    "home-manager",
    "nixvim",
    "stylix",
    "treefmt-nix",
)
CI_REQUIRED_COMMANDS = (
    "nix develop --command prek run --all-files",
    "nix build --no-link --keep-going $attrs",
    "nix flake check --no-build --show-trace --keep-going",
    ".#checks.aarch64-darwin.lima-vm-config-validate",
)
# Why the CI flake-check lane does not build a selector. Keep in sync with the
# job's exclusion regex; ``diff_static`` fails if a recorded blocker leaves it.
BLOCKER_REASONS = {
    "opencode": ("ci-cold-build", "cold opencode build exceeds the flake-check lane budget"),
    "agentmemory-opencode": ("ci-cold-build", "AgentMemory/OpenCode matrix build is too cold for the lane"),
    "lima-vm-config-validate": ("ci-non-root-runner", "limactl refuses to run as root in the flake-check job"),
    "fabro-workflows-validate": ("ci-build-dir-race", "fabro validate races build-dir cleanup"),
    "formatting": ("ci-redundant-hook", "the prek job already runs the formatting hooks"),
    "pre-commit-check": ("ci-redundant-hook", "the prek job runs prek run --all-files"),
}
DISPATCH_VARIABLES = {
    "commit-count": "commit_count",
    "size": "size",
    "codeql": "codeql",
    "auto-merge": "auto_merge",
    "prek": "prek",
    "gitleaks": "gitleaks",
    "flake-check": "flake_check",
    "lima-config": "lima_config",
}
LOCK_IDENTITY_FIELDS = (
    "type",
    "owner",
    "repo",
    "rev",
    "narHash",
    "url",
    "path",
    "submodules",
)


def load_json(path):
    return json.loads(pathlib.Path(path).read_text())


def parse_ci(text):
    """Read job runners, lane conditions, and exclusions from ``ci.yml``."""
    jobs = {}
    job_conditions = {}
    current = None
    in_jobs = False
    for raw in text.splitlines():
        if re.match(r"^jobs:\s*$", raw):
            in_jobs = True
            continue
        if in_jobs and re.match(r"^\S", raw):
            in_jobs = False
            current = None
        if not in_jobs:
            continue
        job = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", raw)
        if job:
            current = job.group(1)
            jobs[current] = None
            continue
        if current is not None:
            runner = re.match(r"^    runs-on:\s*(\S.*?)\s*$", raw)
            if runner:
                jobs[current] = runner.group(1)
            condition = re.match(r"^    if:\s*(\S.*?)\s*$", raw)
            if condition:
                job_conditions[current] = condition.group(1)
    match = re.search(r'builtins\.match "\^\(([^)]*)\)\.\*"', text)
    exclusions = match.group(1).split("|") if match else []
    dispatch_outputs = {}
    dispatch_commands = re.findall(
        r"(?ms)^        run:\s*\|\s*\n(.*?)(?=^  [A-Za-z0-9_-]+:\s*$|\Z)", text
    )
    dispatch_text = next(
        (body for body in dispatch_commands if "pr_default=false" in body), ""
    )
    output_pattern = re.compile(r'echo "([a-z][a-z0-9-]*)=\$([a-z][a-z0-9_-]*)"')
    for output, variable in output_pattern.findall(dispatch_text):
        if output in DISPATCH_VARIABLES:
            dispatch_outputs[output] = variable
    dispatch_assignments = {}
    for variable in DISPATCH_VARIABLES.values():
        values = re.findall(rf"(?m)^\s*{re.escape(variable)}=(true|false)\s*$", dispatch_text)
        if values:
            dispatch_assignments[variable] = values[0]
    dispatch_guards = {}
    for output, variable in DISPATCH_VARIABLES.items():
        matches = re.findall(rf"(?m)^\s*{re.escape(variable)}=true\s*$", dispatch_text)
        dispatch_guards[output] = len(matches)
    return {
        "jobs": jobs,
        "job_conditions": job_conditions,
        "dispatch_outputs": dispatch_outputs,
        "dispatch_assignments": dispatch_assignments,
        "dispatch_guards": dispatch_guards,
        "dispatch_logic_sha256": hashlib.sha256(dispatch_text.encode()).hexdigest(),
        "flake_check_exclusions": exclusions,
        "text": text,
    }


def _root_input_node(nodes, root_inputs, name):
    ref = root_inputs.get(name)
    if ref is None:
        return None
    if isinstance(ref, str):
        return nodes.get(ref)
    if "follows" in ref:
        return None
    return nodes.get(ref.get("id"))


def lock_facts(lock):
    """Derive flake input names and external pin identities from ``flake.lock``."""
    nodes = lock.get("nodes", {})
    root_inputs = nodes.get("root", {}).get("inputs", {})
    # ``self`` is registered by the personal host even though it is not a
    # lockfile node; flake=false inputs never reach nix.registry.
    flake_inputs = {"self"}
    pins = {}
    for name in sorted(root_inputs):
        node = _root_input_node(nodes, root_inputs, name)
        if node is None:
            continue
        if node.get("flake") is not False:
            flake_inputs.add(name)
        locked = node.get("locked", {})
        pins[name] = {key: locked[key] for key in LOCK_IDENTITY_FIELDS if key in locked}
    return {"flake_inputs": sorted(flake_inputs), "pins": pins}


def parse_sops_rules(text):
    return sorted(re.findall(r"path_regex:\s*(\S+)", text))


def static_facts(repo):
    """Facts that can be validated offline: pins, CI lanes, and secret stores."""
    repo = pathlib.Path(repo)
    facts = lock_facts(load_json(repo / "flake.lock"))
    facts["ci"] = parse_ci((repo / ".github" / "workflows" / "ci.yml").read_text())
    sops_path = repo / ".sops.yaml"
    facts["secrets"] = {
        "stores": sorted(
            path.relative_to(repo).as_posix()
            for path in (repo / "secrets").glob("*.yaml")
        ),
        "sops_rules": parse_sops_rules(sops_path.read_text()) if sops_path.exists() else [],
    }
    return facts


def _diff_lists(base, observed, failures, additions, kind, system=None):
    for item in base or []:
        if item not in (observed or []):
            findings = {"kind": kind, "selector": item, "detail": "missing from observation"}
            if system is not None:
                findings["system"] = system
            failures.append(findings)
    for item in observed or []:
        if item not in (base or []):
            additions.append(
                {"kind": kind, "selector": item}
                if system is None
                else {"kind": kind, "system": system, "selector": item}
            )


def diff_selectors(base, observed, failures, additions):
    base = base or {}
    observed = observed or {}
    _diff_lists(base.get("systems"), observed.get("systems"), failures, additions, "systems")
    for system in observed.get("systems") or []:
        if system not in (base.get("systems") or []):
            failures.append(
                {"kind": "systems", "selector": system, "detail": "unrecorded live system"}
            )
    for kind in PER_SYSTEM_KINDS:
        base_systems = base.get(kind) or {}
        observed_systems = observed.get(kind) or {}
        for system, names in base_systems.items():
            actual = observed_systems.get(system)
            if actual is None:
                failures.append(
                    {
                        "kind": kind,
                        "system": system,
                        "selector": "*",
                        "detail": "system missing from observation",
                    }
                )
                continue
            _diff_lists(names, actual, failures, additions, kind, system)
            for name in actual:
                if name in names or (kind == "checks" and name == "flake-layout-baseline"):
                    continue
                failures.append(
                    {
                        "kind": kind,
                        "system": system,
                        "selector": name,
                        "detail": "unrecorded live selector",
                    }
                )
        for system in observed_systems:
            if system not in base_systems:
                failures.append(
                    {
                        "kind": kind,
                        "system": system,
                        "selector": "*",
                        "detail": "unrecorded system",
                    }
                )
    for kind in FLAT_KINDS:
        _diff_lists(base.get(kind), observed.get(kind), failures, additions, kind)
        for name in observed.get(kind) or []:
            if name not in (base.get(kind) or []):
                failures.append(
                    {"kind": kind, "selector": name, "detail": "unrecorded live selector"}
                )


def diff_registry(base, observed, failures, additions):
    base = base or {}
    observed = observed or {}
    for field, kind in (
        ("registry_names", "registry"),
        ("nix_path", "nix-path"),
        ("search_path_targets", "search-path"),
    ):
        _diff_lists(base.get(field), observed.get(field), failures, additions, kind)


def _diff_secret_wiring(label, base, observed, failures, additions, changes):
    for secret_name, expected in base.items():
        actual = observed.get(secret_name)
        if actual is None:
            failures.append(
                {
                    "kind": "secret-wiring",
                    "selector": f"{label}.{secret_name}",
                    "detail": "declared secret is missing",
                }
            )
            continue
        for field in ("path", "owner", "mode"):
            if actual.get(field) != expected.get(field):
                failures.append(
                    {
                        "kind": "secret-wiring",
                        "selector": f"{label}.{secret_name}",
                        "detail": f"{field} changed",
                    }
                )
    for secret_name in observed:
        if secret_name not in base:
            additions.append(
                {"kind": "secret-wiring", "selector": f"{label}.{secret_name}"}
            )


def diff_host_wiring(base, observed, failures, additions, changes):
    base = base or {}
    observed = observed or {}
    for key, value in base.items():
        if key not in observed:
            failures.append(
                {"kind": "host_wiring", "selector": key, "detail": "missing from observation"}
            )
        elif observed[key] != value:
            finding = {
                "kind": "host_wiring",
                "selector": key,
                "detail": f"{value!r} -> {observed[key]!r}",
            }
            if key in ("personal_sops_secrets", "fabro_sops_secrets"):
                _diff_secret_wiring(key, value, observed[key], failures, additions, changes)
            elif key in IDENTITY_HOST_KEYS:
                failures.append(finding)
            else:
                changes.append(finding)
    for key in observed:
        if key not in base:
            additions.append({"kind": "host_wiring", "selector": key})


def diff_static(baseline, facts):
    """Compare the recorded baseline with offline repository facts."""
    failures = []
    additions = []
    changes = []
    if not baseline.get("inventory_sha256"):
        failures.append(
            {
                "kind": "baseline-integrity",
                "selector": "inventory_sha256",
                "detail": "required pre-migration inventory hash is missing",
            }
        )
    elif not re.fullmatch(r"[0-9a-f]{64}", baseline["inventory_sha256"]):
        failures.append(
            {
                "kind": "baseline-integrity",
                "selector": "inventory_sha256",
                "detail": "inventory hash must be a lowercase SHA-256 hex digest",
            }
        )
    else:
        expected_hash = baseline.get("inventory_sha256")
        actual_hash = inventory_hash(
            baseline.get("selectors"), baseline.get("registry"), baseline.get("host_wiring")
        )
        if actual_hash != expected_hash:
            failures.append(
                {
                    "kind": "baseline-integrity",
                    "selector": "inventory_sha256",
                    "detail": "selector, registry, or host-wiring inventory changed since capture",
                }
            )
    for name, identity in sorted((baseline.get("pins") or {}).items()):
        actual = facts["pins"].get(name)
        if actual is None:
            failures.append(
                {"kind": "pins", "selector": name, "detail": "input missing from flake.lock"}
            )
        elif actual != identity:
            changes.append({"kind": "pins", "selector": name, "detail": f"{identity} -> {actual}"})

    _diff_lists(
        (baseline.get("registry") or {}).get("registry_names"),
        facts["flake_inputs"],
        failures,
        additions,
        "flake-input",
    )

    base_ci = baseline.get("ci") or {}
    base_jobs = base_ci.get("jobs") or {}
    actual_jobs = facts["ci"]["jobs"]
    base_conditions = base_ci.get("job_conditions") or {}
    actual_conditions = facts["ci"].get("job_conditions") or {}
    for name, runner in sorted(base_jobs.items()):
        if name not in actual_jobs:
            failures.append({"kind": "ci", "selector": name, "detail": "job missing from ci.yml"})
        elif actual_jobs[name] != runner:
            changes.append(
                {"kind": "ci", "selector": name, "detail": f"{runner} -> {actual_jobs[name]}"}
            )
        expected_condition = base_conditions.get(name)
        actual_condition = actual_conditions.get(name)
        if expected_condition != actual_condition:
            failures.append(
                {
                    "kind": "ci-lane",
                    "selector": name,
                    "detail": f"condition changed: {expected_condition!r} -> {actual_condition!r}",
                }
            )
    for name in actual_jobs:
        if name not in base_jobs:
            additions.append({"kind": "ci", "selector": name})
    base_dispatch = base_ci.get("dispatch_outputs") or {}
    actual_ci = facts["ci"]
    expected_logic_hash = base_ci.get("dispatch_logic_sha256")
    actual_logic_hash = actual_ci.get("dispatch_logic_sha256")
    if not expected_logic_hash or actual_logic_hash != expected_logic_hash:
        failures.append(
            {
                "kind": "ci-dispatch",
                "selector": "dispatch_logic",
                "detail": "dispatch control flow changed since baseline capture",
            }
        )
    actual_dispatch = actual_ci.get("dispatch_outputs") or {}
    base_assignments = base_ci.get("dispatch_assignments") or {}
    actual_assignments = actual_ci.get("dispatch_assignments") or {}
    base_guards = base_ci.get("dispatch_guards") or {}
    actual_guards = actual_ci.get("dispatch_guards") or {}
    if (
        not base_dispatch
        or set(base_dispatch) != set(DISPATCH_VARIABLES)
        or set(base_assignments) != set(DISPATCH_VARIABLES.values())
        or set(base_guards) != set(DISPATCH_VARIABLES)
    ):
        failures.append(
            {
                "kind": "ci-dispatch",
                "selector": "dispatch_outputs",
                "detail": "dispatch output inventory is incomplete",
            }
        )
    for name, variable in sorted(base_dispatch.items()):
        if actual_dispatch.get(name) != variable:
            failures.append(
                {
                    "kind": "ci-dispatch",
                    "selector": name,
                    "detail": f"dispatch output changed: {variable!r} -> {actual_dispatch.get(name)!r}",
                }
            )
        expected_assignment = base_assignments.get(variable)
        actual_assignment = actual_assignments.get(variable)
        if actual_assignment != expected_assignment:
            failures.append(
                {
                    "kind": "ci-dispatch",
                    "selector": name,
                    "detail": f"dispatch initialization changed: {expected_assignment!r} -> {actual_assignment!r}",
                }
            )
        expected_guards = base_guards.get(name)
        actual_guard_count = actual_guards.get(name)
        if expected_guards != actual_guard_count or not actual_guard_count:
            failures.append(
                {
                    "kind": "ci-dispatch",
                    "selector": name,
                    "detail": f"dispatch enablement logic changed: {expected_guards!r} -> {actual_guard_count!r}",
                }
            )

    _diff_lists(
        base_ci.get("flake_check_exclusions"),
        facts["ci"]["flake_check_exclusions"],
        failures,
        additions,
        "ci-exclusion",
    )
    for command in base_ci.get("required_commands") or []:
        if command not in facts["ci"]["text"]:
            failures.append(
                {"kind": "ci-command", "selector": command, "detail": "command missing from ci.yml"}
            )
    check_names = [
        name for names in (baseline.get("selectors", {}).get("checks") or {}).values() for name in names
    ]
    blockers = {item.get("name") for item in (baseline.get("runner_blockers") or [])}
    expected_blockers = set(base_ci.get("flake_check_exclusions") or [])
    for name in sorted(expected_blockers - blockers):
        failures.append(
            {
                "kind": "runner-blocker",
                "selector": name,
                "detail": "CI flake-check exclusion has no recorded blocker",
            }
        )
    for name in sorted(blockers - expected_blockers):
        failures.append(
            {
                "kind": "runner-blocker",
                "selector": name,
                "detail": "recorded blocker is not a CI flake-check exclusion",
            }
        )
    for blocker in baseline.get("runner_blockers") or []:
        name = blocker.get("name")
        if name not in facts["ci"]["flake_check_exclusions"]:
            failures.append(
                {
                    "kind": "runner-blocker",
                    "selector": name,
                    "detail": "recorded blocker is no longer a CI flake-check exclusion",
                }
            )
        if not any(
            check == name or check.startswith(name + "-") or name.startswith(check + "-")
            for check in check_names
        ):
            failures.append(
                {
                    "kind": "runner-blocker",
                    "selector": name,
                    "detail": "recorded blocker has no matching baseline check selector",
                }
            )

    base_secrets = baseline.get("secrets") or {}
    _diff_lists(
        base_secrets.get("stores"), facts["secrets"]["stores"], failures, additions, "secret-store"
    )
    _diff_lists(
        base_secrets.get("sops_rules"),
        facts["secrets"]["sops_rules"],
        failures,
        additions,
        "sops-rule",
    )
    return {"failures": failures, "additions": additions, "changes": changes}


def runner_blockers(baseline, observation, native_system=None):
    """Record known blockers and systems not selected for this build context."""
    blockers = [
        dict(
            entry,
            status="covered-elsewhere"
            if entry.get("kind") == "ci-redundant-hook"
            else "blocked",
        )
        for entry in baseline.get("runner_blockers") or []
    ]
    if native_system:
        for system in (observation.get("selectors") or {}).get("systems") or []:
            if system != native_system:
                blockers.append(
                    {
                        "name": f"checks.{system}",
                        "kind": "not-selected",
                        "platform": system,
                        "reason": f"not selected in the {native_system} check build",
                        "status": "not-run",
                    }
                )
    return blockers


def inventory_hash(selectors, registry, host_wiring):
    source_inventory = {
        "selectors": selectors,
        "registry": registry,
        "host_wiring": host_wiring,
    }
    return hashlib.sha256(
        json.dumps(source_inventory, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def compare(baseline, observation, facts=None, native_system=None):
    """Compare a captured observation against the recorded baseline."""
    failures = []
    additions = []
    changes = []
    inventory_sha256 = baseline.get("inventory_sha256")
    if not inventory_sha256:
        failures.append(
            {
                "kind": "baseline-integrity",
                "selector": "inventory_sha256",
                "detail": "required pre-migration inventory hash is missing",
            }
        )
    elif not re.fullmatch(r"[0-9a-f]{64}", inventory_sha256):
        failures.append(
            {
                "kind": "baseline-integrity",
                "selector": "inventory_sha256",
                "detail": "inventory hash must be a lowercase SHA-256 hex digest",
            }
        )
    if inventory_sha256 and re.fullmatch(r"[0-9a-f]{64}", inventory_sha256):
        actual_sha256 = inventory_hash(
            baseline.get("selectors"), baseline.get("registry"), baseline.get("host_wiring")
        )
        if actual_sha256 != inventory_sha256:
            failures.append(
                {
                    "kind": "baseline-integrity",
                    "selector": "inventory_sha256",
                    "detail": "selector, registry, or host-wiring inventory changed since capture",
                }
            )
    diff_selectors(
        baseline.get("selectors"), observation.get("selectors"), failures, additions
    )
    diff_registry(baseline.get("registry"), observation.get("registry"), failures, additions)
    for category, expected, actual in (
        ("registry", baseline.get("registry") or {}, observation.get("registry") or {}),
        ("host_wiring", baseline.get("host_wiring") or {}, observation.get("host_wiring") or {}),
    ):
        for key, value in expected.items():
            observed_value = actual.get(key)
            if isinstance(value, dict) and isinstance(observed_value, dict):
                missing = set(value) - set(observed_value)
                extra = set(observed_value) - set(value)
                for name in sorted(missing):
                    failures.append(
                        {"kind": category, "selector": f"{key}.{name}", "detail": "missing from baseline"}
                    )
                for name in sorted(extra):
                    if category == "host_wiring" and key in (
                        "personal_sops_secrets",
                        "fabro_sops_secrets",
                    ):
                        continue
                    failures.append(
                        {"kind": category, "selector": f"{key}.{name}", "detail": "unrecorded live selector"}
                    )
            elif key not in actual:
                failures.append(
                    {"kind": category, "selector": key, "detail": "missing from observation"}
                )
    diff_host_wiring(
        baseline.get("host_wiring"), observation.get("host_wiring"), failures, additions, changes
    )
    if facts is not None:
        static = diff_static(baseline, facts)
        failures.extend(static["failures"])
        additions.extend(static["additions"])
        changes.extend(static["changes"])
        # A baseline captured immediately before this task cannot contain the
        # check that implements the baseline itself. Do not mistake this one
        # expected post-capture selector for an output added during migration.
        additions[:] = [
            item
            for item in additions
            if not (
                item.get("kind") == "checks"
                and item.get("selector") == "flake-layout-baseline"
            )
        ]
    return {
        "status": "failed" if failures else "ok",
        "failures": failures,
        "blockers": runner_blockers(baseline, observation, native_system),
        "additions": additions,
        "changes": changes,
    }


def capture_observation(repo):
    """Evaluate ``observation.nix`` against the live flake."""
    root = pathlib.Path(repo).resolve()
    expression = (
        f"import {json.dumps(str(OBSERVATION_NIX))} "
        f'{{ self = builtins.getFlake {json.dumps("path:" + str(root))}; }}'
    )
    process = subprocess.run(
        ["nix", "eval", "--json", "--impure", "--expr", expression],
        capture_output=True,
        text=True,
        check=False,
    )
    if process.returncode != 0:
        raise SystemExit(f"nix eval failed:\n{process.stderr}")
    return json.loads(process.stdout)


def _capture_blocker(name):
    kind, reason = BLOCKER_REASONS.get(
        name, ("ci-exclusion", "excluded from the CI flake-check lane")
    )
    return {"name": name, "kind": kind, "reason": reason}


def capture(repo):
    """Build a complete baseline document from the live flake and repo facts."""
    observation = capture_observation(repo)
    facts = static_facts(repo)
    exclusions = facts["ci"]["flake_check_exclusions"]
    selectors = observation["selectors"]
    registry = observation["registry"]
    host_wiring = observation["host_wiring"]
    # Hash the first capture's authoritative observations. If the JSON inventory
    # is later edited to omit live outputs, verification can detect that it no
    # longer represents this capture rather than treating omissions as additions.
    inventory_sha256 = inventory_hash(selectors, registry, host_wiring)
    return {
        "schema_version": 1,
        "inventory_sha256": inventory_sha256,
        "selectors": observation["selectors"],
        "registry": observation["registry"],
        "host_wiring": observation["host_wiring"],
        "pins": {name: facts["pins"][name] for name in PIN_INPUTS if name in facts["pins"]},
        "ci": {
            "jobs": facts["ci"]["jobs"],
            "job_conditions": facts["ci"]["job_conditions"],
            "dispatch_outputs": facts["ci"]["dispatch_outputs"],
            "dispatch_assignments": facts["ci"]["dispatch_assignments"],
            "dispatch_guards": facts["ci"]["dispatch_guards"],
            "dispatch_logic_sha256": facts["ci"]["dispatch_logic_sha256"],
            "flake_check_exclusions": exclusions,
            "required_commands": list(CI_REQUIRED_COMMANDS),
        },
        "secrets": facts["secrets"],
        "runner_blockers": [_capture_blocker(name) for name in exclusions],
    }


def format_document(value):
    """Pretty-print a document while keeping scalar lists on one line."""

    def render(item, depth):
        pad = "  " * depth
        if isinstance(item, dict):
            if not item:
                return "{}"
            if all(not isinstance(child, (dict, list)) for child in item.values()):
                body = ", ".join(f"{json.dumps(k)}: {json.dumps(item[k])}" for k in sorted(item))
                return "{" + body + "}"
            entries = [
                f"{pad}  {json.dumps(key)}: {render(item[key], depth + 1)}"
                for key in sorted(item)
            ]
            return "{\n" + ",\n".join(entries) + f"\n{pad}}}"
        if isinstance(item, list):
            if not item:
                return "[]"
            if all(not isinstance(child, (dict, list)) for child in item):
                return "[" + ", ".join(json.dumps(child) for child in item) + "]"
            entries = [f"{pad}  {render(child, depth + 1)}" for child in item]
            return "[\n" + ",\n".join(entries) + f"\n{pad}]"
        return json.dumps(item)

    return render(value, 0) + "\n"


def _write_report(report):
    print(json.dumps(report, indent=2, sort_keys=True))
    summary = (
        f"{report['status']}: {len(report['failures'])} failure(s), "
        f"{len(report['blockers'])} blocker(s), {len(report['changes'])} change(s)"
    )
    print(summary, file=sys.stderr)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)

    capture_cmd = commands.add_parser("capture", help="record the baseline from the live flake")
    capture_cmd.add_argument("--flake", default=str(ROOT))
    capture_cmd.add_argument("--output", default=str(DEFAULT_BASELINE))

    verify_cmd = commands.add_parser("verify", help="compare an observation with the baseline")
    verify_cmd.add_argument("--baseline", default=str(DEFAULT_BASELINE))
    verify_cmd.add_argument("--observation", help="captured observation JSON")
    verify_cmd.add_argument("--repo", default=str(ROOT))
    verify_cmd.add_argument("--native-system", help="current runner system")
    verify_cmd.add_argument(
        "--static",
        action="store_true",
        help="also compare pins, CI lanes, and secret stores",
    )

    static_cmd = commands.add_parser("check-static", help="validate the baseline against repo files")
    static_cmd.add_argument("--baseline", default=str(DEFAULT_BASELINE))
    static_cmd.add_argument("--repo", default=str(ROOT))

    args = parser.parse_args(argv)

    if args.command == "capture":
        document = capture(args.flake)
        pathlib.Path(args.output).write_text(format_document(document))
        print(args.output, file=sys.stderr)
        return 0

    baseline = load_json(args.baseline)
    if args.command == "check-static":
        report = diff_static(baseline, static_facts(args.repo))
        report = {"status": "failed" if report["failures"] else "ok", **report, "blockers": []}
    else:
        observation = (
            load_json(args.observation)
            if args.observation
            else capture_observation(args.repo)
        )
        report = compare(
            baseline,
            observation,
            static_facts(args.repo) if args.static else None,
            args.native_system,
        )
    _write_report(report)
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
