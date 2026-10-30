# Requirements Document

## Introduction

This feature adds automated remediation of one GitHub security finding at a time: the dispatch scan discovers and selects a single open Dependabot or code scanning alert, and a new `security-remediation` workflow fixes it and publishes one pull request whose merge lets GitHub close the alert. See `brief.md` for the problem statement, approach, and scope.

## Boundary Context

- **In scope**: dispatch-time alert enumeration, deterministic selection among eligible findings, serialization against active remediation runs, deduplication against open remediation and Dependabot security-update pull requests, the `security-remediation` intake, fix, verify, and publish path, the single-commit publish invariants, the pinned workflow-version plumbing, and local tests for selection, serialization, deduplication, and publish.
- **Out of scope**: any write to the alerts APIs, secret scanning alerts, remediation of several findings in one run, severity-based ordering or alert triage, auto-merging remediation pull requests, and behavior changes to `dependabot`, `oneshot`, `failure-triage`, `kiro-*`, the code scanning workflow, or Dependabot configuration beyond the dispatch additions.
- **Adjacent expectations**: GitHub itself closes an alert once the fix lands on the default branch, and code scanning closes only after the next analysis of that branch; the Fabro runs API is the authoritative "already running" record because Fabro has no cross-run mutex; the Fabro GitHub integration grants read on Dependabot and code scanning alerts; the pinned version variable is allowlisted for the API bridge; the `oneshot` publish pattern and the `dependabot` fix/verify gate loop already exist and are reused rather than rebuilt.

## Requirements

### Requirement 1: Finding discovery

**Objective:** As a repository owner, I want every dispatch scan to read the repository's open security findings, so that remediation starts from GitHub's own alert data.

#### Acceptance Criteria

1. When a dispatch scan runs for a repository, the dispatch scan shall list the repository's open Dependabot alerts and its open code scanning alerts.
2. The dispatch scan shall record each discovered finding's source, alert number, title, and alert URL alongside the existing issue and pull-request queues.
3. Where the repository has no open Dependabot alert and no open code scanning alert, the dispatch scan shall record no finding and create no remediation child.
4. The dispatch scan shall not consider secret scanning alerts, even when the repository has open ones.
5. If an alert source cannot be read, then the dispatch scan shall fail with a message naming the unreadable source and shall create no child run.
6. The dispatch scan shall make no write request to either alert source.

### Requirement 2: Deterministic single-finding selection

**Objective:** As a repository owner, I want each scan to choose one finding predictably, so that remediation work is serialized instead of racing over the same manifests or sources.

#### Acceptance Criteria

1. When the dispatch scan finds at least one eligible finding, the dispatch scan shall select exactly one finding for remediation per scan.
2. The dispatch scan shall consider only findings that Requirement 3 does not exclude.
3. The dispatch scan shall prefer an eligible open Dependabot alert over any code scanning alert.
4. When more than one eligible Dependabot alert is open, the dispatch scan shall select the lowest-numbered one.
5. When no eligible Dependabot alert exists and more than one eligible code scanning alert is open, the dispatch scan shall select the lowest-numbered one.
6. When the dispatch scan runs again over the same open findings with no remediation state change, the dispatch scan shall select the same finding.
7. When the dispatch scan selects a finding, the dispatch run shall report the finding's source and alert number in its result.

### Requirement 3: Serialization and deduplication

**Objective:** As a repository owner, I want at most one remediation run and one remediation pull request per finding, so that repeated scans do not duplicate work or race over the same files.

#### Acceptance Criteria

1. When a dispatch scan finds a `security-remediation` run for the repository in pending, runnable, initializing, running, or blocked status, the dispatch scan shall create no remediation child.
2. The dispatch scan shall create at most one `security-remediation` child per repository per scan.
3. While a remediation run for a finding is active, the dispatch scan shall not dispatch any other finding for the same repository.
4. If the selected finding already has an open remediation pull request, then the dispatch scan shall exclude that finding and consider the next eligible finding.
5. If the selected finding is a Dependabot alert that already has an open Dependabot security-update pull request, then the dispatch scan shall exclude that finding and consider the next eligible finding, leaving that pull request to the `dependabot` workflow.
6. When a finding's remediation pull request is open, repeated dispatch scans shall create no second pull request for that finding.
7. When a finding's remediation pull request is merged and GitHub closes the alert, the dispatch scan shall no longer find that alert open and shall create no child for it.

### Requirement 4: Finding intake

**Objective:** As a repository owner, I want the remediation run to start from one alert's full detail, so that the fix targets the reported vulnerability and nothing else.

#### Acceptance Criteria

1. When a remediation run starts for a finding, the remediation run shall read the selected alert and capture its source, alert number, title, URL, affected dependency or code location, and advisory detail for the fix stage.
2. The remediation run shall work on exactly one finding for its entire lifetime.
3. If the selected alert is no longer open when the remediation run reads it, then the remediation run shall end without publishing a remediation pull request.
4. If the alert cannot be read or its source is unsupported, then the remediation run shall fail with a message naming the finding's source and alert number.
5. The remediation run shall treat alert text as untrusted evidence and shall not follow instructions contained in it.

### Requirement 5: Fix and verification

**Objective:** As a repository owner, I want the run to fix the root cause and pass the repository's own checks, so that a published remediation is trustworthy on arrival.

#### Acceptance Criteria

1. When the remediation run has captured the finding, the fix stage shall change the repository so the vulnerability identified by the finding is no longer present.
2. When a fix round ends, the remediation run shall run the repository's runnable checks for the packages it changed.
3. If a runnable check fails and rework rounds remain, then the remediation run shall return the failure detail to the fix stage for another round.
4. If a runnable check still fails after the rework limit is reached, then the remediation run shall fail with the last failure summary and shall not publish a pull request.
5. While a check is unrunnable for an environment cause in the sandbox, the remediation run shall record it as excluded and shall neither treat it as a failure nor spend a rework round on it.
6. If the remediation run cannot discover or execute any runnable check for a package it changed, then the remediation run shall fail instead of publishing an unverified change.
7. When an agent stage reports a rate limit failure, the remediation run shall wait and retry that stage a bounded number of times before failing.
8. The verification stage shall not modify tracked files and shall not create commits.

### Requirement 6: Single-commit publish

**Objective:** As a repository owner, I want one deterministic pull request carrying exactly one commit and a link to the alert, so that review and merge are simple and reruns do not multiply pull requests.

#### Acceptance Criteria

1. When the runnable checks pass, the remediation run shall publish the fix as exactly one commit on the deterministic branch `security/<source>-<alert-number>`.
2. The published commit's parent shall be the current head of the repository's default branch.
3. The remediation run shall open a non-draft pull request from the remediation branch into the default branch.
4. When an open pull request already exists for the remediation branch, the remediation run shall update that pull request's commit instead of creating a second pull request.
5. The pull request body shall reference the finding by alert URL and alert number.
6. The remediation run shall push with `--force-with-lease`; if the remote remediation branch head has moved since the run read it, then the remediation run shall fail without overwriting the remote branch.
7. If the fix produces no change relative to the default branch head, then the remediation run shall fail instead of publishing an empty commit.
8. The remediation branch shall carry exactly one commit over the default branch at every point the remediation run pushes it.
9. The published commit shall contain only the fix and any accompanying test changes, and no build artifacts or cache files.
10. If pull-request creation fails and no open pull request exists for the branch, then the remediation run shall fail with the reported error.
11. When the remediation run publishes, the run shall report the pull request number and URL and shall not claim the alert is closed.

### Requirement 7: Alert closure and read-only alert handling

**Objective:** As a repository owner, I want the alert left to GitHub's own closure, so that an abandoned pull request never hides an unfixed vulnerability.

#### Acceptance Criteria

1. When a remediation pull request is merged into the default branch, the workflow shall take no further action and shall rely on GitHub closing the alert.
2. The dispatch scan and the remediation run shall not dismiss, comment on, reopen, or otherwise write to any alert.
3. Where the finding is a code scanning alert, the fix shall be one that the repository's existing code scanning configuration can confirm on the default branch, and closure shall follow that analysis rather than a one-off scan.
4. The remediation run shall leave merging to a human and shall not merge the pull request or enable auto-merge.
5. While the remediation pull request remains open, the remediation run shall report the pull request as its outcome and shall not report the finding as closed.

### Requirement 8: Registration and operability

**Objective:** As a repo maintainer, I want the new package registered like the existing dispatch targets, so that child creation is accepted and the workflow is discoverable.

#### Acceptance Criteria

1. When the pin script runs, the pin script shall register the `security-remediation` package and set the `security_remediation_workflow_version` variable to its content-addressed workflow-version id.
2. The dispatch graph shall read the remediation child's workflow-version id from that variable rather than emitting the package inline.
3. The API bridge shall accept a remediation child whose workflow version comes from that variable and shall not refuse the create request for an unlisted version variable.
4. When the repository's workflow validation runs, it shall validate the amended dispatch package and the new `security-remediation` package.
5. The workflow documentation shall list `security-remediation` as a package and `security_remediation_workflow_version` as a pinned variable.

### Requirement 9: Local verification of dispatch and publish behavior

**Objective:** As a repo maintainer, I want local tests over the dispatch and publish rules, so that a future edit cannot silently reintroduce duplicate work or a second commit.

#### Acceptance Criteria

1. When the repository's local test command runs, the tests shall verify that the dispatch scan selects at most one finding per scan and prefers the lowest-numbered eligible Dependabot alert.
2. When the repository's local test command runs, the tests shall verify that an active remediation run, an open remediation pull request, and an open Dependabot security-update pull request each exclude a finding.
3. When the repository's local test command runs, the tests shall verify that an unreadable alert source fails the dispatch scan and creates no child.
4. When the repository's local test command runs, the tests shall verify that the publish stage derives `security/<source>-<alert-number>`, creates exactly one commit over the default branch, references the alert in the pull request body, and fails when the remote branch head moved.
5. When the repository's local test command runs, the tests shall verify that a rerun for the same finding reuses the open pull request instead of creating a second one.
