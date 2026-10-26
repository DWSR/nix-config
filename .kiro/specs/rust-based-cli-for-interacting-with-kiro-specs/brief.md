# Brief: rust-based-cli-for-interacting-with-kiro-specs

## Problem

> As a Kiro spec user, I want a CLI for interacting with Kiro specs in order to deduplicate interaction logic across multiple workflows.
>
> The CLI must:
>
> * be written in Rust
> * be able to list the "next" incomplete task
> * be able to list all tasks and subtasks
> * be able to print a comprehensive state of a given spec such as tasks by state, total task count, and current stage
> * have a command to validate a spec is well-formed (spec.json fields are correct, stages marked generated are or are not present, etc.)
> * be able to print information in both human readable and JSON format
> * be able to mark a task as completed or blocked, including reasons

Every consumer of a spec — OpenCode agents, cc-sdd skills, and Fabro workflow command nodes — re-derives task progress by reading `tasks.md` and `spec.json` on its own. The repo has 34 specs, 803 task entries, and no shared implementation, so each consumer drifts in its parsing, status vocabulary, and failure behavior.

## Current State

- 34 spec directories under `.kiro/specs/<feature>/`, each with `spec.json` and `tasks.md`; no program in this repository reads them.
- `spec.json` carries `feature_name`, `created_at`, `updated_at`, `language`, `phase`, `approvals.{requirements,design,tasks}.{generated,approved}`, and `ready_for_implementation`. The corpus uses phases `tasks-generated` (28), `tasks-approved` (4), and `implemented` (2); the template and workflow scripts also emit `initialized`, `requirements-generated`, and `design-generated`.
- Phase and readiness flags disagree in the existing corpus: 7 specs are `tasks-generated` with `ready_for_implementation` false, and 21 are `tasks-generated` with it true. Validation must encode the relationship rather than trust either field alone.
- `tasks.md` follows the cc-sdd grammar: `- [ ]` pending, `- [x]` done, `- [ ]*` optional, two numbering levels (major `N.`, subtask `N.M`), with trailing `_Requirements:_`, `_Boundary:_`, `_Depends:_` metadata. `.kiro/settings/rules/task-list-limits.md` caps a spec at 49 entries.
- Blocked work has no representation. `stylix-theming/tasks.md` records it as free prose (`- **Task 1.2 BLOCKED — ...**`), which no consumer can parse.
- The only Rust crate in the repo is `configurations/fabro-vm/api-bridge` (built via `rustPlatform.buildRustPackage` in `api-bridge.nix`); `overlays/misc.nix` holds the other `buildRustPackage` packages.
- Host wiring is `home-manager/common/*.nix` modules enabled from `home-manager/common/default.nix`; the Fabro sandbox image pins its command path in `configurations/fabro-vm/sandbox-image.nix`.

## Desired Outcome

A single `kiro-spec` binary works identically on both macOS hosts and inside the Fabro sandbox image, so a workflow command node and an interactive agent produce the same answer for the same spec. It reports the next incomplete task, all tasks with status and subtasks, spec-level counts and current stage, and validation findings; every read command has a human rendering and a stable JSON rendering. It marks a task completed or blocked with a reason by editing `tasks.md` in place, with the change visible to cc-sdd tooling and future CLI runs.

## Approach

Build an in-repo Rust crate that treats `tasks.md` as the source of truth for task state and `spec.json` as the source of truth for phase and approvals. Parsing, status derivation, validation, and rendering are library modules; the CLI is a thin argument layer, so workflow consumers use the same rules as humans.

Blocked tasks use a new checkbox state `- [!] <task>` plus an indented `- _Blocked: <reason>_` bullet directly under the task line. `[!]` keeps the state machine visible in the file and survives round-tripping by any consumer that already reads checkboxes; the reason bullet keeps the explanation next to the task instead of in prose. Completing a blocked task writes `[x]` and removes the reason bullet. A task counts as complete only for `[x]`; `[!]` is blocked; `[ ]` and `[ ]*` are pending.

Mutations are atomic (write temp file, rename) and minimal-diff: only the touched task line and its reason bullet change, so `git diff` stays reviewable and unrelated formatting is preserved.

## Scope

- **In**:
  - New Rust crate with library modules for spec discovery at a given path, `spec.json` parsing, `tasks.md` parsing, status computation, validation, and human/JSON rendering
  - Subcommands: `next`, `tasks` (all tasks and subtasks), `status` (counts by state, total, current stage), `validate`, `complete <task-id>`, `block <task-id> --reason <text>`
  - Machine-readable output for every read subcommand via `--json`, with a versioned, documented schema
  - Validation rules for required `spec.json` fields and types, phase-to-approval consistency, `generated` flags versus artifact presence, `feature_name` matching the directory, task numbering and the 49-entry limit, and `_Requirements:_` IDs resolving in `requirements.md`
  - `[!]` blocked encoding and reason bullet, including idempotent re-completion
  - Nix packaging through the custom-packages overlay, a `home-manager/common/` module enabled on both hosts, and inclusion in the Fabro sandbox image command path
  - Unit tests over fixture spec trees plus a build check for the derivation

- **Out**:
  - Rolling adoption inside the DWSR/fabro workflow definitions or cc-sdd skills; those change in their own repositories after this lands
  - Writing `spec.json` (phase transitions, approvals, readiness flags) — workflows own that file
  - Creating or deleting specs, and `research.md` validation
  - Git operations: branches, commits, the spec lock branches, PR stacks, or GitHub API calls
  - Repository-wide scan/status across all specs
  - Semantic review of requirements/design prose

## Boundary Candidates

- Parser versus model: `tasks.md`/`spec.json` parsing produces raw structures; status derivation is a separate pure layer over them.
- Read versus write: `next`/`tasks`/`status`/`validate` never touch files; `complete`/`block` share one atomic editor.
- Validation rules versus rendering: findings are structured data with codes, severities, and locations; text and JSON are renderers over that data.
- CLI versus packaging: the binary knows nothing about Nix; the overlay, Home Manager module, and sandbox image entry only carry it.

## Out of Boundary

- No spec lifecycle authority: the CLI reports state and never advances phases, approves artifacts, or sets `ready_for_implementation`.
- No network access, no GitHub interaction, no issue-to-spec generation.
- No implementation execution or subagent invocation.
- No attempt to keep external workflow helper scripts (e.g. the Python `tools.py` staged by the kiro-spec workflow) in sync; those are replaced later.
- No blocked transition graph beyond `pending -> blocked -> done`; unblocking is completion or a manual edit.

## Upstream / Downstream

- **Upstream**: cc-sdd artifact formats materialised from `programs.cc-sdd.skillsPackage` and the templates in `.kiro/settings/templates/`, `.kiro/settings/rules/task-list-limits.md`, and the existing 34-spec corpus used as fixtures/regression input.
- **Downstream**: Fabro `kiro-spec`, `kiro-task`, and `kiro-impl` workflow command nodes, the `kiro-spec-orchestrator` agent, and any replacement for the `kiro-spec-status` skill.

## Existing Spec Touchpoints

- **Extends**: None.
- **Adjacent**:
  - `cc-sdd-integration` owns skill installation and templates; this spec consumes its formats and does not modify them.
  - `nix-built-container-for-default-fabro-environmen` owns the sandbox image; this spec adds one entry to its command path.
  - `gh-stack-mcp` establishes the in-repo language-tool packaging and deterministic-check pattern; it does not own spec semantics.
  - `sqlite-backup` and `git-clone-isolation` establish the Home Manager module plus overlay packaging pattern.

## Constraints

- Rust with `serde`/`serde_json`; no async runtime and no network dependencies.
- Build through `rustPlatform.buildRustPackage` from the custom-packages overlay, with a checked-in `Cargo.lock`; builds must succeed for `aarch64-darwin` and `aarch64-linux`.
- Paths are explicit: every subcommand takes `--spec <name>` or a repository/worktree root and resolves `.kiro/specs/<name>/`; no implicit cwd guessing beyond the repo root default.
- Task identity is the dotted number (`3.2`), stable across runs; unknown or malformed IDs fail without writing.
- JSON output is additive-only within a schema version; workflows consume field names as a contract.
- Human output is plain text on stdout, diagnostics on stderr, and `validate` exits non-zero when errors exist.
- `tasks.md` writes are atomic and preserve every byte outside the touched task block, including comments, optional markers, and metadata bullets.
- Validation is offline and read-only; it never repairs a spec.
