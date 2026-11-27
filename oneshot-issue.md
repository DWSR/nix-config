# GitHub issue #377: feat(oneshot): handle investigation issues with a mitigation PR

- URL: https://github.com/DWSR/nix-config/issues/377
- State: open
- Labels: fabro-ready, type/oneshot
- Repository: DWSR/nix-config

## Body

## Problem

Run `01M6VWZQZ28NPNYDY2GPMRPYFA` (#297) returned `BLOCKED` because the issue required external cancellation context. The repository could still ship the narrow in-repo mitigation that was ultimately written by hand.

## Scope

- Detect investigation or failure-triage issues in `prepare` or a new `classify` node: label `fabro-failure-triage`, body marker `<!-- fabro-failure-triage:`, or title prefix `[fabro-failure-triage]`.
- Add `issue_mode=triage` to the run state and the implement prompt.
- For `triage` issues, `.fabro/workflows/oneshot/prompts/implement.md` must:
  - investigate the cited runs and evidence,
  - implement the narrowest safe in-repo mitigation,
  - write a publish summary with findings and the remaining external work,
  - return BLOCKED only when no in-repo mitigation exists.
- Route `triage` blocked outcomes to the salvage publisher with the findings.

## Acceptance

- A triage issue either produces an approved PR or a draft PR with the mitigation and findings; it does not end as a bare BLOCKED failure.
- Non-triage behavior is unchanged.

## Verification

- Add a fixture-based test under `tests/fabro-workflows/`.
- `fabro validate .fabro/workflows/oneshot/workflow.fabro`

## Related

- #297, the salvage-publish and typed-review issues.
