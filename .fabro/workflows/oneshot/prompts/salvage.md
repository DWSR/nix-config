# Oneshot Triage Salvager

A failure-triage issue could not be completed or approved, but the workflow can still
publish its narrow in-repository mitigation as a draft pull request. Use the investigation
already recorded by the implementer or reviewer; do not claim the mitigation resolves
external work. For network/environment failures, do not pretend to have inspected inaccessible
run evidence; identify missing verification and salvage only when the in-repository mitigation
is independently supported and safe.

## Inputs

- Issue and evidence: `.git/oneshot-issue.md`.
- Run state: `.git/oneshot-state.json`; `issue_mode` must be `triage`.
- Prior result: `impl_summary`, `impl_blocker`, `verdict`, `review_findings`, and
  `review_remediation` in the run context.
- Current changes: inspect `git diff <baseline_sha>` and verify an in-repository mitigation
  exists. Do not publish empty changes or a change that failed review for an unsafe defect.

## What to do

1. Reconcile the cited run/evidence with the prior investigation. A BLOCKED implementation
   has already had a triage recovery attempt; do not make further code changes. Explain why
   the recovery found no safe in-repo mitigation and document external actions still required.
   A rejected review is salvageable only when the change is safe to publish despite the
   blocking external/context gap; do not conceal or contradict the review finding.
2. Verify `git diff <baseline_sha>` contains a real in-repository mitigation and is under the
   1000-line limit. Do not publish empty changes or a change with an unresolved unsafe defect.
3. Ensure `.git/oneshot-publish.json` contains one JSON object with a Conventional Commits
   title and a short markdown summary containing `## Findings` and
   `## Remaining external work`. Findings must cite the evidence actually inspected; external
   work must be explicit, or say `None identified.`
4. Return success with `impl_status` `READY` and a concise `impl_summary` describing the draft
   mitigation and remaining work. The workflow publishes it as a draft PR that closes the
   issue and includes the summary.

Do not create git commits or report a PR-ready/approved change. Modify source only when adding
an otherwise missing safe mitigation. If there is no in-repo mitigation to publish or evidence
does not support a safe draft, return BLOCKED with the precise reason instead of sending an
empty or unsafe PR.

## Final response

End your response with exactly one JSON object; nothing after it. Keep values single-line
JSON strings and escape embedded quotes and newlines.

On success:

{"outcome":"succeeded","context_updates":{"impl_status":"READY","impl_summary":"<one-line draft summary>","impl_files_changed":"<comma-separated paths>","impl_tests_run":"<validation already run and final results>","impl_concerns":"<remaining external work>"}}

When no safe mitigation exists:

{"outcome":"failed","failure_reason":"<precise reason>","context_updates":{"impl_status":"BLOCKED","impl_blocker":"<what prevents safe publication>"}}
