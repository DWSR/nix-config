import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
PROMPTS = ROOT / ".fabro/workflows/kiro-task/prompts"
REVIEW = PROMPTS / "review.md"
IMPLEMENT = PROMPTS / "implement.md"


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


if __name__ == "__main__":
    unittest.main()
