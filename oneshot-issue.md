# GitHub issue #376: fix(oneshot): wait out provider rate limits adaptively

- URL: https://github.com/DWSR/nix-config/issues/376
- State: open
- Labels: fabro-ready, type/oneshot
- Repository: DWSR/nix-config

## Body

## Problem

Run `01M6W8A1V0ARR9E97B33N7WE60` (#340) failed on `gpt-6-luna` `usage_limit_reached` with `resets_in_seconds: 2856`. The oneshot wait nodes sleep 300 seconds with `max_visits=3` (about 15 minutes), so they give up before the provider recovers. Related: #315.

## Scope

- Change `wait_implement_rate_limit`, `wait_simplify_rate_limit`, and `wait_review_rate_limit` in `.fabro/workflows/oneshot/workflow.fabro` to:
  - receive `failure_reason` via `stdin_source`,
  - parse `resets_in_seconds` or `retry_after` when present,
  - wait in bounded visits that each stay under the graph stall timeout; cover up to about one hour rather than sleeping an hour in one node,
  - keep the total attempts bounded and set a compatible node `timeout`.
- If no reset hint is present, keep a bounded five-minute backoff.
- Optionally add another model fallback in `workflow.toml`; do not rely on a fallback alone.

## Acceptance

- A synthetic failure reason with `resets_in_seconds=2856` waits long enough to cover the reset, or fails with a clear "provider limit exceeds wait cap" reason after the cap; it does not give up after 15 minutes.
- `fabro validate` passes.

## Verification

- Unit-test the wait script with fake stdin.
- `fabro validate .fabro/workflows/oneshot/workflow.fabro`

## Related

- #315, #340.

