"""Dependency-release cooldown policy (issue #241).

Every package manager this repository uses must refuse dependency versions
published less than seven days ago, so a freshly compromised release cannot be
picked up before the ecosystem has had time to notice it.

* npm projects opt in with ``min-release-age`` in a project-level ``.npmrc``.
  npm only reads the ``.npmrc`` that sits next to ``package.json``; it does not
  walk parent directories, so every npm project needs its own file.
* uv reads ``exclude-newer`` from the nearest ``uv.toml``/``pyproject.toml``, so
  the repository-root ``uv.toml`` covers every uv command run in this checkout.
* Cargo, Go modules, Nix flake inputs, and GitHub Actions have no local
  release-age control, so Dependabot owns their window: each of those manifests
  must be covered by a Dependabot update entry whose
  ``cooldown.default-days`` is at least seven.

Vendored lockfiles that have no manifest next to them (for example the
upstream ``package-lock.json`` copies under ``scripts/pi-lens``) are pinned
snapshots: nothing resolves a version there, so no package-manager config
applies.

The assertions are offline and run from ``nix flake check``.
"""

import os
import pathlib
import re
import tomllib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEPENDABOT = ROOT / ".github" / "dependabot.yml"
NPMRC_KEY = "min-release-age"
COOLDOWN_DAYS = 7

# Directories that hold tool state or dependency trees rather than repository
# manifests (``result``/``result-1`` symlink into the Nix store).
SKIP_DIRS = {".git", ".direnv", "node_modules", "result"}


def posix(path):
    """Render ``path`` as a repository-relative POSIX path (``/`` for the root)."""
    relative = path.relative_to(ROOT).as_posix()
    return "/" if relative == "." else "/" + relative


def walk_manifests(name):
    """Yield every directory below the root that contains a file called ``name``."""
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = sorted(
            directory
            for directory in dirnames
            if directory not in SKIP_DIRS and not directory.startswith("result-")
        )
        if name in filenames:
            yield pathlib.Path(dirpath)


def unquote(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value


def parse_dependabot(text):
    """Parse ``.github/dependabot.yml`` into update entries.

    Only the block structure this file uses is interpreted (``updates`` list
    items, ``directory``/``directories``, and ``cooldown``), which keeps the
    policy check dependency-free inside the Nix sandbox.
    """
    entries = []
    entry = None
    section = None
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        line = raw.strip()
        if line.startswith("- "):
            item = line[2:].strip()
            if indent == 2 and item.startswith("package-ecosystem:"):
                entry = {
                    "ecosystem": unquote(item.partition(":")[2]),
                    "directories": [],
                    "directory": None,
                    "cooldown": {},
                }
                entries.append(entry)
                section = None
            elif indent == 6 and section == "directories" and entry is not None:
                entry["directories"].append(unquote(item))
            continue
        if entry is None:
            continue
        key, _, value = line.partition(":")
        key, value = key.strip(), unquote(value)
        if indent == 4:
            if value:
                entry[key] = value
                section = None
            else:
                section = key
            continue
        if indent == 6 and section == "cooldown":
            entry["cooldown"][key] = value
    return entries


def parse_npmrc(text):
    settings = {}
    for line in text.splitlines():
        line = line.split("#", 1)[0].split(";", 1)[0].strip()
        if not line or "=" not in line:
            continue
        key, _, value = line.partition("=")
        settings[key.strip().lower()] = unquote(value)
    return settings


def duration_days(value):
    """Return ``value`` as a number of days, or ``None`` when it is not a duration.

    Accepts the friendly and ISO 8601 forms uv documents for ``exclude-newer``.
    """
    friendly = re.fullmatch(r"\s*(\d+)\s*(hours?|days?|weeks?)\s*", value or "")
    if friendly:
        amount = int(friendly.group(1))
        unit = friendly.group(2).rstrip("s")
        return {"hour": amount / 24, "day": amount, "week": amount * 7}[unit]
    iso = re.fullmatch(r"P(?:(\d+)W)?(?:(\d+)D)?", (value or "").strip())
    if iso and (iso.group(1) or iso.group(2)):
        return int(iso.group(1) or 0) * 7 + int(iso.group(2) or 0)
    return None


def uv_config_for(directory):
    """Return the uv config file that governs ``directory`` or ``None``."""
    current = directory
    while True:
        for candidate in ("uv.toml", "pyproject.toml"):
            path = current / candidate
            if path.is_file():
                return path
        if current == ROOT:
            return None
        current = current.parent


class DependencyCooldownTests(unittest.TestCase):
    def setUp(self):
        self.entries = parse_dependabot(DEPENDABOT.read_text())

    def entry_for(self, ecosystem, directory):
        wanted = posix(directory)
        for entry in self.entries:
            if entry["ecosystem"] != ecosystem:
                continue
            covered = list(entry["directories"])
            if entry.get("directory"):
                covered.append(entry["directory"])
            if wanted in covered:
                return entry
        return None

    def assert_covers(self, ecosystem, directory):
        entry = self.entry_for(ecosystem, directory)
        self.assertIsNotNone(
            entry,
            "%s is not covered by a Dependabot %s entry" % (posix(directory), ecosystem),
        )
        days = entry["cooldown"].get("default-days")
        self.assertIsNotNone(
            days,
            "Dependabot %s entry for %s has no cooldown"
            % (ecosystem, posix(directory)),
        )
        self.assertGreaterEqual(
            int(days),
            COOLDOWN_DAYS,
            "Dependabot %s entry for %s cools down for %s days, expected at least %d"
            % (ecosystem, posix(directory), days, COOLDOWN_DAYS),
        )

    def test_every_dependabot_update_entry_has_a_seven_day_cooldown(self):
        self.assertTrue(self.entries, "%s defines no update entries" % DEPENDABOT)
        for entry in self.entries:
            with self.subTest(ecosystem=entry["ecosystem"]):
                days = entry["cooldown"].get("default-days")
                self.assertIsNotNone(
                    days,
                    "Dependabot %s entry has no cooldown"
                    % entry["ecosystem"],
                )
                self.assertGreaterEqual(int(days), COOLDOWN_DAYS)

    def test_every_npm_project_pins_the_seven_day_release_age(self):
        projects = list(walk_manifests("package.json"))
        self.assertTrue(projects, "no npm projects found in the repository")
        for project in projects:
            with self.subTest(project=posix(project)):
                npmrc = project / ".npmrc"
                self.assertTrue(
                    npmrc.is_file(),
                    "%s has no .npmrc; npm only reads the .npmrc next to "
                    "package.json, so each project must pin %s"
                    % (posix(project), NPMRC_KEY),
                )
                days = parse_npmrc(npmrc.read_text()).get(NPMRC_KEY)
                self.assertIsNotNone(
                    days,
                    "%s does not set %s" % (posix(npmrc), NPMRC_KEY),
                )
                self.assertGreaterEqual(int(days), COOLDOWN_DAYS)
                self.assert_covers("npm", project)

    def test_every_cargo_manifest_is_dependabot_covered(self):
        manifests = list(walk_manifests("Cargo.toml"))
        self.assertTrue(manifests, "no Cargo manifests found in the repository")
        for manifest in manifests:
            with self.subTest(manifest=posix(manifest)):
                self.assert_covers("cargo", manifest)

    def test_every_go_module_with_dependencies_is_dependabot_covered(self):
        modules = [
            module
            for module in walk_manifests("go.mod")
            if re.search(r"^\s*require\b", (module / "go.mod").read_text(), re.M)
        ]
        self.assertTrue(modules, "no Go module with dependencies found")
        for module in modules:
            with self.subTest(module=posix(module)):
                self.assert_covers("gomod", module)

    def test_nix_flake_inputs_are_dependabot_covered(self):
        self.assertTrue((ROOT / "flake.nix").is_file(), "flake.nix is missing")
        self.assert_covers("nix", ROOT)

    def test_github_actions_are_dependabot_covered(self):
        workflows = ROOT / ".github" / "workflows"
        self.assertTrue(
            any(workflows.glob("*.yml")),
            "%s has no workflow files" % workflows.relative_to(ROOT),
        )
        self.assert_covers("github-actions", ROOT)

    def test_uv_uses_the_seven_day_exclude_newer(self):
        config = ROOT / "uv.toml"
        self.assertTrue(
            config.is_file(),
            "%s is missing; uv would resolve fresh releases" % posix(config),
        )
        with config.open("rb") as handle:
            exclude_newer = tomllib.load(handle).get("exclude-newer")
        self.assertIsNotNone(exclude_newer, "uv.toml does not set exclude-newer")
        days = duration_days(str(exclude_newer))
        self.assertIsNotNone(
            days, "uv.toml exclude-newer %r is not a duration" % (exclude_newer,)
        )
        self.assertGreaterEqual(days, COOLDOWN_DAYS)

    def test_every_uv_lock_inherits_the_repository_window(self):
        locks = list(walk_manifests("uv.lock"))
        self.assertTrue(locks, "no uv.lock found in the repository")
        for lock in locks:
            with self.subTest(lock=posix(lock)):
                self.assertEqual(
                    uv_config_for(lock),
                    ROOT / "uv.toml",
                    "%s is governed by another uv config, not the repository "
                    "exclude-newer" % posix(lock),
                )


if __name__ == "__main__":
    unittest.main()
