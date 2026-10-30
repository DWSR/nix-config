# Research: GitHub security-alert APIs, App permissions, and Fabro primitives

External facts this design depends on. Everything below was read from the cited
sources or from this repository; nothing is inferred from memory. Repository
references are given as `path:line` at the time of writing.

## 1. Alert listing endpoints

### Dependabot alerts

Source: <https://docs.github.com/en/rest/dependabot/alerts> (API version
`2026-03-10`, the version already used by every workflow in this repository).

`GET /repos/{owner}/{repo}/dependabot/alerts`

- Query parameters used here: `state=open`, `per_page` (max 100), `page`.
  `state` accepts a comma-separated list of `auto_dismissed`, `dismissed`,
  `fixed`, `open`; `sort` accepts `created`, `updated`, `epss_percentage`;
  `direction` accepts `asc`, `desc`.
- Response fields used here:
  - `number` (integer, repo-scoped), `state`
    (`auto_dismissed|dismissed|fixed|open`), `html_url`, `url`,
    `created_at`, `updated_at`, `fixed_at`, `auto_dismissed_at`.
  - `dependency.package.ecosystem`, `dependency.package.name`,
    `dependency.manifest_path`, `dependency.scope`,
    `dependency.relationship`.
  - `security_advisory.ghsa_id`, `.cve_id`, `.summary`, `.description`,
    `.severity`, `.vulnerabilities[].vulnerable_version_range`,
    `.vulnerabilities[].first_patched_version.identifier`.
  - `security_vulnerability.severity`,
    `.vulnerable_version_range`, `.first_patched_version.identifier`.
- Status codes: `200`, `304`, `403`, `404`, `422`.
- Documented auth note: OAuth/PAT callers need the `security_events` scope
  (or `public_repo` for public repositories only).

`GET /repos/{owner}/{repo}/dependabot/alerts/{alert_number}` returns the same
object plus `403`/`404`/`410`. `410` is documented as "Gone" (alert deleted).

### Code scanning alerts

Source: <https://docs.github.com/en/rest/code-scanning/code-scanning>

`GET /repos/{owner}/{repo}/code-scanning/alerts`

- Query parameters used here: `state` (`open|closed|dismissed|fixed`),
  `per_page` (max 100), `page`; `sort` (`created|updated`), `direction`
  (`asc|desc`).
- Response fields used here:
  - `number`, `state`, `html_url`, `url`, `created_at`, `updated_at`,
    `fixed_at`.
  - `rule.id`, `.name`, `.description`, `.severity`
    (`none|note|warning|error`), `.security_severity_level`
    (`low|medium|high|critical`), `.help_uri`.
  - `tool.name`, `tool.version`.
  - `most_recent_instance.ref`, `.commit_sha`, `.message.text`,
    `.location.path`, `.start_line`, `.end_line`.
- The list endpoint documents that `most_recent_instance` describes "the
  default branch (or for the specified Git reference if you used `ref`)".
- Status codes: `200`, `304`, `403` ("GitHub Advanced Security is not enabled
  for this repository"), `404`, `503`. `GET .../alerts/{alert_number}` adds
  `410`.

Consequence for the spec: an unreadable or not-enabled source surfaces as
`403`/`404`/`503`; requirement 1.5 makes the scan fail and name the source,
so the error path must not silently treat these as "no alerts".

### Secret scanning (explicitly out of scope)

`GET /repos/{owner}/{repo}/secret-scanning/alerts` is never called. Requirement
1.4 is enforced structurally: the dispatch helper only knows the two sources
above.

## 2. GitHub App permissions and Fabro's permission map

### GitHub App permission names

Source: <https://docs.github.com/en/rest/apps/apps> ("Create an installation
access token for an app" → `permissions` object).

- `vulnerability_alerts` — "The level of permission to grant the access token
  to manage Dependabot alerts." Values `read`, `write`.
- `security_events` — "The level of permission to grant the access token to
  view and manage security events like code scanning alerts." Values `read`,
  `write`.
- `secret_scanning_alerts` exists too, and is intentionally not requested.

### Fabro mapping

Source: <https://docs.fabro.sh/execution/run-configuration> and
<https://docs.fabro.sh/integrations/github>.

- `[run.integrations.github.permissions]` values "map directly to GitHub App
  permission names and access levels", and Fabro mints a scoped installation
  token with exactly the requested set.
- Fabro's installer manifest requests Contents (write), Metadata (read),
  Pull requests (write), Checks (write), Issues (write), Emails (read),
  **Dependabot alerts (write)**, Organization projects (write), Packages
  (read). It does **not** request Code scanning alerts.
- The upper bound on what can be minted is the installed App's granted
  permissions; a permission the App lacks makes token scoping fail.

Consequence: `vulnerability_alerts = "read"` works with the current App, while
`security_events = "read"` requires adding "Code scanning alerts: Read" to the
Fabro GitHub App and approving the permission update on the installation
before deploying this change. This is a deployment prerequisite, not a code
change (see design "Migration Strategy").

### API bridge allowlist in this repository

`configurations/fabro-vm/api-bridge/src/main.rs:571` rejects a create request
whose **caller** workflow slug is not in `allowed_slugs`; `main.rs:487` only
accepts a `workflow_version_id` whose value equals one of the configured
variables. The env lists come from
`configurations/fabro-vm/default.nix` (`services.fabro-api-bridge`), which
already allows the caller slug `dispatch` and the four pinned child variables:

```
allowedWorkflowSlugs = [ "dispatch" "kiro-impl" ];
allowedVersionVariables = [
  "kiro_spec_workflow_version"
  "oneshot_workflow_version"
  "dependabot_workflow_version"
  "kiro_task_workflow_version"
];
```

So a new child needs only `security_remediation_workflow_version` added to
`allowedVersionVariables`; the caller slug `dispatch` is already allowed and a
child's own slug is not checked.

## 3. Dependabot alert ↔ pull-request association

No field in the Dependabot alerts REST objects links an alert to a pull
request (checked against the response schema in §1: there is no `pull_request`
or `linked_pull_requests` member; code scanning alerts do expose
`linked_pull_requests` on the single-alert endpoint, Dependabot alerts do not).

Requirement 3.5 therefore needs a local rule. The design's rule is to treat an
open `dependabot[bot]` pull request whose title or body mentions the alert's
`dependency.package.name` as a whole package token as claiming that alert.
Rationale:

- Dependabot PR titles are `Bump <name> from <a> to <b>` (grouped PRs list the
  packages in the body), so the package name is present in both shapes.
- Any such PR that reaches the fixed version closes the alert on merge, so
  handing the finding to the `dependabot` workflow is never wrong for the
  repository's security posture; at worst the remediation run waits.
- A package-token boundary (`[A-Za-z0-9._@/-]` on both sides) keeps
  `lodash` from matching `lodash-es`.

Limitation: a Dependabot PR that bumps a *different* package whose name is a
substring of the alert's package (for example `foo` vs `foo-bar`) does not
claim the alert; that is the safe direction (an extra remediation PR is
possible, a hidden vulnerability is not).

## 4. Alert closure after the fix lands

- Code scanning alert status "only reflect[s] the state of the alert on the
  default branch" (<https://docs.github.com/en/code-security/concepts/code-scanning/code-scanning-alerts>),
  so closure follows the next default-branch analysis performed by the
  repository's existing CodeQL configuration (`.github/workflows/codeql.yml`
  scans `main` for `actions`, `go`, `javascript-typescript`, `python`,
  `rust`).
- Dependabot alerts expose `fixed_at` and `auto_dismissed_at`, and the list
  endpoint filters by `state=open`; a fixed alert therefore disappears from
  the dispatch scan without any write from this feature. Requirement 3.7 and
  7.1 rely on that.
- Neither endpoint needs a write to close an alert, which matches requirement
  7.2.

## 5. Fabro primitives used by the design

Read from this repository and
<https://docs.fabro.sh/reference/dot-language> / `home-manager/common/skills/fabro-workflow/REFERENCE.md`:

- `script` attributes support only simple value substitution
  (`{{ inputs.X }}`, `{{ vars.X }}`); conditions and `label` are literal text.
- Command nodes must declare `shape=parallelogram`; agent nodes take
  `prompt`, `model`, `provider`, `reasoning_effort`, `max_visits`,
  `retry_policy`, `max_retries`.
- Fabro checks every goal gate when a run reaches exit; a gate that is not
  visited fails the run (`tests/dispatch/goal-gates.test.py`). Only `prepare`
  may be a goal gate in the new graph.
- A failed stage with the default `on_failure="route"` routes along its edge
  and can end the run as a success; the `fail` node therefore needs
  `on_failure="exit"` (see the comment block in
  `.fabro/workflows/dispatch/workflow.fabro:59-63`).
- Context values are strings (`"true"`, `"false"`, decimal counters), and
  `context_updates` accumulate across stages.
- `[[run.prepare.steps]]` embeds helper scripts into the package because
  sandboxes cannot fetch them (`.fabro/workflows/dispatch/workflow.toml:21-25`,
  `.fabro/workflows/dependabot/workflow.toml:34-38`).
- `[run.run_branch] enabled = false` disables Fabro's checkpoint commits;
  checkpoint commits run `git add -A` + `git commit` on the current HEAD and
  would break the single-commit invariant
  (`.fabro/workflows/dependabot/workflow.toml:25-29`).
- Settings in `[run.integrations]`, `[run.run_branch]` and
  `[run.pull_request]` are ignored by offline `fabro validate`
  (`docs/fabro-workflows.md:28-31`), so they are validated only by
  `fabro preflight` on a machine with the Fabro CLI.
- Agent rate-limit failures surface as `outcome=failed` with
  `context.failure_class` containing `rate_limit`; both existing agent
  workflows route them to a `sleep 300` wait node with `max_visits=3`
  (`.fabro/workflows/dependabot/workflow.fabro:133-146`).

## 6. Open questions resolved by the brief or requirements

- Prioritization by severity: out of scope (brief "Approach", requirement 2.3-2.5).
- Whether a repository without code scanning must fail the scan: requirement
  1.5 answers yes for unreadable sources; the operational fix is enabling the
  feature, not special-casing the error.
- Whether the run may dismiss or comment on an alert: no (requirements 6 and 7).
