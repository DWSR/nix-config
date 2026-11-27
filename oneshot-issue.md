# GitHub issue #385: test(oneshot): cover the failure-routing matrix

- URL: https://github.com/DWSR/nix-config/issues/385
- State: open
- Labels: fabro-ready, type/oneshot
- Repository: DWSR/nix-config

## Body

## Problem

`tests/fabro-workflows/` mostly asserts strings; routing regressions are easy, for example a blocked review being routed to rework.

## Scope

- Add table-driven tests for the oneshot graph:
  - network failure routes to fail or salvage,
  - BLOCKED routes to fail or salvage,
  - baseline-red routes to continue,
  - rate limit routes to wait,
  - rework exhausted routes to salvage,
  - closed issue produces a clean skip,
  - timeout routes to fail or salvage.
- Parse `.fabro/workflows/oneshot/workflow.fabro` or use a small evaluator; assert edge order and conditions.
- Make each test fail if its edge or condition is removed.

## Acceptance

- The matrix covers each path and fails on the corresponding regression.

## Verification

- `python3 tests/fabro-workflows/routing.test.py`

## Related

- All oneshot hardening issues.

