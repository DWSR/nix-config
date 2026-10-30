# Brief: fabro-workflow-to-remediate-github-security-find

## Problem

> As a GitHub repo owner, I want a Fabro workflow that will address a single GitHub Security finding (e.g. from CodeQL or Dependabot so that known vulnerabilities can be automatically remediated.
>
> The workflow should:
>
> * work on a single finding at a time
> * create a pull request with a single commit on it
> * create a pull request with a magic comment that closes the security finding
>
> Additionally, the dispatch workflow should be amended so to dispatch at most 1 remediation workflow per repository and only a single copy of the workflow should be running for a repository at a time.

Open Dependabot and code scanning alerts accumulate because each needs a human to read the advisory,
work out the version bump or code change, open a PR, and watch CI. Dependabot security updates only
move versions and never fix a CodeQL finding, and nothing serializes the work, so remediation
attempts race over the same manifest or source file.

## Current State

- `.fabro/workflows/` holds `dependabot`, `dispatch`, `failure-triage`, `kiro-impl`, `kiro-spec`,
  `kiro-task`, and `oneshot`; each is a `workflow.fabro` graph plus `workflow.toml` (inputs, GitHub
  permissions, prepare-step helper scripts) and `prompts/*.md` (`docs/fabro-workflows.md`).
- The dispatch scanner (`dispatch/workflow.fabro:10-17`) lists only `fabro-ready` issues and failing
  Dependabot PRs; `match` (`:19-25`) routes issue type labels to `kiro-spec`/`oneshot` and every
  failing Dependabot PR to `dependabot`. No stage in the repository calls a security-alert API.
- Serialization exists only for Dependabot: the scan skips dependabot PRs while a `dependabot` run
  is active, and dispatch creates at most one dependabot child per scan (`active_dependabot_run`,
  `dependabot_dispatched`, `dispatch/workflow.fabro:48`). `kiro-spec` and `oneshot` children have
  no per-repository limit.
- `dependabot` starts from an existing Dependabot PR and amends its single commit; `oneshot` starts
  from an issue and publishes one commit built with `git commit-tree` on `origin/<trunk>`, pushed
  with `--force-with-lease`, then finds or creates the PR. Neither starts from an alert, and
  neither makes GitHub close one.
- Child runs are created through the Fabro API bridge with a pinned, content-addressed workflow
  version id (`scripts/pin-workflow-versions.sh`); the bridge only accepts slugs and variables
  allowlisted in `configurations/fabro-vm/default.nix:314-322`.
- CodeQL runs on `main` for `actions`, `go`, `javascript-typescript`, `python`, and `rust` with
  category `/language:<lang>` (`.github/workflows/codeql.yml`); Nix sources are not analyzed.

## Desired Outcome

- A dispatch scan that finds open Dependabot and code scanning alerts, chooses at most one finding,
  and creates at most one `security-remediation` child run.
- A scan that creates no child while any `security-remediation` run for that repository is pending,
  runnable, initializing, running, or blocked.
- A run that reads the alert, fixes the root cause, passes the repository's runnable checks, and
  publishes exactly one commit on a deterministic branch with an open PR against the default branch
  whose body links the alert.
- A merged PR that closes its finding without further workflow action: GitHub closes the alert once
  the fix lands on the default branch (code scanning after the next analysis).
- Repeated scans that skip findings with an open remediation PR or an active run, so a finding never
  produces a second PR.

## Approach

Extend the existing dispatcher and add one workflow package; do not build a parallel automation path.

- Add alert discovery to the dispatch scan: `GET /repos/{owner}/{repo}/dependabot/alerts?state=open`
  and `/code-scanning/alerts?state=open`, recorded in `.git/dispatch-queue.json` beside the issue
  and PR queues.
- Select one finding per scan deterministically: lowest-numbered open Dependabot alert, otherwise
  lowest-numbered open code scanning alert. Severity ordering needs a prioritization policy this
  spec does not own; one selection function lets triage replace it.
- Serialize at dispatch time from the Fabro runs API, reusing the status filter and repository match
  already used for `dependabot`; Fabro has no cross-run mutex, so the runs list is the authoritative
  "already running" check.
- Skip a finding whose remediation branch or PR is already open, and skip a Dependabot finding that
  already has an open Dependabot security-update PR — that PR belongs to the `dependabot` workflow.
- Add `.fabro/workflows/security-remediation/` with a finding-fetch prepare step writing alert
  details to a `.git/` file like `.git/kiro-spec-issue.md`, an agent fix stage, a `test` → `rework`
  → `fix` gate copied from `dependabot`, and a publish stage copied from `oneshot`.
- Put the alert URL and number in the PR body as the reference tying the PR to the finding; never
  dismiss or comment on the alert. Dismissing would hide an unfixed vulnerability if the PR is
  abandoned, and GitHub's auto-close on merge already satisfies "closes the security finding".
- Register the package: a `security_remediation_workflow_version` entry in
  `scripts/pin-workflow-versions.sh`, and the variable plus dispatcher slug in the API-bridge
  allowlist so child creation is not refused with HTTP 403.

Rejected: one run handling several findings; reusing `dependabot` (its input is an existing PR this
workflow must create); a GitHub Actions workflow (dispatch, retry, and sandboxing live in Fabro).

## Scope

- **In**:
  - Dispatch scan: alert listing, one-finding selection, per-repository serialization, and
    deduplication against open remediation PRs and active runs.
  - `.fabro/workflows/security-remediation/`: inputs, permissions, prepare helper scripts, finding,
    fix, and verify prompts, graph, and publish stage.
  - Single-commit publish invariants: deterministic `security/<source>-<alert-number>` branch, parent
    `origin/<trunk>`, `--force-with-lease`, stale-push detection.
  - Pinned workflow-version variable, pin-script entry, and the API-bridge allowlist in
    `configurations/fabro-vm/default.nix`.
  - Local tests under `tests/security-remediation/` and `tests/dispatch/` covering selection,
    serialization, deduplication, and publish invariants.
- **Out**:
  - Dismissing, commenting on, or reopening alerts, and any write call to the alerts APIs.
  - Secret scanning alerts, bulk remediation of several findings, and alert prioritization or
    auto-triage rules.
  - Auto-merging remediation PRs, and changing `dependabot`, `oneshot`, `failure-triage`, `kiro-*`,
    the CodeQL workflow, or Dependabot configuration beyond the dispatch additions.

## Boundary Candidates

- **Dispatch scan and selection**: alert enumeration, deterministic choice, active-run check,
  open-PR deduplication, and the queue/plan/result file contract.
- **Finding intake and fix loop**: alert fetch and rendering, agent prompts, verify gate, and
  failure handling for rate limits and rejected fixes.
- **Publish**: single-commit construction, branch naming, push safety, and PR body linkage.
- **Registration plumbing**: pinned variable, pin script, bridge allowlist, and workflow docs.

## Out of Boundary

- Alert lifecycle management beyond leaving alerts to GitHub's own closure.
- Security policy, advisory triage, severity-driven ordering, and remediation SLAs.
- Non-alert security work such as secret rotation, push-protection bypasses, or dependency review.

## Upstream / Downstream

- **Upstream**: GitHub REST alerts endpoints (API version `2026-03-10`), the Fabro API bridge and
  server variables, the dispatch scanner, `scripts/pin-workflow-versions.sh`, the CodeQL workflow on
  `main`, and the `oneshot` publish pattern.
- **Downstream**: secret-scanning remediation, auto-merge of remediation PRs, severity-based
  selection, and `failure-triage` coverage for remediation run failures.

## Existing Spec Touchpoints

- **Extends**: None.
- **Adjacent**: the `dependabot`, `oneshot`, and `dispatch` packages and their tests
  (`tests/dependabot/`, `tests/dispatch/`), which supply the gate loop, publish, and scanner
  patterns this spec reuses.

## Constraints

- The Fabro GitHub integration must grant read on Dependabot alerts and code scanning alerts, plus
  `contents: write` and `pull_requests: write`; permission keys must match what
  `[run.integrations.github]` accepts (the Actions `GITHUB_TOKEN` cannot read alerts).
- Agent sandboxes run on `aarch64-linux` while the flake exposes `aarch64-darwin` checks only; the
  verify gate must exclude darwin-only checks and platform-mismatch failures, as the `dependabot`
  prompts do (`tests/dependabot/workflow.test.py:135-155`).
- The PR must carry exactly one commit over `origin/<trunk>`; Fabro checkpoints run `git add -A` +
  `git commit` on the current head and stay disabled, as in `dependabot`.
- Branch names are deterministic so a rerun resumes the same PR; pushes use `--force-with-lease` and
  fail loudly when the remote head moved.
- Helper scripts are embedded in `[[run.prepare.steps]]` (sandboxes cannot fetch them), and
  `fabro validate` parses graphs and TOML offline on `aarch64-darwin` only.
- GitHub closes a code scanning alert only after an analysis of the default branch confirms the
  finding is gone, so the fix must be mergeable by the existing CodeQL workflow, not a one-off scan.
