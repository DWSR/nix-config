#!/usr/bin/env python3
"""Behavioral tests for the guest migration runner."""

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "configurations/fabro-vm/total-recall/migrate.sh"
DERIVATION = ROOT / "configurations/fabro-vm/total-recall/migrate.nix"
MIGRATIONS = [
    "0001_memory_schema_search.sql",
    "0001_harness_event_ledger.sql",
    "0002_session_embeddings.sql",
    "0001_session_post_processing.sql",
]
UPSTREAM_PATHS = [
    "crates/memory-store/migrations/0001_memory_schema_search.sql",
    "workers/harness-event-persistence/migrations/0001_harness_event_ledger.sql",
    "workers/harness-event-persistence/migrations/0002_session_embeddings.sql",
    "workers/session-post-processing/migrations/0001_session_post_processing.sql",
]

FAKE_PSQL = r'''#!/usr/bin/env python3
import json
import os
import re
import sys
from pathlib import Path

args = sys.argv[1:]
state_path = Path(os.environ["FAKE_PSQL_STATE"])
state = json.loads(state_path.read_text())
state["calls"].append(args)
command_arg = next((arg for arg in args if arg.startswith("--command=")), None)
command = command_arg.split("=", 1)[1] if command_arg else None
file_arg = next((arg for arg in args if arg.startswith("--file=")), None)
sql_file = file_arg.split("=", 1)[1] if file_arg else None

if sql_file:
    sql = Path(sql_file).read_text()
    event = Path(sql_file).name.removesuffix(".sql")
    state["events"].append(event)
    if event == "bootstrap":
        pass
    elif event == "runtime-grants":
        pass
elif command:
    sql = command
    if "to_regclass" in sql:
        print("t" if state["ledger_initialized"] else "f")
    elif "CREATE TABLE" in sql:
        state["ledger_initialized"] = True
        state["events"].append("ledger-create")
    elif "SELECT sha256" in sql:
        name = re.search(r"WHERE name = '([^']+)'", sql).group(1)
        if name in state["ledger"]:
            print(state["ledger"][name])
else:
    sql = sys.stdin.read()
    has_runtime_grants = "GRANT SELECT, INSERT, UPDATE ON TABLE session_records" in sql
    match = re.search(
        r"INSERT INTO public\.total_recall_schema_migrations\s*"
        r"\(name, sha256\) VALUES \('([^']+)', '([0-9a-f]{64})'\)",
        sql,
    )
    if not match:
        print("fake psql: migration transaction has no ledger insert", file=sys.stderr)
        sys.exit(2)
    name, digest = match.groups()
    if os.environ.get("FAKE_PSQL_FAIL_ON") == name:
        print(f"fake psql: forced failure applying {name}", file=sys.stderr)
        sys.exit(9)
    if has_runtime_grants:
        state["events"].append("runtime-grants")
    state["ledger"][name] = digest
    state["events"].append(f"migration:{name}")

state_path.write_text(json.dumps(state))
'''


class MigrationRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bindir = self.root / "bin"
        self.sharedir = self.root / "share/total-recall"
        self.migration_dir = self.sharedir / "migrations"
        self.bindir.mkdir(parents=True)
        self.migration_dir.mkdir(parents=True)
        runner_dir = self.root / "bin"
        (runner_dir / "share/total-recall/migrations").mkdir(parents=True)

        self.assertTrue(SCRIPT.is_file(), "migrate.sh must exist before runner tests can execute")
        shutil.copy2(SCRIPT, self.bindir / "migrate.sh")
        shutil.copy2(SCRIPT, runner_dir / "migrate.sh")
        (runner_dir / "migrate.sh").chmod(0o755)
        shutil.copy2(SCRIPT.parent / "bootstrap.sql", runner_dir / "share/total-recall/bootstrap.sql")
        shutil.copy2(SCRIPT.parent / "runtime-grants.sql", runner_dir / "share/total-recall/runtime-grants.sql")
        shutil.copy2(SCRIPT.parent / "bootstrap.sql", self.sharedir / "bootstrap.sql")
        shutil.copy2(SCRIPT.parent / "runtime-grants.sql", self.sharedir / "runtime-grants.sql")
        (runner_dir / "share/total-recall/runtime-grants.sql").write_text(
            "GRANT SELECT, INSERT, UPDATE ON TABLE session_records TO memory_application;\n"
        )
        (self.sharedir / "runtime-grants.sql").write_text(
            "GRANT SELECT, INSERT, UPDATE ON TABLE session_records TO memory_application;\n"
        )
        for filename, marker in zip(
            MIGRATIONS,
            ("memories", "session_events", "session_embeddings", "session_records"),
        ):
            (self.migration_dir / filename).write_text(
                f"CREATE TABLE {marker} (id integer);\n"
            )
            shutil.copy2(self.migration_dir / filename, runner_dir / "share/total-recall/migrations" / filename)

        self.psql = self.bindir / "psql"
        self.psql.write_text(FAKE_PSQL)
        self.psql.chmod(0o755)
        self.state_path = self.root / "psql-state.json"
        self.state_path.write_text(
            json.dumps({"ledger_initialized": False, "ledger": {}, "events": [], "calls": []})
        )
        self.env = os.environ.copy()
        self.env.update(
            {
                "PATH": f"{self.bindir}:{self.env.get('PATH', '')}",
                "FAKE_PSQL_STATE": str(self.state_path),
            }
        )

    def run_runner(self, extra_env=None):
        env = self.env.copy()
        if extra_env:
            env.update(extra_env)
        return subprocess.run(
            [str(self.root / "bin/migrate.sh"), "memory"],
            cwd=self.root,
            env=env,
            capture_output=True,
            text=True,
        )

    def read_state(self):
        return json.loads(self.state_path.read_text())

    def test_nix_derivation_copies_the_four_ordered_pinned_migrations(self):
        self.assertTrue(DERIVATION.is_file(), "migrate.nix must package the migration runner")
        derivation = DERIVATION.read_text()
        previous = -1
        for upstream_path in UPSTREAM_PATHS:
            with self.subTest(path=upstream_path):
                self.assertIn(upstream_path, derivation)
                position = derivation.index(upstream_path)
                self.assertGreater(position, previous)
                previous = position

    def test_first_run_applies_in_order_and_second_run_only_checks_the_ledger(self):
        first = self.run_runner()
        self.assertEqual(first.returncode, 0, first.stderr)
        state = self.read_state()
        self.assertEqual(set(state["ledger"]), set(MIGRATIONS))
        self.assertEqual(
            [event for event in state["events"] if event.startswith("migration:")],
            [f"migration:{name}" for name in MIGRATIONS],
        )
        events = state["events"]
        self.assertIn("bootstrap", events)
        self.assertLess(events.index("ledger-create"), events.index(f"migration:{MIGRATIONS[0]}"))
        self.assertLess(events.index("runtime-grants"), events.index(f"migration:{MIGRATIONS[-1]}"))
        for filename in MIGRATIONS:
            expected = hashlib.sha256((self.migration_dir / filename).read_bytes()).hexdigest()
            self.assertEqual(state["ledger"][filename], expected)

        second = self.run_runner()
        self.assertEqual(second.returncode, 0, second.stderr)
        state = self.read_state()
        self.assertEqual(
            [event for event in state["events"] if event.startswith("migration:")],
            [f"migration:{name}" for name in MIGRATIONS],
        )
        self.assertEqual(state["events"].count("ledger-create"), 1)
        self.assertEqual(state["events"].count("runtime-grants"), 1)
        self.assertEqual(len(state["ledger"]), 4)
        for args in state["calls"]:
            self.assertIn("--username=postgres", args)
            self.assertIn("--host=/run/postgresql", args)
            self.assertIn("--dbname=memory", args)

    def test_changed_applied_migration_fails_by_name_without_applying_anything(self):
        first = self.run_runner()
        self.assertEqual(first.returncode, 0, first.stderr)
        target = self.migration_dir / MIGRATIONS[1]
        target.write_text("CREATE TABLE changed_migration (id integer);\n")
        shutil.copy2(target, self.root / "bin/share/total-recall/migrations" / MIGRATIONS[1])

        result = self.run_runner()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(MIGRATIONS[1], result.stderr)
        self.assertEqual(
            [event for event in self.read_state()["events"] if event.startswith("migration:")],
            [f"migration:{name}" for name in MIGRATIONS],
        )

    def test_psql_failure_names_file_and_stops_before_later_migrations(self):
        result = self.run_runner({"FAKE_PSQL_FAIL_ON": MIGRATIONS[1]})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(MIGRATIONS[1], result.stderr)
        state = self.read_state()
        self.assertEqual(list(state["ledger"]), [MIGRATIONS[0]])
        self.assertNotIn(f"migration:{MIGRATIONS[2]}", state["events"])
        self.assertNotIn("runtime-grants", state["events"])


if __name__ == "__main__":
    unittest.main()
