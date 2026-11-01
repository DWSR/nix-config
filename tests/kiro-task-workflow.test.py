import contextlib
import io
import os
import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
PROMPTS = ROOT / ".fabro/workflows/kiro-task/prompts"
REVIEW = PROMPTS / "review.md"
IMPLEMENT = PROMPTS / "implement.md"
BLOCKED = PROMPTS / "blocked.md"
RULE = ROOT / ".kiro/settings/rules/secret-material-handling.md"
WORKFLOW = ROOT / ".fabro/workflows/kiro-task/workflow.fabro"
WORKFLOW_TOML = ROOT / ".fabro/workflows/kiro-task/workflow.toml"
BOUNDARY_MARKER = "cat > .git/kiro-task-scripts/tools.py <<'KIRO_TASK_TOOLS_PY'\n"
SHARED_PATHS = (
    "flake.nix",
    "flake.lock",
    "configurations/common-darwin/local-binary-cache.nix",
    "configurations/personal/default.nix",
    "tests/local-binary-cache/",
)
GIT_ENV = dict(
    os.environ,
    GIT_AUTHOR_NAME="Test",
    GIT_AUTHOR_EMAIL="test@example.com",
    GIT_COMMITTER_NAME="Test",
    GIT_COMMITTER_EMAIL="test@example.com",
)


def load_boundary_tools():
    """Extract the embedded helper between its markers and execute it."""
    text = WORKFLOW_TOML.read_text()
    script = text.split(BOUNDARY_MARKER, 1)[1].split("\nKIRO_TASK_TOOLS_PY", 1)[0]
    namespace = {"__name__": "kiro_task_tools_test"}
    exec(compile(script, str(WORKFLOW_TOML), "exec"), namespace)
    return namespace


def git(cwd, *args):
    result = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, env=GIT_ENV
    )
    if result.returncode != 0:
        raise AssertionError("git %s failed: %s" % (" ".join(args), result.stderr))
    return result.stdout.strip()


class KiroTaskEnvironmentGateTests(unittest.TestCase):
    def test_review_prompt_runs_the_aarch64_linux_gate(self):
        text = REVIEW.read_text()
        for needle in (
            "HOME=/tmp/fabro-home",
            "XDG_CACHE_HOME=/tmp/fabro-nix-cache",
            "nix flake check --show-trace",
            "nix develop --command prek run --all-files",
            "nix develop --command fabro validate",
            "aarch64-linux",
        ):
            self.assertIn(needle, text)

    def test_review_prompt_records_darwin_only_checks_as_environment_blocked(self):
        text = REVIEW.read_text()
        for needle in (
            "environment-blocked: <command> (<cause>)",
            "nix flake check --all-systems",
            "checks.aarch64-darwin",
            "hammerspoon-package",
            "fabro-vm-guest-eval",
            "platform mismatch",
            "Required system: 'aarch64-darwin'",
        ):
            self.assertIn(needle, text)

    def test_review_prompt_keeps_cross_system_checks_required(self):
        text = REVIEW.read_text()
        for needle in (
            "lima-vm-service",
            "node --test tests/lima-vm/",
            "hammerspoon-keybindings",
            "node --test tests/hammerspoon-keybindings/",
            "are real `aarch64-linux` checks",
            "their failures reject the task",
        ):
            self.assertIn(needle, text)

    def test_review_prompt_does_not_reject_or_rework_on_environment_blocked_checks(self):
        text = REVIEW.read_text()
        self.assertIn("An environment-blocked check is not a test failure", text)
        self.assertIn("do not reject the task or start a rework round", text)
        self.assertIn("never justifies a rejection or a rework round", text)
        self.assertIn("APPROVED when every evaluable mechanical check passes", text)
        self.assertIn("environment-blocked:", text.split("## Final response", 1)[1])

    def test_review_prompt_still_fails_aarch64_linux_regressions(self):
        text = REVIEW.read_text()
        self.assertIn("missing `devShells.aarch64-linux.default`", text)
        self.assertIn("is not environment-blocked", text)

    def test_review_prompt_narrows_the_no_nix_fallback(self):
        text = " ".join(REVIEW.read_text().split())
        self.assertIn("record only the Nix-dependent commands", text)
        self.assertIn("Direct language-level tests that need no Nix", text)
        self.assertIn("remain evaluable and must still run", text)
        self.assertIn("reject or escalate instead of assuming success", text)

    def test_implement_prompt_records_environment_blocked_checks(self):
        text = IMPLEMENT.read_text()
        for needle in (
            "environment-blocked: <command> (<cause>)",
            "checks.aarch64-darwin",
            "do not report\nBLOCKED",
            "nix flake check --show-trace",
            "nix develop --command prek run --all-files",
            "nix develop --command fabro validate",
        ):
            self.assertIn(needle, text)
        self.assertIn("is a real failure, not environment-blocked", " ".join(text.split()))

    def test_implement_prompt_keeps_cross_system_checks_required(self):
        text = IMPLEMENT.read_text()
        for needle in (
            "lima-vm-service",
            "node --test tests/lima-vm/",
            "hammerspoon-keybindings",
            "node --test tests/hammerspoon-keybindings/",
            "they must pass",
        ):
            self.assertIn(needle, text)

    def test_implement_prompt_narrows_the_no_nix_fallback(self):
        text = " ".join(IMPLEMENT.read_text().split())
        self.assertIn("record only the Nix-dependent commands", text)
        self.assertIn("keep running the direct language-level tests", text)
        self.assertIn("report BLOCKED with the cause", text)


class KiroTaskBoundaryGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name) / "repo"
        self.root.mkdir()
        git(self.root, "init", "--quiet", "--initial-branch=main")
        git(self.root, "config", "user.email", "test@example.com")
        git(self.root, "config", "user.name", "Test")
        self.tools = load_boundary_tools()
        self.write("flake.nix", "original flake\n")
        self.write("flake.lock", "original lock\n")
        self.write("configurations/common-darwin/local-binary-cache.nix", "original module\n")
        self.write("configurations/personal/default.nix", "original personal\n")
        self.write("tests/local-binary-cache/existing.sh", "original test\n")
        self.write("app.txt", "original app\n")
        self.write(
            ".kiro/specs/example/tasks.md",
            "- [ ] 1. Add a widget\n"
            "  - Done when the widget renders.\n"
            "- [ ] 2. Add flake checks for the widget\n"
            "  - Done when the flake check passes.\n"
            "- [ ] 3. Extend the local-binary-cache Caddy proxy\n"
            "  - Done when the proxy serves the cache.\n"
            "- [ ] 4. Adjust the personal host defaults\n"
            "  - _Boundary: configurations/personal/default.nix_\n"
            "- [ ] 5. Enable the guest on the personal host\n"
            "  - Done when the personal host evaluates.\n"
            "- [ ] 6. Run the validation suite\n"
            "  - Done when `nix flake check` passes.\n"
            "- [ ] 7. Rex flake input\n"
            "  - Add the Rex flake input and lock it in `flake.lock`.\n"
            "- [ ] 8. Add package, corpus, and Linux flake outputs\n"
            "  - Add `checks.<system>.widget` bound to the overlay package.\n"
            "- [ ] 9. Assert host and image wiring in a flake check\n"
            "  - Add `checks.<system>.widget-wiring` asserting every host carries it.\n"
            "- [ ] 10. Guard the widget against a silent downgrade\n"
            "  - Completed when a dropped widget fails `nix flake check` with a named message.\n",
        )
        self.write(
            ".kiro/specs/local-binary-cache/tasks.md",
            "- [ ] 1. Define the cache contract\n"
            "  - Done when the contract renders.\n",
        )
        git(self.root, "add", "--all")
        git(self.root, "commit", "--quiet", "-m", "initial")
        self.baseline = git(self.root, "rev-parse", "HEAD")

    def write(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def read(self, relative):
        return (self.root / relative).read_text()

    def boundary(self, task="1", baseline=None, spec="example"):
        previous = os.getcwd()
        os.chdir(self.root)
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
                io.StringIO()
            ):
                return self.tools["boundary"](spec, task, baseline or self.baseline)
        finally:
            os.chdir(previous)

    def test_reverts_unclaimed_shared_infrastructure_edits(self):
        self.write("flake.nix", "stale flake\n")
        (self.root / "flake.lock").unlink()
        self.write("configurations/common-darwin/local-binary-cache.nix", "stale module\n")
        self.write("configurations/personal/default.nix", "stale personal\n")
        self.write("tests/local-binary-cache/stale.sh", "stale test\n")

        updates = self.boundary()

        self.assertEqual(updates["boundary_status"], "reverted")
        self.assertEqual(
            updates["boundary_reverted"].split(","),
            [
                "configurations/common-darwin/local-binary-cache.nix",
                "configurations/personal/default.nix",
                "flake.lock",
                "flake.nix",
                "tests/local-binary-cache/stale.sh",
            ],
        )
        self.assertEqual(updates["boundary_protected"], "")
        self.assertEqual(self.read("flake.nix"), "original flake\n")
        self.assertEqual(self.read("flake.lock"), "original lock\n")
        self.assertEqual(
            self.read("configurations/common-darwin/local-binary-cache.nix"),
            "original module\n",
        )
        self.assertEqual(
            self.read("configurations/personal/default.nix"), "original personal\n"
        )
        self.assertFalse((self.root / "tests/local-binary-cache/stale.sh").exists())
        self.assertEqual(git(self.root, "status", "--porcelain"), "")

    def test_keeps_flake_edits_the_task_claims(self):
        self.write("flake.nix", "task flake\n")
        self.write("configurations/common-darwin/local-binary-cache.nix", "stale module\n")

        updates = self.boundary(task="2")

        self.assertEqual(updates["boundary_status"], "reverted")
        self.assertEqual(updates["boundary_protected"], "flake.nix")
        self.assertEqual(self.read("flake.nix"), "task flake\n")
        self.assertEqual(
            self.read("configurations/common-darwin/local-binary-cache.nix"),
            "original module\n",
        )

    def test_keeps_flake_input_output_and_check_edits_the_task_delivers(self):
        for task, content in (
            ("7", "task input\n"),
            ("8", "task outputs\n"),
            ("9", "task wiring check\n"),
            ("10", "task named failure\n"),
        ):
            self.write("flake.nix", content)

            updates = self.boundary(task=task)

            self.assertEqual(updates["boundary_status"], "claimed", task)
            self.assertEqual(updates["boundary_protected"], "flake.nix", task)
            self.assertEqual(updates["boundary_reverted"], "", task)
            self.assertEqual(self.read("flake.nix"), content, task)

    def test_reverts_flake_edits_when_the_task_only_runs_a_flake_check(self):
        self.write("flake.nix", "stale flake\n")
        self.write("flake.lock", "stale lock\n")

        updates = self.boundary(task="6")

        self.assertEqual(updates["boundary_status"], "reverted")
        self.assertEqual(updates["boundary_protected"], "")
        self.assertEqual(self.read("flake.nix"), "original flake\n")
        self.assertEqual(self.read("flake.lock"), "original lock\n")

    def test_keeps_local_binary_cache_edits_the_task_claims(self):
        self.write("configurations/personal/default.nix", "task caddy\n")
        self.write("flake.nix", "stale flake\n")

        updates = self.boundary(task="3")

        self.assertEqual(updates["boundary_status"], "reverted")
        self.assertEqual(
            updates["boundary_protected"], "configurations/personal/default.nix"
        )
        self.assertEqual(
            self.read("configurations/personal/default.nix"), "task caddy\n"
        )
        self.assertEqual(self.read("flake.nix"), "original flake\n")

    def test_keeps_shared_paths_named_in_the_task_boundary(self):
        self.write("configurations/personal/default.nix", "task personal\n")

        updates = self.boundary(task="4")

        self.assertEqual(updates["boundary_status"], "claimed")
        self.assertEqual(
            updates["boundary_protected"], "configurations/personal/default.nix"
        )
        self.assertEqual(
            self.read("configurations/personal/default.nix"), "task personal\n"
        )

    def test_keeps_shared_edits_when_the_spec_owns_the_concern(self):
        self.write("configurations/common-darwin/local-binary-cache.nix", "spec module\n")

        updates = self.boundary(task="1", spec="local-binary-cache")

        self.assertEqual(updates["boundary_status"], "claimed")
        self.assertEqual(
            updates["boundary_protected"],
            "configurations/common-darwin/local-binary-cache.nix",
        )
        self.assertEqual(
            self.read("configurations/common-darwin/local-binary-cache.nix"),
            "spec module\n",
        )

    def test_keeps_personal_host_edits_when_the_task_names_the_host(self):
        self.write("configurations/personal/default.nix", "task personal host\n")
        self.write("configurations/common-darwin/local-binary-cache.nix", "stale module\n")

        updates = self.boundary(task="5")

        self.assertEqual(updates["boundary_status"], "reverted")
        self.assertEqual(
            updates["boundary_protected"], "configurations/personal/default.nix"
        )
        self.assertEqual(
            self.read("configurations/personal/default.nix"), "task personal host\n"
        )
        self.assertEqual(
            self.read("configurations/common-darwin/local-binary-cache.nix"),
            "original module\n",
        )

    def test_leaves_task_files_outside_the_shared_paths_alone(self):
        self.write("app.txt", "task app\n")
        self.write("flake.nix", "stale flake\n")

        self.boundary()

        self.assertEqual(self.read("app.txt"), "task app\n")
        self.assertEqual(git(self.root, "diff", "--name-only"), "app.txt")

    def test_reset_reverts_shared_paths_before_the_task_starts(self):
        self.write("flake.nix", "stale flake\n")
        self.write("app.txt", "unrelated\n")

        previous = os.getcwd()
        os.chdir(self.root)
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
                io.StringIO()
            ):
                reverted = self.tools["reset"]()
        finally:
            os.chdir(previous)

        self.assertEqual(reverted, ["flake.nix"])
        self.assertEqual(self.read("flake.nix"), "original flake\n")
        self.assertEqual(self.read("app.txt"), "unrelated\n")

    def test_rejects_a_baseline_that_is_not_a_commit(self):
        with self.assertRaises(SystemExit):
            self.boundary(baseline="HEAD")


class KiroTaskBoundaryWiringTests(unittest.TestCase):
    def test_workflow_routes_implementation_through_the_boundary_gate(self):
        text = WORKFLOW.read_text()
        self.assertIn("implement -> boundary", text)
        self.assertIn("boundary -> review", text)
        self.assertNotIn("implement -> review", text)
        self.assertIn('stdin_source="context.baseline_sha"', text)
        self.assertIn("tools.py boundary {{ inputs.spec }} {{ inputs.task }}", text)

    def test_guard_resets_shared_paths_before_recording_the_baseline(self):
        text = WORKFLOW.read_text()
        self.assertIn("tools.py reset", text)
        self.assertIn("shared-infrastructure reset failed", text)

    def test_workflow_toml_installs_the_boundary_helper(self):
        text = WORKFLOW_TOML.read_text()
        self.assertIn("[[run.prepare.steps]]", text)
        self.assertIn("KIRO_TASK_TOOLS_PY", text)
        self.assertIn("boundary", load_boundary_tools())

    def test_prompts_share_the_shared_infrastructure_list(self):
        implement = IMPLEMENT.read_text()
        review = REVIEW.read_text()
        for path in SHARED_PATHS:
            self.assertIn(path, implement)
            self.assertIn(path, review)
        self.assertIn("Boundary gate", implement)
        self.assertIn("boundary_status", review)
        self.assertIn("boundary_protected", review)

    def test_review_prompt_rejects_a_reverted_path_the_task_delivers(self):
        text = " ".join(REVIEW.read_text().split())
        self.assertIn(
            "do reject when a path listed in `boundary_reverted` is part of the "
            "task's own deliverable",
            text,
        )


class KiroTaskSecretMaterialTests(unittest.TestCase):
    def rule(self):
        return " ".join(RULE.read_text().split())

    def test_rule_defines_wiring_verification_and_provisioning(self):
        text = RULE.read_text()
        for needle in ("**Wiring**", "**Verification**", "**Provisioning**"):
            self.assertIn(needle, text)
        self.assertIn("secret-independent", self.rule())

    def test_rule_separates_operator_provisioning_from_tasks(self):
        text = self.rule()
        self.assertIn("`## Operator Provisioning`", text)
        self.assertIn("must not contain provisioning-only tasks", text)
        self.assertIn("Every task must have a secret-independent deliverable", text)

    def test_rule_forbids_blocking_on_missing_secret_material(self):
        text = self.rule()
        self.assertIn("must not produce `BLOCKED` or `_Blocked:`", text)
        self.assertIn(
            "environment-blocked: secret-material-blocked <name> (<source>)", text
        )
        self.assertIn("`READY_FOR_REVIEW`", text)
        self.assertIn("`NEEDS_CONTEXT`", text)

    def test_rule_forbids_fabrication_and_weakened_encryption(self):
        text = self.rule()
        for needle in (
            "Never invent, guess, commit, or log a secret",
            "Never weaken SOPS recipients",
            "Placeholders only in test fixtures",
        ):
            self.assertIn(needle, text)

    def test_implement_prompt_reads_the_rule_and_does_not_block(self):
        text = IMPLEMENT.read_text()
        self.assertIn("## Secret material", text)
        self.assertIn(".kiro/settings/rules/secret-material-handling.md", text)
        flattened = " ".join(text.split())
        for needle in (
            "not an underdetermined spec",
            "Do not report `BLOCKED` or `NEEDS_CONTEXT`",
            "environment-blocked: secret-material-blocked <name> (<source>)",
            "`READY_FOR_REVIEW`",
            "`NEEDS_CONTEXT`",
            "Never invent, guess, commit, or log a secret",
        ):
            self.assertIn(needle, flattened)

    def test_review_prompt_treats_missing_secret_material_as_environment_blocked(self):
        flattened = " ".join(REVIEW.read_text().split())
        for needle in (
            ".kiro/settings/rules/secret-material-handling.md",
            "environment-blocked: secret-material-blocked <name> (<source>)",
            "environment-blocked check, not a rejection",
            "Do not decrypt stores or read secret values",
            "Reject fabricated or guessed values",
            "disabled encryption",
        ):
            self.assertIn(needle, flattened)

    def test_blocked_prompt_never_marks_missing_secret_material(self):
        text = BLOCKED.read_text()
        self.assertIn("## Missing secret material", text)
        flattened = " ".join(text.split())
        self.assertIn("Never append `_Blocked:`", flattened)
        self.assertIn(
            "environment-blocked: secret-material-blocked <name> (<source>)", flattened
        )
        self.assertIn("report the routing error without editing `tasks.md`", flattened)


if __name__ == "__main__":
    unittest.main()
