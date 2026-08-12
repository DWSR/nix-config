---
name: binks-pr-review
description: Run Shopify's local binks-pr-review against the current worktree and triage its findings. Use only when the user invokes /binks-review, explicitly requests a local Binks review, or explicitly asks for Binks as a pre-PR review; do not use for hosted Binks comments or on every edit.
---

# Local Binks PR Review

Run the same review graph used by hosted Binks against local changes before a
pull request is opened or updated. A run takes several minutes and consumes its
own Shopify AI proxy budget.

## Authorization

- An explicit `/binks-review` invocation authorizes one read-only local run.
- An explicit request for local or pre-PR Binks review authorizes one read-only
  local run.
- A `binks-reviewer` dispatch from the Shopify-host `kiro-review` or
  `kiro-verify-completion` protocol authorizes that dispatch's one read-only
  local run. The caller owns its per-task or per-invocation run limit.
- Otherwise, explain the time and separate model cost and ask before running.
- Never install a hook that runs Binks on every edit, commit, or push.
- Ask before rerunning after fixes unless a Shopify-host Kiro protocol dispatches
  that run under its configured per-task or per-invocation policy.
- Review authorization does not authorize edits or result upload. Fix findings
  only when the same request explicitly asks for fixes; otherwise report them.
- Result upload is disabled by default. Set `BINKS_REVIEW_UPLOAD=1` only after
  the user explicitly authorizes uploading this run to Binks.

## Prepare

1. Run `binks-review --check-repository-eligibility` in the repository. Proceed
   only when it exits zero. It accepts only an `origin` URL on the exact
   `github.com` host in the `Shopify` or `shop` organization. Treat an absent,
   malformed, non-GitHub, or differently owned origin as ineligible.
2. Confirm `binks-review --version` succeeds. The wrapper uses only the
   Nix-pinned package version and performs no hourly or periodic update. If the
   managed environment is missing, ask the user to run this command once from a
   normal host shell; OpenCode has read-only access and cannot install it.
3. Determine the intended PR target with the approved git tooling. Use
   `origin/main` only when it is the actual target. For stacked changes, use the
   branch the current change will target.
4. Draft a short title describing what changed and a description explaining
   why, important tradeoffs, rollout context, and deliberate non-goals.
5. Create an output directory under `$TMPDIR`. Do not write Binks artifacts
   into the repository because that dirties the review target.
6. Never splice `$ARGUMENTS`, PR metadata, branch names, or source text directly
   into shell syntax. Store values in shell variables and quote every expansion.

## Run

Use the agent-oriented metadata path so Binks does not call `gh pr view`:

```bash
binks-review \
  --provider local \
  --base "$base" \
  --title "$title" \
  --description "$description" \
  --output-dir "$output_dir"
```

When invoked by `binks-reviewer`, add the wrapper-only `--no-upload` argument
immediately after `binks-review`. The wrapper strips it before starting the
upstream CLI and ignores inherited upload requests. Omit it only for a direct
user-authorized run that separately authorizes result upload.

Allow at least 15 minutes. Do not wrap the command in a short system timeout.

If installation fails in the normal host shell because Cloudsmith is not
configured, tell the user to run `dev up` in a uv-based Shopify project, then
retry from the host shell. Upload is disabled unless the user separately
authorizes it and the command is prefixed with `BINKS_REVIEW_UPLOAD=1`.
Missing upload credentials after that request disables result upload; it must
not be reported as a failed local review.

## Triage

1. Locate `code_review_result.json` under the output directory and read it with
   the native file tools.
2. Verify every finding against the referenced code and surrounding behavior.
3. If the request also authorizes fixes, fix valid findings and run focused
   tests. Otherwise, report them without editing. Do not apply suggestions
   blindly.
4. Record false positives with a concise technical reason. Better title or
   description context may prevent the same false positive in a later run.
5. Report valid findings, dismissed findings, fixes, test evidence, the output
   path, and whether Binks uploaded the result.

Local review does not resolve or reply to hosted GitHub review threads. Never
resolve hosted Binks comments, commit, push, or submit a PR unless the user has
separately authorized those actions.

## Updates

The package version is controlled by `scripts/binks-review.nix`. Do not run
`uv tool upgrade binks-pr-review` directly; update the Nix pin and rebuild the
Shopify Home Manager configuration instead.
