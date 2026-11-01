import pathlib
import unittest
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW_TOML = ROOT / ".fabro/workflows/dispatch/workflow.toml"
MARKER = "cat > .git/dispatch-security-scan.py <<'DISPATCH_SECURITY_SCAN_PY'\n"

REPO = "DWSR/nix-config"


def load_scan() -> dict[str, Any]:
    """Extract the embedded helper between its markers and execute it."""
    text = WORKFLOW_TOML.read_text()
    script = text.split(MARKER, 1)[1].split("\nDISPATCH_SECURITY_SCAN_PY", 1)[0]
    namespace: dict[str, Any] = {"__name__": "dispatch_security_scan_test"}
    exec(compile(script, str(WORKFLOW_TOML), "exec"), namespace)
    return namespace


def dependabot_alert(number: int, package: str = "lodash") -> dict[str, Any]:
    return {
        "number": number,
        "html_url": "https://example.test/dependabot/%d" % number,
        "security_advisory": {"summary": "Advisory for %s" % package},
        "dependency": {"package": {"name": package}},
    }


def code_scanning_alert(number: int, rule_id: str = "py/sql-injection") -> dict[str, Any]:
    return {
        "number": number,
        "html_url": "https://example.test/code-scanning/%d" % number,
        "rule": {"id": rule_id, "description": "SQL injection"},
        "most_recent_instance": {"message": {"text": "query built from user input"}},
    }


def pull(
    number: int,
    head_ref: str,
    author: str = "someone",
    title: str = "",
    body: str = "",
) -> dict[str, Any]:
    return {
        "number": number,
        "head": {"ref": head_ref},
        "user": {"login": author},
        "title": title,
        "body": body,
    }


class FakeRequest:
    """Records every call and serves canned alert and pull pages."""

    def __init__(
        self,
        dependabot: list[dict[str, Any]] | None = None,
        code_scanning: list[dict[str, Any]] | None = None,
        pulls: list[dict[str, Any]] | None = None,
        failures: set[str] | None = None,
        dependabot_after: list[dict[str, Any]] | None = None,
        dependabot_next: str | None = None,
    ) -> None:
        self.dependabot = list(dependabot or [])
        self.code_scanning = list(code_scanning or [])
        self.pulls = list(pulls or [])
        self.failures = set(failures or ())
        self.dependabot_after = dependabot_after
        self.dependabot_next = dependabot_next
        self.calls: list[tuple[str, str]] = []

    def __call__(
        self, method: str, path: str, with_headers: bool = False
    ) -> list[dict[str, Any]] | tuple[list[dict[str, Any]], dict[str, str]]:
        self.calls.append((method, path))
        headers: dict[str, str] = {}
        if "/dependabot/alerts" in path:
            if "dependabot" in self.failures:
                raise SystemExit("GitHub API GET %s failed: HTTP 500" % path)
            if "after=" in path and self.dependabot_after is not None:
                body = self.dependabot_after
            else:
                body = self.dependabot
                if self.dependabot_next:
                    headers["link"] = '<%s>; rel="next"' % self.dependabot_next
        elif "/code-scanning/alerts" in path:
            if "code-scanning" in self.failures:
                raise SystemExit("GitHub API GET %s failed: HTTP 500" % path)
            body = self.code_scanning
        elif "/pulls?" in path:
            body = self.pulls
        else:
            raise AssertionError("unexpected request: %s %s" % (method, path))
        return (body, headers) if with_headers else body


class SecurityScanSelectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scan = load_scan()

    def run_scan(
        self,
        dependabot: list[dict[str, Any]] | None = None,
        code_scanning: list[dict[str, Any]] | None = None,
        pulls: list[dict[str, Any]] | None = None,
        runs: list[dict[str, Any]] | None = None,
        failures: set[str] | None = None,
        **kwargs: Any,
    ) -> tuple[dict[str, Any], FakeRequest]:
        request = FakeRequest(dependabot, code_scanning, pulls, failures, **kwargs)
        return self.scan["scan"](REPO, request, runs or []), request

    def test_dependabot_wins_even_with_a_higher_alert_number(self):
        result, _request = self.run_scan(
            dependabot=[dependabot_alert(9)],
            code_scanning=[code_scanning_alert(1)],
        )

        remediation = result["remediation"]
        self.assertEqual(remediation["eligible"], ["dependabot:9", "code-scanning:1"])
        self.assertEqual(remediation["selected"]["source"], "dependabot")
        self.assertEqual(remediation["selected"]["number"], 9)
        # Exactly one finding is selected, and it is the first eligible one.
        self.assertEqual(
            "%s:%d" % (remediation["selected"]["source"], remediation["selected"]["number"]),
            remediation["eligible"][0],
        )

    def test_lowest_number_wins_within_a_source(self):
        result, _request = self.run_scan(
            code_scanning=[code_scanning_alert(45), code_scanning_alert(7)],
        )

        self.assertEqual(result["remediation"]["selected"]["number"], 7)

    def test_dependabot_alerts_follow_cursor_pagination(self):
        next_url = (
            "https://api.github.com/repos/%s/dependabot/alerts"
            "?state=open&per_page=100&after=CURSOR" % REPO
        )

        result, request = self.run_scan(
            dependabot=[dependabot_alert(9)],
            dependabot_after=[dependabot_alert(3)],
            dependabot_next=next_url,
        )

        dependabot_paths = [
            path for _method, path in request.calls if "/dependabot/alerts" in path
        ]
        self.assertEqual(len(dependabot_paths), 2)
        self.assertNotRegex(dependabot_paths[0], r"[?&]page=")
        self.assertIn("after=CURSOR", dependabot_paths[1])
        self.assertEqual([finding["number"] for finding in result["findings"]], [3, 9])

    def test_repeated_scan_over_unchanged_input_selects_the_same_finding(self):
        alerts = [dependabot_alert(9), dependabot_alert(3)]

        first, first_request = self.run_scan(dependabot=alerts)
        second, second_request = self.run_scan(dependabot=list(reversed(alerts)))

        self.assertEqual(first["findings"], second["findings"])
        self.assertEqual(
            first["remediation"]["selected"],
            second["remediation"]["selected"],
        )
        self.assertEqual(first["remediation"]["selected"]["number"], 3)
        for request in (first_request, second_request):
            self.assertEqual({method for method, _path in request.calls}, {"GET"})
            for _method, path in request.calls:
                self.assertRegex(path, r"[?&]state=open(&|$)")

    def test_empty_findings_select_nothing(self):
        result, _request = self.run_scan()

        self.assertEqual(result["findings"], [])
        self.assertIsNone(result["remediation"]["selected"])
        self.assertEqual(result["remediation"]["eligible"], [])
        self.assertEqual(result["remediation"]["excluded"], [])
        self.assertIsNone(result["remediation"]["active_run"])


class SecurityScanExclusionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scan = load_scan()

    def run_scan(self, **kwargs: Any) -> tuple[dict[str, Any], FakeRequest]:
        runs = kwargs.pop("runs", None) or []
        request = FakeRequest(**kwargs)
        return self.scan["scan"](REPO, request, runs), request

    def test_open_remediation_pull_request_excludes_the_finding(self):
        result, _request = self.run_scan(
            dependabot=[dependabot_alert(12)],
            code_scanning=[code_scanning_alert(45)],
            pulls=[
                pull(31, "security/dependabot-12"),
                pull(32, "security/code-scanning-45"),
            ],
        )

        remediation = result["remediation"]
        self.assertEqual(remediation["excluded"], [
            {"source": "dependabot", "number": 12, "reason": "remediation_pr_open"},
            {"source": "code-scanning", "number": 45, "reason": "remediation_pr_open"},
        ])
        self.assertEqual(remediation["eligible"], [])
        self.assertIsNone(remediation["selected"])

    def test_open_dependabot_pr_excludes_the_package_finding(self):
        result, _request = self.run_scan(
            dependabot=[dependabot_alert(12, package="lodash")],
            pulls=[
                pull(
                    41,
                    "dependabot/npm_and_yarn/lodash-4.17.21",
                    author="dependabot[bot]",
                    title="Bump lodash from 4.17.19 to 4.17.21",
                )
            ],
        )

        remediation = result["remediation"]
        self.assertEqual(remediation["excluded"], [
            {"source": "dependabot", "number": 12, "reason": "dependabot_pr_open"},
        ])
        self.assertEqual(remediation["eligible"], [])
        self.assertIsNone(remediation["selected"])

    def test_dependabot_pr_for_a_similar_package_name_does_not_exclude(self):
        result, _request = self.run_scan(
            dependabot=[dependabot_alert(12, package="lodash")],
            pulls=[
                pull(
                    41,
                    "dependabot/npm_and_yarn/lodash-es-4.17.21",
                    author="dependabot[bot]",
                    title="Bump lodash-es from 4.17.21 to 4.17.22",
                    body="Supersedes lodash-es advisories.",
                ),
                pull(42, "topic/lodash-cleanup", author="someone", title="Clean up lodash usage"),
            ],
        )

        self.assertEqual(result["remediation"]["excluded"], [])
        self.assertEqual(result["remediation"]["selected"]["number"], 12)

    def test_exclusions_follow_the_sorted_finding_order(self):
        result, _request = self.run_scan(
            dependabot=[
                dependabot_alert(12, package="lodash"),
                dependabot_alert(5, package="minimist"),
            ],
            code_scanning=[code_scanning_alert(2)],
            pulls=[
                pull(
                    40,
                    "dependabot/npm_and_yarn/minimist-1.2.6",
                    author="dependabot[bot]",
                    title="Bump minimist from 1.2.5 to 1.2.6",
                ),
                pull(41, "security/code-scanning-2"),
            ],
        )

        self.assertEqual(
            [finding["number"] for finding in result["findings"]],
            [5, 12, 2],
        )
        self.assertEqual(result["remediation"]["excluded"], [
            {"source": "dependabot", "number": 5, "reason": "dependabot_pr_open"},
            {"source": "code-scanning", "number": 2, "reason": "remediation_pr_open"},
        ])
        self.assertEqual(result["remediation"]["eligible"], ["dependabot:12"])
        self.assertEqual(result["remediation"]["selected"]["number"], 12)

    def test_active_remediation_run_is_reported_for_the_matching_repository(self):
        runs = [{
            "id": "01SECURITY",
            "workflow": {"slug": "security-remediation"},
            "repository": {"name": "dwsr/nix-config"},
        }]

        result, _request = self.run_scan(dependabot=[dependabot_alert(12)], runs=runs)

        # The active run is the serialization gate the match stage reads; the scan still
        # reports the finding it would otherwise select.
        self.assertEqual(result["remediation"]["active_run"], "01SECURITY")
        self.assertEqual(result["remediation"]["selected"]["number"], 12)

    def test_active_run_for_another_workflow_or_repository_is_ignored(self):
        runs = [
            {"id": "01DEP", "workflow": {"slug": "dependabot"}, "repository": {"name": REPO}},
            {
                "id": "01OTHER",
                "workflow": {"slug": "security-remediation"},
                "repository": {"name": "other/repo"},
            },
        ]

        result, _request = self.run_scan(dependabot=[dependabot_alert(12)], runs=runs)

        self.assertIsNone(result["remediation"]["active_run"])


class SecurityScanFailureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scan = load_scan()

    def test_unreadable_dependabot_source_fails_naming_the_source(self):
        request = FakeRequest(
            dependabot=[dependabot_alert(12)],
            failures={"dependabot"},
        )

        with self.assertRaises(SystemExit) as caught:
            self.scan["scan"](REPO, request, [])

        message = str(caught.exception.code)
        self.assertIn("dispatch scan: dependabot alerts could not be read", message)
        self.assertIn("HTTP 500", message)
        self.assertNotIn("code-scanning", message)
        # No PR listing ran, so no finding could have been selected.
        self.assertEqual([path for _method, path in request.calls if "/pulls?" in path], [])

    def test_unreadable_code_scanning_source_fails_naming_the_source(self):
        request = FakeRequest(
            code_scanning=[code_scanning_alert(45)],
            failures={"code-scanning"},
        )

        with self.assertRaises(SystemExit) as caught:
            self.scan["scan"](REPO, request, [])

        message = str(caught.exception.code)
        self.assertIn("dispatch scan: code-scanning alerts could not be read", message)
        self.assertIn("HTTP 500", message)
        self.assertEqual([path for _method, path in request.calls if "/pulls?" in path], [])


class SecurityScanSourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scan = load_scan()

    def test_secret_scanning_is_never_requested(self):
        request = FakeRequest(
            dependabot=[dependabot_alert(12)],
            code_scanning=[code_scanning_alert(45)],
        )

        result = self.scan["scan"](REPO, request, [])

        paths = [path for _method, path in request.calls]
        self.assertFalse([path for path in paths if "secret" in path.lower()])
        self.assertEqual(
            [path.split("?", 1)[0] for path in paths],
            [
                "/repos/%s/dependabot/alerts" % REPO,
                "/repos/%s/code-scanning/alerts" % REPO,
                "/repos/%s/pulls" % REPO,
            ],
        )
        self.assertEqual({method for method, _path in request.calls}, {"GET"})
        self.assertEqual(result["remediation"]["selected"]["source"], "dependabot")


if __name__ == "__main__":
    unittest.main()
