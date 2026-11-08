# Oneshot Triage Recovery

The normal implementation stage returned BLOCKED on a failure-triage issue. Investigate
whether the repository can ship a narrow mitigation despite the cited external failure, then
complete it so it can receive the normal diff check and adversarial review.

## Inputs

- Issue and evidence: `.git/oneshot-issue.md` (title, body, cited run IDs and links).
- Run state: `.git/oneshot-state.json`; `issue_mode` must be `triage`.
- Prior result: `impl_summary` and `impl_blocker` from the run context.
- Repository code and existing tests. Follow repository guidance and conventions.

## What to do

1. Investigate each cited run and evidence link that is accessible. Distinguish what the
   repository controls from external cancellation, credentials, service, or operator work.
2. Implement the narrowest safe in-repository mitigation that reduces the failure's impact
   or makes recovery observable. Do not claim it completes external actions. Add tests that
   prove the behavior and run the repository's relevant checks. Do not attempt publication if
   network failure prevents you from evaluating evidence needed to justify a safe mitigation.
3. If a safe in-repository mitigation exists, write `.git/oneshot-publish.json` with a
   Conventional Commits title and markdown summary containing `## Findings` and
   `## Remaining external work`. Cite inspected evidence and state external actions or
   `None identified.`. Return success with `impl_status` `READY` so the normal diff-size gate
   and adversarial review still run.
4. Return BLOCKED only if investigation shows that no safe in-repository mitigation exists.
   State the evidence supporting that conclusion and the external action required.

Keep the diff under 1000 changed lines. Do not create commits or modify `.kiro/` state. End
with exactly one JSON object and no text after it.

On success:

{"outcome":"succeeded","context_updates":{"impl_status":"READY","impl_summary":"<one-line mitigation>","impl_files_changed":"<paths>","impl_tests_run":"<commands and results>","impl_concerns":"<remaining external work>"}}

When no in-repository mitigation exists:

{"outcome":"failed","failure_reason":"<precise reason>","context_updates":{"impl_status":"BLOCKED","impl_blocker":"<evidence and external action>"}}
