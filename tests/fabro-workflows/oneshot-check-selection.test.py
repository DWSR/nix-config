import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
PROMPT_DIR = ROOT / ".fabro" / "workflows" / "oneshot" / "prompts"


class OneshotCheckSelectionTests(unittest.TestCase):
    def test_implementer_selects_checks_by_changed_paths(self):
        prompt = (PROMPT_DIR / "implement.md").read_text()
        self.assertIn("validation from the changed paths", prompt)
        self.assertIn("python3 -m json.tool flake.lock >/dev/null", prompt)
        self.assertIn("For a lockfile-only change", prompt)
        self.assertIn("do not run `nix flake check` without `--no-build`", prompt)
        self.assertIn("nix flake check --no-build", prompt)
        self.assertIn("`actionlint`", prompt)
        self.assertIn("tests/dependency-cooldown/cooldown.test.py", prompt)
        self.assertIn("nix develop --command prek run --all-files", prompt)
        self.assertIn("full `nix flake check`", prompt)
        self.assertIn("input declarations alone do not count", prompt)
        self.assertIn("`.fabro/workflows/**/workflow.fabro`", prompt)
        self.assertIn("Apply every matching path rule", prompt)
        self.assertIn("Always run `git diff --check`", prompt)
        # The original unconditional full-suite policy could not pass this regression.
        self.assertNotIn("run them. Never claim a test passed", prompt)

    def test_reviewer_records_selected_checks_and_reasons(self):
        prompt = (PROMPT_DIR / "review.md").read_text()
        self.assertIn("select checks from the changed paths", prompt)
        self.assertIn("python3 -m json.tool flake.lock >/dev/null", prompt)
        self.assertIn("For a lockfile-only change", prompt)
        self.assertIn("do not run `nix flake check` without `--no-build`", prompt)
        self.assertIn("nix flake check --no-build", prompt)
        self.assertIn("`actionlint`", prompt)
        self.assertIn("tests/dependency-cooldown/cooldown.test.py", prompt)
        self.assertIn("nix develop --command prek run --all-files", prompt)
        self.assertIn("input declarations alone do not count", prompt)
        self.assertIn("`.fabro/workflows/**/workflow.fabro`", prompt)
        self.assertIn("Apply every matching path", prompt)
        self.assertIn("review_mechanical", prompt)
        self.assertIn("reason that selected it", prompt)
        self.assertIn("Always run `git diff --check`", prompt)

    def test_path_rules_preserve_lockfile_only_fast_path(self):
        required_paths = (
            "flake.lock",
            "flake.nix",
            ".github/workflows/**",
            "tests/**",
            "scripts/**",
            ".fabro/workflows/**/workflow.fabro",
        )
        for path in required_paths:
            with self.subTest(path=path):
                self.assertIn(path, (PROMPT_DIR / "implement.md").read_text())
                self.assertIn(path, (PROMPT_DIR / "review.md").read_text())

    def test_lockfile_only_rule_precedes_full_check_rule(self):
        for filename in ("implement.md", "review.md"):
            prompt = (PROMPT_DIR / filename).read_text()
            self.assertLess(
                prompt.index("For a lockfile-only change"),
                prompt.index("Run full `nix flake check`"),
            )


if __name__ == "__main__":
    unittest.main()
