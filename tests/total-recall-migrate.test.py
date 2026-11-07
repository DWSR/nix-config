#!/usr/bin/env python3
"""Behavioral tests for the total-recall migration runner."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "configurations/fabro-vm/total-recall/migrate.sh"
MIGRATIONS = [
    "0001_memory_schema_search.sql",
    "0001_harness_event_ledger.sql",
    "0002_session_embeddings.sql",
    "0001_session_post_processing.sql",
]


FAKE_PSQL = r'''#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

state = Path(os.environ["FAKE_PSQL_STATE"])
ledger_path = state / "ledger.json"
ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {}
args = sys.argv[1:]
stdin = sys.stdin.read()

command = args[args.index("--command") + 1] if "--command" in args else ""

if "SELECT to_regclass" in command:
    if (state / "ledger_exists").exists():
        print("public.total_recall_schema_migrations")
    sys.exit(0)

if "CREATE TABLE public.total_recall_schema_migrations" in command:
    (state / "ledger_exists").touch()
    sys.exit(0)

if "CREATE TABLE public.total_recall_schema_migrations" in command:
    (state / "ledger_exists").touch()
    sys.exit(0)

if "SELECT sha256" in command:
    migration_name = command.split("WHERE name = '", 1)[1].split("'", 1)[0]
    if migration_name in ledger:
        print(ledger[migration_name])
    sys.exit(0)

if "--file" in args:
    file_path = Path(args[args.index("--file") + 1])
    with (state / "files.log").open("a") as log:
        log.write(file_path.name + "\n")
    print(f"APPLIED FILE: {file_path.name}")
    sys.exit(0)

if stdin.startswith("BEGIN;"):
    migration_name = next(
        line.removeprefix("-- migration: ")
        for line in stdin.splitlines()
        if line.startswith("-- migration: ")
    )
    insert = next(line for line in stdin.splitlines() if line.startswith("INSERT INTO public.total_recall_schema_migrations"))
    values = insert.split("VALUES ('", 1)[1].split("')", 1)[0]
    migration_hash = values.split("', '", 1)[1]
    if os.environ.get("FAKE_PSQL_FAIL_MIGRATION") == migration_name:
        print("simulated SQL failure", file=sys.stderr)
        sys.exit(23)

    with (state / "migrations.log").open("a") as log:
        log.write(migration_name + "\n")
    ledger[migration_name] = migration_hash
    ledger_path.write_text(json.dumps(ledger))
    sys.exit(0)

print("unhandled fake psql invocation", file=sys.stderr)
sys.exit(99)
'''


class TotalRecallMigrateTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.migration_dir = self.root / "migrations"
        self.migration_dir.mkdir()
        for name in MIGRATIONS:
            (self.migration_dir / name).write_text(f"CREATE TABLE {name[:-4]} (id integer);\n")
        (self.migration_dir / "bootstrap.sql").write_text("SELECT 'bootstrap';\n")
        (self.migration_dir / "runtime-grants.sql").write_text("SELECT 'grants';\n")
        fake_bin = self.root / "bin"
        fake_bin.mkdir()
        fake_psql = fake_bin / "psql"
        fake_psql.write_text(FAKE_PSQL)
        fake_psql.chmod(0o755)
        self.state = self.root / "state"
        self.state.mkdir()
        self.env = os.environ.copy()
        self.env.update(
            {
                "FAKE_PSQL_STATE": str(self.state),
                "MIGRATION_DIR": str(self.migration_dir),
                "PATH": f"{fake_bin}:{os.environ['PATH']}",
            }
        )

    def tearDown(self):
        self.tempdir.cleanup()

    def run_migrations(self, *args, env=None):
        return subprocess.run(
            [str(RUNNER), "memory", *args],
            cwd=ROOT,
            env=env or self.env,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_first_run_records_all_four_ordered_migrations_and_second_skips_them(self):
        first = self.run_migrations()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(
            (self.state / "migrations.log").read_text().splitlines(), MIGRATIONS
        )
        self.assertEqual(set(json.loads((self.state / "ledger.json").read_text())), set(MIGRATIONS))

        (self.state / "migrations.log").unlink()
        second = self.run_migrations()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertFalse((self.state / "migrations.log").exists())

    def test_changed_applied_migration_fails_by_filename_before_applying_anything(self):
        self.assertEqual(self.run_migrations().returncode, 0)
        (self.state / "migrations.log").unlink()
        changed = self.migration_dir / MIGRATIONS[1]
        changed.write_text(changed.read_text() + "-- changed\n")

        result = self.run_migrations()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(MIGRATIONS[1], result.stderr)
        self.assertFalse((self.state / "migrations.log").exists())

    def test_psql_failure_names_file_and_stops_before_later_migrations(self):
        env = self.env.copy()
        env["FAKE_PSQL_FAIL_MIGRATION"] = MIGRATIONS[1]

        result = self.run_migrations(env=env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(MIGRATIONS[1], result.stderr)
        self.assertEqual(
            (self.state / "migrations.log").read_text().splitlines(), [MIGRATIONS[0]]
        )

    def test_bootstrap_and_ledger_are_applied_before_upstream_migrations(self):
        result = self.run_migrations()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            (self.state / "files.log").read_text().splitlines(), ["bootstrap.sql"]
        )
        self.assertIn("CREATE TABLE public.total_recall_schema_migrations", result.stdout + result.stderr)

    def test_runner_contains_no_destructive_sql(self):
        script = RUNNER.read_text().upper()
        for statement in ("DROP ", "TRUNCATE ", "ALTER TABLE", "ALTER DATABASE"):
            with self.subTest(statement=statement):
                self.assertNotIn(statement, script)


if __name__ == "__main__":
    unittest.main()
