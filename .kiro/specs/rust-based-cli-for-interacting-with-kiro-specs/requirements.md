# Requirements Document

## Introduction

`kiro-spec` is a single command-line tool that reports and updates the state of one Kiro spec. The problem, chosen approach, and scope are in `brief.md`; this document defines the behavior the `kiro-spec` CLI must exhibit for its users and for workflow consumers.

## Boundary Context

- **In scope**: one spec directory per invocation; the six subcommands `next`, `tasks`, `status`, `validate`, `complete`, and `block`; the new `[!]` blocked encoding for entries written by `block`; versioned JSON for the four read subcommands; the packaged executable's presence on both hosts and in the Fabro sandbox image; fixture-driven tests and a packaged-build check.
- **Out of scope**: migrating, parsing, or reporting the existing free-prose blocked note in `stylix-theming/tasks.md`; any write other than `tasks.md`; repository-wide or cross-spec scans; changes to cc-sdd templates, skills, or external workflows; a machine-readable result for `complete` and `block`.
- **Adjacent expectations**: the `tasks.md` grammar, the `spec.json` field set, and requirement numbering are owned by cc-sdd and its templates; host configuration and the sandbox image are owned by adjacent specs; downstream workflows consume the JSON field names as an external contract but own their own adoption.

## Requirements

### Requirement 1: One binary, identical behavior

**Objective:** As a spec consumer, I want the same `kiro-spec` executable on both hosts and in the sandbox, so that a workflow node and a human get the same answer for the same spec.

#### Acceptance Criteria

1. When each host configuration is built, that configuration shall provide a `kiro-spec` executable on the operator's command path.
2. When the Fabro sandbox image is built, the image shall provide the same `kiro-spec` executable on its command path.
3. When the same spec tree and subcommand are used on a host and in the sandbox, the `kiro-spec` CLI shall produce identical results and exit status.
4. The `kiro-spec` CLI shall operate without network access.
5. When `--help` is requested, the `kiro-spec` CLI shall list every subcommand and its options on stdout and exit zero.
6. When an unrecognized subcommand or option is supplied, the `kiro-spec` CLI shall write an actionable usage diagnostic to stderr, exit non-zero, and leave every spec file unchanged.

### Requirement 2: Explicit spec resolution

**Objective:** As a spec consumer, I want every invocation tied to an explicit spec, so that no command acts on a guessed checkout or the wrong spec.

#### Acceptance Criteria

1. When `--spec <name>` is supplied, the `kiro-spec` CLI shall resolve the directory `.kiro/specs/<name>/` beneath the supplied repository or worktree root.
2. While no repository or worktree root is supplied, the `kiro-spec` CLI shall use the current directory as the root.
3. The `kiro-spec` CLI shall not search parent directories or infer a spec name from the working directory.
4. If `--spec` is omitted, then the `kiro-spec` CLI shall fail with a usage diagnostic naming `--spec`.
5. If the spec name is absolute or contains a path separator or `..`, then the `kiro-spec` CLI shall reject it with a usage diagnostic.
6. If the resolved spec directory does not exist, then the `kiro-spec` CLI shall name the resolved path in a diagnostic, exit non-zero, and write no file.
7. If an artifact required by the requested subcommand is missing or unreadable, then the `kiro-spec` CLI shall name the path in a diagnostic, exit non-zero, and write no file.
8. Where `validate` is the requested subcommand, the `kiro-spec` CLI shall report a missing artifact as a validation finding instead of aborting.

### Requirement 3: Listing tasks and subtasks

**Objective:** As a spec consumer, I want every task entry with its identifier, state, and subtasks, so that I can see the whole plan without re-implementing the grammar.

#### Acceptance Criteria

1. When `tasks` runs, the `kiro-spec` CLI shall report every parsed task entry from `tasks.md` in document order.
2. The `kiro-spec` CLI shall report, for each entry, its numeric identifier, description, state, optional classification, and blocked reason when the entry is blocked.
3. When an entry is a grouping task with at least one subtask, the `kiro-spec` CLI shall present its subtasks beneath it.
4. The `kiro-spec` CLI shall derive an entry's state as completed for `[x]` and `[x]*`, blocked for `[!]` and `[!]*`, and pending for `[ ]` and `[ ]*`.
5. The `kiro-spec` CLI shall preserve the optional classification of an entry in every state.
6. When `tasks.md` contains no task entries, the `kiro-spec` CLI shall report an empty task list and exit zero.
7. The `kiro-spec` CLI shall identify each entry by its dotted numeric identifier and shall use that same identifier unchanged across invocations and in `complete` and `block`.
8. The `kiro-spec` CLI shall not modify any file while running `tasks`.

### Requirement 4: Reporting the next incomplete task

**Objective:** As a workflow consumer, I want the next actionable task entry, so that implementation starts on the right item without rescanning the file.

#### Acceptance Criteria

1. When `next` runs, the `kiro-spec` CLI shall report the first task entry in document order that is not completed, excluding grouping tasks that contain at least one subtask.
2. When a spec contains only major task entries, the `kiro-spec` CLI shall treat each major entry as a non-grouping entry.
3. When the reported entry is blocked, the `kiro-spec` CLI shall include its blocked state and reason.
4. When every non-grouping entry is completed, the `kiro-spec` CLI shall report that no incomplete task remains, exit zero, and leave unchecked grouping entries unselected.
5. The `kiro-spec` CLI shall not modify any file while running `next`.

### Requirement 5: Comprehensive spec status

**Objective:** As a spec consumer, I want counts by state and the current stage, so that I can judge progress without reading the entire task list.

#### Acceptance Criteria

1. When `status` runs, the `kiro-spec` CLI shall report the total number of parsed task entries.
2. The `kiro-spec` CLI shall report separate counts for completed, pending, and blocked entries, and those counts shall sum to the total.
3. The `kiro-spec` CLI shall count both `[ ]` and `[ ]*` entries as pending, and shall report how many pending entries are optional.
4. The `kiro-spec` CLI shall report the current stage as the `spec.json` `phase` value and shall not infer a stage from task progress.
5. If `spec.json` cannot be parsed or has no string `phase` value, then the `kiro-spec` CLI shall fail with a diagnostic naming the file.
6. The `kiro-spec` CLI shall derive counts with the same state rules used by `tasks` and `next`.
7. The `kiro-spec` CLI shall not modify any file while running `status`.

### Requirement 6: Spec validation

**Objective:** As a spec maintainer, I want well-formedness findings before work starts, so that malformed metadata and task lists are caught rather than silently consumed.

#### Acceptance Criteria

1. When `validate` runs, the `kiro-spec` CLI shall operate offline and read-only, and shall not repair any file.
2. The `kiro-spec` CLI shall report each finding with a severity of error or warning, a stable code, a message, and the file and line where a line applies.
3. If `spec.json` is missing a required field or a required field has the wrong type, then the `kiro-spec` CLI shall report an error naming the field.
4. The `kiro-spec` CLI shall require `feature_name`, `created_at`, `updated_at`, `language`, `phase`, `approvals.requirements.generated`, `approvals.requirements.approved`, `approvals.design.generated`, `approvals.design.approved`, `approvals.tasks.generated`, `approvals.tasks.approved`, and `ready_for_implementation`.
5. If `feature_name` differs from the spec directory name, then the `kiro-spec` CLI shall report an error.
6. If `phase` is not one of `initialized`, `requirements-generated`, `design-generated`, `tasks-generated`, `tasks-approved`, or `implemented`, then the `kiro-spec` CLI shall report an error.
7. While `phase` is `requirements-generated` or later, the `kiro-spec` CLI shall report an error unless `requirements.generated` is true and `requirements.md` exists.
8. While `phase` is `design-generated` or later, the `kiro-spec` CLI shall report an error unless `design.generated` is true and `design.md` exists.
9. While `phase` is `tasks-generated` or later, the `kiro-spec` CLI shall report an error unless `tasks.generated` is true and `tasks.md` exists.
10. While `phase` is `tasks-approved` or later, the `kiro-spec` CLI shall report an error unless all three `approved` flags are true.
11. If any approval flag is true while the matching `generated` flag is false, then the `kiro-spec` CLI shall report an error.
12. If `ready_for_implementation` is true while `approvals.tasks.approved` is false, then the `kiro-spec` CLI shall report an error.
13. If any `generated` flag is true while the matching artifact is absent, then the `kiro-spec` CLI shall report an error.
14. The `kiro-spec` CLI shall treat a phase as a minimum: approvals may be ahead of the reported phase, so an approval that is true while the phase lags shall not be reported as an error.
15. When parsing `tasks.md`, the `kiro-spec` CLI shall report an error for a numbered entry with more than two numeric levels, a duplicate identifier, or an identifier that is not numeric.
16. When `tasks.md` contains more than 49 task entries, counting major entries and subtasks together, the `kiro-spec` CLI shall report an error stating the count and the limit.
17. When a line starts with a Markdown checkbox followed by a numeric identifier but does not match the supported numbered-entry grammar, the `kiro-spec` CLI shall report an error at that line.
18. When an unnumbered checkbox line appears in `tasks.md`, the `kiro-spec` CLI shall report a warning and shall not count the line as a task entry.
19. When an entry has a `_Requirements:_` metadata bullet, the `kiro-spec` CLI shall resolve every referenced identifier to a requirement number or a requirement number with an acceptance-criterion number in `requirements.md`.
20. If a `_Requirements:_` reference is malformed or does not resolve, then the `kiro-spec` CLI shall report an error naming the reference and its line.
21. The `kiro-spec` CLI shall report findings in a deterministic order grouped by file and line.
22. When any error-severity finding exists, the `kiro-spec` CLI shall exit non-zero; when only warnings or no findings exist, it shall exit zero.

### Requirement 7: Completing a task

**Objective:** As a spec user, I want to mark a task complete in place, so that cc-sdd tooling and later CLI runs see the same progress.

#### Acceptance Criteria

1. When `complete <task-id>` names an existing pending entry, the `kiro-spec` CLI shall rewrite that entry as completed and preserve its description, identifier, optional classification, metadata bullets, and indentation.
2. When `complete <task-id>` names an entry that is already completed, the `kiro-spec` CLI shall succeed without changing the file and shall report that no change was needed.
3. When `complete <task-id>` names a blocked entry, the `kiro-spec` CLI shall rewrite it as completed and remove its blocked reason bullet.
4. The `kiro-spec` CLI shall change only the targeted entry and its reason bullet, preserving every other byte of `tasks.md`.
5. If the task identifier is malformed, unknown, or matches more than one entry, then the `kiro-spec` CLI shall name the identifier in a diagnostic, exit non-zero, and write no file.
6. The `kiro-spec` CLI shall not change a parent task, a subtask, or any other entry as a side effect of completing one entry.
7. The `kiro-spec` CLI shall not modify `spec.json`, `brief.md`, `requirements.md`, `design.md`, or any file other than `tasks.md`.
8. If the write cannot be completed, then the `kiro-spec` CLI shall leave `tasks.md` unchanged, exit non-zero, and report the failure.
9. When `complete` succeeds, a subsequent `tasks`, `next`, or `status` run shall report the entry as completed.

### Requirement 8: Blocking a task with a reason

**Objective:** As a spec user, I want blocked work recorded in a machine-readable form, so that consumers can distinguish blocked work from pending work and explain it.

#### Acceptance Criteria

1. When `block <task-id> --reason <text>` names an existing pending entry, the `kiro-spec` CLI shall rewrite that entry with the `[!]` checkbox state and insert an indented `- _Blocked: <reason>_` bullet directly beneath the entry.
2. The `kiro-spec` CLI shall preserve the entry's description, identifier, optional classification, metadata bullets, and indentation when writing a blocked entry.
3. If `--reason` is missing, contains only whitespace, or contains a line break, then the `kiro-spec` CLI shall fail with a usage diagnostic and write no file.
4. When `block` names an entry that is already blocked, the `kiro-spec` CLI shall replace its existing reason bullet so that exactly one reason bullet remains.
5. If `block` names an entry that is already completed, then the `kiro-spec` CLI shall fail with a diagnostic naming the unsupported transition and write no file.
6. If the task identifier is malformed, unknown, or matches more than one entry, then the `kiro-spec` CLI shall name the identifier in a diagnostic, exit non-zero, and write no file.
7. The `kiro-spec` CLI shall not modify any file other than `tasks.md` when blocking an entry.
8. If the write cannot be completed, then the `kiro-spec` CLI shall leave `tasks.md` unchanged, exit non-zero, and report the failure.
9. When `block` succeeds, a subsequent `tasks`, `next`, or `status` run shall report the entry as blocked and include the reason.
10. The `kiro-spec` CLI shall not offer an unblock command; a blocked entry leaves the blocked state only through `complete` or a manual edit.

### Requirement 9: Human and machine-readable output

**Objective:** As a workflow consumer, I want a stable JSON rendering beside the human rendering, so that automation does not scrape prose.

#### Acceptance Criteria

1. When `next`, `tasks`, `status`, or `validate` is invoked with `--json`, the `kiro-spec` CLI shall write exactly one JSON document to stdout and no human-readable result text.
2. When any of those subcommands is invoked without `--json`, the `kiro-spec` CLI shall write a human-readable plain-text rendering to stdout.
3. The `kiro-spec` CLI shall write diagnostics and warnings to stderr, never to stdout.
4. The `kiro-spec` CLI shall include a schema version field in every JSON document.
5. The `kiro-spec` CLI shall keep field names stable and change the schema version when a field is removed or its meaning or type changes; adding a field shall not change the version.
6. When the same spec and subcommand are run twice with `--json`, the `kiro-spec` CLI shall produce the same entries in the same order with the same values.
7. The JSON rendering of `tasks` and `next` shall expose each entry's identifier, description, state, optional classification, and blocked reason.
8. The JSON rendering of `status` shall expose the total, the counts by state, the optional pending count, and the current stage.
9. The JSON rendering of `validate` shall expose every finding's severity, code, message, file, and line when applicable, and shall expose whether any error-severity finding exists.
10. The `kiro-spec` CLI shall use the same exit status with and without `--json`.
11. If a subcommand cannot produce a result, then the `kiro-spec` CLI shall not write a partial result document to stdout; a `validate` result that contains error findings shall still be written as a complete result document.

### Requirement 10: Safe, minimal file writes

**Objective:** As a spec user, I want mutations to be reviewable and crash-safe, so that a failed update never corrupts a task list or rewrites unrelated content.

#### Acceptance Criteria

1. When `complete` or `block` changes `tasks.md`, the `kiro-spec` CLI shall publish the replacement atomically, and a concurrent reader shall observe either the complete previous file or the complete new file.
2. If the process is interrupted or the replacement fails, then the original `tasks.md` shall remain intact.
3. The `kiro-spec` CLI shall preserve line endings, trailing whitespace, comments, optional markers, metadata bullets, and every byte outside the targeted entry and its reason bullet.
4. The `kiro-spec` CLI shall leave `tasks.md` byte-identical when a mutation results in no state change.
5. The `kiro-spec` CLI shall not write to any file while running `next`, `tasks`, `status`, or `validate`.
6. The `kiro-spec` CLI shall exit zero after a successful mutation, exit non-zero after a failed mutation, and report the affected identifier and resulting state on success.

### Requirement 11: Verification and user documentation

**Objective:** As the maintainer, I want fixture-driven checks and documented output contracts, so that the tool's parsing and JSON contracts do not drift unnoticed.

#### Acceptance Criteria

1. The test suite shall cover parsing and state derivation for pending, optional, completed, blocked, and malformed task entries using fixture spec trees.
2. The test suite shall cover validation findings for each required `spec.json` rule, missing artifacts, duplicate identifiers, the entry-count limit, and resolved and unresolved `_Requirements:_` references.
3. The test suite shall cover `complete` and `block` byte preservation, idempotency, reason replacement, transition rejection, and no-write failure paths.
4. The test suite shall verify human output, JSON validity, stdout and stderr separation, and exit status for every subcommand.
5. When the suite runs against the repository's existing spec corpus, the `kiro-spec` CLI shall parse every spec and produce identical output on repeated runs.
6. The packaged executable shall build from the checked-in source for `aarch64-darwin` and `aarch64-linux`.
7. The shipped documentation shall state the JSON schema version, the fields of each read subcommand, and the `[!]` blocked encoding with its reason bullet.
8. The test suite shall run offline and shall not modify any spec under `.kiro/specs/`.
