# Secret Material Handling

## Scope

- Apply these rules when a spec, task, or review touches secret material: a
  credential, private key, token, or any value that must stay out of the
  repository and the Nix store.

## Secret classes

- **Wiring**: declarations, runtime paths, modes, owners, consumers, and
  structural tests. Wiring is secret-independent; implement it normally.
- **Verification**: live checks that need a secret value or an external
  service. When the value is unavailable, record the check and continue.
- **Provisioning**: minting, generating, rotating, or writing a secret value.
  Provisioning is operator-owned and is never a Kiro task.

## Planning

- A design must contain a `## Operator Provisioning` section when the feature
  needs any secret value. Each entry names the secret, its source, the exact
  provisioning command, the verification command, and the owner.
- `tasks.md` must not contain provisioning-only tasks. Point at the design's
  `## Operator Provisioning` section instead.
- Every task must have a secret-independent deliverable whose completion is
  satisfiable without a secret value.

## Implementation

- Missing secret material must not produce `BLOCKED` or `_Blocked:`. It is an
  operator-owned provisioning gap, not an underdetermined spec.
- Record the gap in `impl_tests_run` as
  `environment-blocked: secret-material-blocked <name> (<source>)` and
  continue with the secret-independent work.
- Return `READY_FOR_REVIEW` when only operator provisioning remains, and name
  the operator action in `impl_concerns`.
- Return `NEEDS_CONTEXT` only when the task has no secret-independent work at
  all.
- Never invent, guess, commit, or log a secret. Never weaken SOPS recipients,
  keys, or encryption. Placeholders only in test fixtures, never in a real
  store.

## Review

- Treat the `environment-blocked: secret-material-blocked ...` marker as
  environment-blocked, not as a rejection, and do not start a rework round
  for it.
- Reject fabricated or guessed values, placeholders written into a real
  store, dropped recipients, disabled encryption, and a `BLOCKED` report
  while secret-independent work remains.
