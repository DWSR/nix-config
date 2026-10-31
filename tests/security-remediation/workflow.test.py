import pathlib
import subprocess
import tempfile
import tomllib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
PACKAGE = ROOT / ".fabro" / "workflows" / "security-remediation"
WORKFLOW_TOML = PACKAGE / "workflow.toml"
MARKER = "SECURITY_REMEDIATION_TOOLS_PY"
HELPER_PATH = ".git/security-remediation-scripts/tools.py"


def load_config() -> dict:
    with WORKFLOW_TOML.open("rb") as handle:
        return tomllib.load(handle)


def helper_step() -> str:
    """Return the prepare step script that writes the embedded helper."""
    steps = load_config()["run"]["prepare"]["steps"]
    return next(step["script"] for step in steps if MARKER in step["script"])


def helper_source() -> str:
    text = helper_step()
    opening = "cat > %s <<'%s'\n" % (HELPER_PATH, MARKER)
    return text.split(opening, 1)[1].split("\n%s\n" % MARKER, 1)[0]


class SecurityRemediationPackageTests(unittest.TestCase):
    def test_run_inputs_declare_only_the_finding(self):
        config = load_config()
        self.assertEqual(config["run"]["inputs"], {"finding": ""})

    def test_permissions_allow_publishing_and_alert_reads_only(self):
        permissions = load_config()["run"]["integrations"]["github"]["permissions"]
        self.assertEqual(permissions, {
            "contents": "write",
            "pull_requests": "write",
            "vulnerability_alerts": "read",
            "security_events": "read",
        })
        self.assertNotIn("issues", permissions)

    def test_history_rewriting_side_channels_are_disabled(self):
        run = load_config()["run"]
        self.assertEqual(run["run_branch"], {"enabled": False})
        self.assertEqual(run["pull_request"], {"enabled": False})
        self.assertNotIn("clone", run)

    def test_model_fallbacks_mirror_the_dependabot_package(self):
        config = load_config()
        self.assertEqual(
            config["run"]["model"]["fallbacks"],
            {"gpt-6-luna": ["litellm:deepseek-v4.1-flash"]},
        )

    def test_prepare_step_writes_and_compiles_the_helper(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(
                ["bash", "-c", helper_step()],
                cwd=tmp,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            helper = pathlib.Path(tmp) / HELPER_PATH
            self.assertTrue(helper.is_file(), "prepare step did not write %s" % HELPER_PATH)
            self.assertEqual(helper.read_text().strip(), helper_source().strip())

    def test_helper_exposes_the_shared_entry_point(self):
        namespace: dict = {"__name__": "security_remediation_tools_test"}
        exec(compile(helper_source(), str(WORKFLOW_TOML), "exec"), namespace)
        for name in ("run", "load_state", "save_state", "api", "gh", "origin_repo", "emit", "main"):
            self.assertTrue(callable(namespace[name]), "%s is not callable" % name)
        self.assertEqual(namespace["STATE_PATH"], ".git/security-remediation-state.json")


if __name__ == "__main__":
    unittest.main()
