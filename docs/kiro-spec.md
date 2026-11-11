# kiro-spec

`kiro-spec` reports and updates one Kiro spec at a time. It resolves
`.kiro/specs/<name>/` beneath an explicit root, works offline, and never
touches another spec. The four read subcommands are read-only; `complete` and
`block` write only `tasks.md`.

## Usage

```text
kiro-spec [--root <path>] --spec <name> <next|tasks|status|validate> [--json]
kiro-spec [--root <path>] --spec <name> <complete <task-id>|block <task-id> --reason <text>>
```

| Option | Subcommands | Meaning |
| --- | --- | --- |
| `--root <path>` | all | Repository or worktree root; defaults to `.` |
| `--spec <name>` | all, required | Spec directory name beneath `.kiro/specs/` |
| `--json` | `next`, `tasks`, `status`, `validate` | Emit one JSON document instead of human text |
| `--reason <text>` | `block`, required | Blocked reason; non-empty after trimming and free of line breaks |
| `-h`, `--help` | | Print the synopsis and subcommand list, exit 0 |
| `-V`, `--version` | | Print `kiro-spec <version>`, exit 0 |

Long options accept both `--opt value` and `--opt=value`. When a value option
is repeated, the last occurrence wins. `--json` on `complete` or `block`, and
`--reason` outside `block`, are usage errors.

## Subcommands

### `next`

Print the first incomplete non-grouping task entry. A parent entry that has
children is a grouping entry and is skipped; its first incomplete child is
reported instead.

```sh
kiro-spec --root scripts/kiro-spec/tests/fixtures/basic --spec basic next
```

```text
  1.1 First child [pending]
```

The two leading spaces are the subtask indent. When no incomplete entry
remains, `next` prints `No incomplete task.`

### `tasks`

Print every task entry in document order, one line each, with two spaces of
indent per subtask level.

```sh
kiro-spec --root scripts/kiro-spec/tests/fixtures/basic --spec basic tasks
```

```text
1 Foundation [pending]
  1.1 First child [pending]
  1.2 Optional child [pending] (optional)
2 Completed task [completed]
3 Blocked task [blocked] - blocked: Waiting on credentials
4 Legacy prose entry [pending]
5 Adjacent first [pending]
6 Adjacent second [pending] (optional)
7 Completed optional [completed] (optional)
```

An empty `tasks.md` prints `No tasks.`

### `status`

Print the spec name, the `spec.json` phase, and task counts. `status` requires
a readable, valid `spec.json`; a missing or invalid file is exit 1 with no
result on stdout.

```sh
kiro-spec --root scripts/kiro-spec/tests/fixtures/basic --spec basic status
```

```text
spec: basic
stage: initialized
total: 9
completed: 2
pending: 6 (optional: 2)
blocked: 1
```

`stage` is the `spec.json` phase: `initialized`, `requirements-generated`,
`design-generated`, `tasks-generated`, `tasks-approved`, or `implemented`.
`pending` excludes blocked entries; `(optional: n)` counts optional entries
among the pending ones.

### `validate`

Read all artifacts and print one finding per line, then a summary. Findings are
result data on stdout in both human and JSON form; they are never diagnostics.

```sh
kiro-spec --root scripts/kiro-spec/tests/fixtures/basic --spec basic validate
```

```text
0 errors, 0 warnings
```

Exit 0 means no error-severity finding; warnings do not fail validation. See
[Validation examples](#validation-examples) for failing output.

### `complete <task-id>`

Mark one entry completed. The task id is a canonical dotted number (`N` or
`N.M`). Success prints `{id} completed`; a request that changes nothing prints
`{id} completed (no change)` and leaves `tasks.md` byte-identical.

```sh
kiro-spec --root <temp-root> --spec basic complete 2
```

```text
2 completed (no change)
```

Completing a blocked entry also removes every `_Blocked:` reason bullet and its
continuation lines from that entry block. Given this excerpt from the `basic`
fixture:

```markdown
- [!] 3. Blocked task
  - _Blocked: Waiting on credentials_
  - _Requirements: 1.2_
```

`complete 3` prints:

```text
3 completed
```

and leaves:

```markdown
- [x] 3. Blocked task
  - _Requirements: 1.2_
```

Writes are atomic: the replacement is written to
`<spec-dir>/.tasks.md.kiro-spec.<pid>.tmp`, flushed, and renamed over
`tasks.md`; the original permissions are copied, and the temporary file is
removed on failure. A no-op performs no write.

### `block <task-id> --reason <text>`

Mark one entry blocked with a reason. Success prints `{id} blocked`; repeating
the same reason prints `{id} blocked (no change)`. Blocking a completed entry
is refused with exit 1.

```sh
kiro-spec --root <temp-root> --spec basic block 5 --reason "Waiting on review"
```

```text
5 blocked
```

Repeating the same request:

```sh
kiro-spec --root <temp-root> --spec basic block 5 --reason "Waiting on review"
```

```text
5 blocked (no change)
```

The pending line:

```markdown
- [ ] 5. Adjacent first
```

becomes:

```markdown
- [!] 5. Adjacent first
  - _Blocked: Waiting on review_
```

Blocking an already blocked entry replaces the reason in place:

```markdown
- [!] 3. Blocked task
  - _Blocked: Waiting on API access_
  - _Requirements: 1.2_
```

A pre-existing `_Blocked:` bullet, including continuation lines, is replaced so
exactly one remains.

## Exit codes

| Code | Category |
| --- | --- |
| `0` | Success, including a validate result with no errors and a mutation no-op |
| `1` | Resolution, artifact read, parse, validation errors, or mutation failure |
| `2` | Usage error, detected before any filesystem access |

Resolution and read failures write `kiro-spec: <context>: <detail>` to stderr
and nothing to stdout. Usage errors take the same form. A failed command never
writes a partial result document.

```sh
kiro-spec --root scripts/kiro-spec/tests/fixtures/basic --spec basic complete 2 --json
```

```text
kiro-spec: usage: flag `--json` is only supported by next, tasks, status, and validate
```

That command exits 2. `block` on a completed entry exits 1:

```text
kiro-spec: tasks.md: unsupported transition: completed task `3` cannot be blocked
```

## JSON output

### Schema version 1

Every JSON document is one object with `schema_version: 1` first, `spec`
second, and the command payload after them, in the key order shown below. The
document is pretty-printed with two spaces and ends with one newline. Adding a
field does not change the version; removing a field or changing its meaning or
type requires a new version. A task object has `id`, `description`, `state`,
`optional`, and `blocked_reason`; `blocked_reason` is null unless the entry is
blocked.

`next` emits the task object, or `task: null` when no incomplete non-grouping
entry remains:

```json
{
  "schema_version": 1,
  "spec": "basic",
  "task": {
    "id": "1.1",
    "description": "First child",
    "state": "pending",
    "optional": false,
    "blocked_reason": null
  }
}
```

```json
{
  "schema_version": 1,
  "spec": "empty",
  "task": null
}
```

`tasks` emits a flat array in document order; subtask relationship is carried
only by the dotted id:

```json
{
  "schema_version": 1,
  "spec": "basic",
  "tasks": [
    {
      "id": "1",
      "description": "Foundation",
      "state": "pending",
      "optional": false,
      "blocked_reason": null
    },
    {
      "id": "1.1",
      "description": "First child",
      "state": "pending",
      "optional": false,
      "blocked_reason": null
    },
    {
      "id": "1.2",
      "description": "Optional child",
      "state": "pending",
      "optional": true,
      "blocked_reason": null
    },
    {
      "id": "2",
      "description": "Completed task",
      "state": "completed",
      "optional": false,
      "blocked_reason": null
    },
    {
      "id": "3",
      "description": "Blocked task",
      "state": "blocked",
      "optional": false,
      "blocked_reason": "Waiting on credentials"
    },
    {
      "id": "4",
      "description": "Legacy prose entry",
      "state": "pending",
      "optional": false,
      "blocked_reason": null
    },
    {
      "id": "5",
      "description": "Adjacent first",
      "state": "pending",
      "optional": false,
      "blocked_reason": null
    },
    {
      "id": "6",
      "description": "Adjacent second",
      "state": "pending",
      "optional": true,
      "blocked_reason": null
    },
    {
      "id": "7",
      "description": "Completed optional",
      "state": "completed",
      "optional": true,
      "blocked_reason": null
    }
  ]
}
```

An empty task list emits an empty array:

```json
{
  "schema_version": 1,
  "spec": "empty",
  "tasks": []
}
```

`status` puts `completed`, `pending`, and `blocked` inside `counts` and
`optional_pending` at the top level:

```json
{
  "schema_version": 1,
  "spec": "basic",
  "stage": "initialized",
  "total": 9,
  "counts": {
    "completed": 2,
    "pending": 6,
    "blocked": 1
  },
  "optional_pending": 2
}
```

`validate` emits `valid` and every finding. `valid` is true exactly when no
error-severity finding exists. Each finding has `severity`, `code`, `message`,
`file`, and `line`; `line` is `null` when no line applies.

```json
{
  "schema_version": 1,
  "spec": "missing-language",
  "valid": false,
  "findings": [
    {
      "severity": "error",
      "code": "spec.field.missing",
      "message": "required field `language` is missing",
      "file": "spec.json",
      "line": null
    }
  ]
}
```

A clean report is `"valid": true` with `"findings": []`.

## Human output

`tasks` prints one line per entry in document order; `next` prints the same
form for one entry:

```text
{indent}{id} {description} [{state}]
{indent}{id} {description} [{state}] (optional)
{indent}{id} {description} [{state}] - blocked: {reason}
```

`{indent}` is two spaces per level below a major entry, `{id}` is the canonical
dotted id, and `{state}` is `pending`, `completed`, or `blocked`. The optional
suffix follows the state; the blocked reason suffix is lowercase
`- blocked: <reason>`, distinct from the `_Blocked:` metadata bullet in the
source.

`tasks` with no entries prints `No tasks.` `next` with no actionable entry
prints `No incomplete task.`

`status` prints exactly six lines:

```text
spec: {name}
stage: {phase}
total: {n}
completed: {n}
pending: {n} (optional: {m})
blocked: {n}
```

`validate` prints each finding in sorted order (file, then line with
no-line findings first, then code, then message), followed by a summary:

```text
{file}:{line}: {severity} [{code}] {message}
{file}: {severity} [{code}] {message}
{n} errors, {m} warnings
```

The second finding form is used when `line` is null. `severity` is `error` or
`warning`, and the summary nouns are singular exactly at one.

## Blocked encoding

The canonical blocked encoding uses the `[!]` marker and exactly one indented
reason bullet directly beneath the task line. The optional marker `*` is
preserved:

```text
- [!] <id>. <description>
  - _Blocked: <reason>_

- [!]* <id>. <description>
  - _Blocked: <reason>_
```

A real optional entry after `block 6 --reason "Waiting on design sign-off"`:

```markdown
- [!]* 6. Adjacent second
  - _Blocked: Waiting on design sign-off_
```

`complete` removes every reason bullet and its continuation lines. `block`
inserts the bullet beneath the task line when absent, or replaces the existing
bullet text in place; multiple pre-existing reason bullets collapse to one.
There is no `unblock` subcommand.

## Empty and all-completed specs

Given a temporary root whose `.kiro/specs/empty/` has a valid `spec.json` and
an empty `tasks.md`:

```sh
kiro-spec --root <temp-root> --spec empty tasks
```

```text
No tasks.
```

```sh
kiro-spec --root <temp-root> --spec empty next
```

```text
No incomplete task.
```

The same tree renders `"tasks": []` and `"task": null` with `--json`. Given a
temporary spec whose entries are all completed:

```markdown
- [x] 1. Foundation
- [x] 1.1 First child
```

`tasks` prints the completed lines:

```sh
kiro-spec --root <temp-root> --spec completed tasks
```

```text
1 Foundation [completed]
  1.1 First child [completed]
```

`next` prints the no-incomplete form:

```sh
kiro-spec --root <temp-root> --spec completed next
```

```text
No incomplete task.
```

## Validation examples

A clean fixture reports no findings and exits 0:

```sh
kiro-spec --root scripts/kiro-spec/tests/fixtures/basic --spec basic validate
```

```text
0 errors, 0 warnings
```

Warnings are findings but do not fail validation. The `unnumbered` fixture
reports one warning at a line and exits 0:

```sh
kiro-spec --root scripts/kiro-spec/tests/fixtures/malformed/unnumbered --spec unnumbered validate
```

```text
tasks.md:3: warning [tasks.line.unnumbered] checkbox line has no numeric task identifier
0 errors, 1 warning
```

The `missing-language` fixture has an error and exits 1:

```sh
kiro-spec --root scripts/kiro-spec/tests/fixtures/spec-json-cases/missing-language --spec missing-language validate
```

```text
spec.json: error [spec.field.missing] required field `language` is missing
1 error, 0 warnings
```

The same result with `--json` is the `validate` document shown above; exit
status is 1 in both formats, and the complete result still goes to stdout.

## Finding codes

`validate` can emit the following codes. A finding's `file` is relative to the
spec directory.

| Code | Severity | Condition | File / line |
| --- | --- | --- | --- |
| `spec.json.missing` | error | `spec.json` is absent | `spec.json` / none |
| `spec.json.unreadable` | error | `spec.json` cannot be read or is not valid UTF-8 | `spec.json` / none |
| `spec.json.parse` | error | `spec.json` is not valid JSON or its top-level value is not an object | `spec.json` / none |
| `spec.field.missing` | error | A required field or nested field is absent | `spec.json` / none |
| `spec.field.type` | error | A required field has the wrong JSON type | `spec.json` / none |
| `spec.feature-name.mismatch` | error | `feature_name` differs from the spec directory name | `spec.json` / none |
| `spec.phase.unknown` | error | `phase` is not one of the six documented values | `spec.json` / none |
| `spec.phase.generated-false` | error | The phase requires a stage whose `generated` flag is false | `spec.json` / none |
| `spec.phase.approved-false` | error | The phase is `tasks-approved` or later while an `approved` flag is false | `spec.json` / none |
| `spec.generated.artifact-missing` | error | A `generated` flag is true or the phase requires an artifact, and the artifact is absent | `requirements.md`, `design.md`, or `tasks.md` / none |
| `spec.approval.without-generated` | error | An `approved` flag is true while its `generated` flag is false | `spec.json` / none |
| `spec.ready.without-tasks-approval` | error | `ready_for_implementation` is true while `approvals.tasks.approved` is false | `spec.json` / none |
| `tasks.unreadable` | error | `tasks.md` cannot be read or is not valid UTF-8 | `tasks.md` / none |
| `tasks.line.unnumbered` | warning | A checkbox line has no numeric identifier | `tasks.md` / line |
| `tasks.id.depth` | error | An identifier has more than two numeric levels | `tasks.md` / line |
| `tasks.id.non-numeric` | error | An identifier begins with a digit but is not numeric | `tasks.md` / line |
| `tasks.id.duplicate` | error | A canonical identifier appears more than once | `tasks.md` / duplicate line |
| `tasks.line.malformed` | error | A checkbox with a numeric start does not match the supported grammar | `tasks.md` / line |
| `tasks.limit.exceeded` | error | More than 49 entries, counting majors and subtasks | `tasks.md` / 50th entry line |
| `requirements.artifact-missing` | error | `_Requirements:` references exist but `requirements.md` is absent | `requirements.md` / none |
| `requirements.unreadable` | error | `requirements.md` cannot be read or is not valid UTF-8 | `requirements.md` / none |
| `requirements.ref.malformed` | error | A reference token is not `N` or `N.M` | `tasks.md` / bullet line |
| `requirements.ref.unresolved` | error | A well-formed reference names a missing requirement or acceptance criterion | `tasks.md` / bullet line |

Findings are result data on stdout in both formats; stderr is reserved for
usage and operational diagnostics.

## Testing

The suite is offline and read-only against `.kiro/specs/`. Run the unit and
integration tests from the crate:

```sh
cd scripts/kiro-spec && nix shell nixpkgs#cargo nixpkgs#rustc --command cargo test --locked
```

Run the corpus determinism test, which is skipped unless `KIRO_SPEC_CORPUS` is
set:

```sh
KIRO_SPEC_CORPUS=1 nix shell nixpkgs#cargo nixpkgs#rustc --command cargo test --locked --test corpus
```

Run the packaged and flake-level checks from the repository root:

```sh
nix build .#checks.aarch64-darwin.kiro-spec
nix build .#checks.aarch64-darwin.kiro-spec-corpus
nix build .#checks.aarch64-darwin.kiro-spec-wiring
```

The Linux package build needs a Linux builder:

```sh
nix build .#packages.aarch64-linux.kiro-spec
```

The sandbox image test runs the Node test directly:

```sh
node --test tests/fabro-sandbox/image.test.js
```
