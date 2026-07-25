---
name: validate-yb-issue
description: >-
  Validate a public YugabyteDB issue — a yugabyte/yugabyte-db GitHub bug or
  crash report. Dispatches the yb-issue-validator subagent to triage the
  report, root-cause it in the local source tree with file:line citations,
  build a deterministic reproduction (podman + official yugabytedb/yugabyte
  images), and emit a structured analysis artifact that the create-yb-fix-pr
  skill consumes. Use when the user supplies a yugabyte/yugabyte-db issue
  number or URL (e.g. "#32549") and asks to validate, confirm, reproduce,
  triage, or root-cause it.
---

# Validate YugabyteDB Issue

Take a public `yugabyte/yugabyte-db` GitHub issue from "someone reported this"
to a defensible verdict: root cause located in source, trigger conditions
characterized, and a deterministic reproduction that a maintainer can run.
The output is an analysis artifact that feeds directly into `create-yb-fix-pr`.

**Inputs:** issue number/URL (required), target version(s) (optional).
**Outputs:** verdict, `/tmp/claude/yb-issue-<NNNN>-analysis.md`, optional
public issue comment, memory note.

## Execution model — dispatch the subagent

This skill runs as a dispatcher in the main session; the heavy work happens in
the `yb-issue-validator` subagent (Fable, max thinking, full permissions).

**If you ARE the `yb-issue-validator` subagent, skip this section and execute
the Protocol below directly. Never re-dispatch.**

As the dispatcher:

1. Pin down the inputs: issue number/URL; any versions, platforms, or context
   the user supplied; whether the user has ALREADY authorized posting a
   comment to the public issue (default: not authorized).
2. Launch via the Task tool with `subagent_type: "yb-issue-validator"`. The
   prompt must contain: the issue reference, user-supplied context, the
   authorization state, the expected artifact path
   (`/tmp/claude/yb-issue-<NNNN>-analysis.md`), and the required return
   format (verdict, root cause file:line, trigger-matrix summary, repro
   commands, versions tested, artifact path, memory-note path, pending
   questions).
3. When the subagent returns with pending questions (e.g. "may I post the
   repro comment?"), relay them to the user via the question tool, then
   resume the same task (pass the prior `task_id`) with the answers.
4. Present the verdict and artifact path to the user; do not silently
   re-do the subagent's work in the main session.

## Protocol

### Public-artifact rule

The issue tracker is public. Every comment, script, log excerpt, and file name
you post is permanent and indexed. Apply `src/AGENTS.md` § Confidentiality to
anything leaving the machine: no customer identifiers, PII, unanonymized
schemas/queries, secrets, internal hostnames/URLs. If validation context came
from an internal source (support case, Slack), reproduce with synthetic inputs
and reference only public facts. When unsure whether a string is sensitive,
ask the user.

### Step 0: Memory recall first

Before touching the issue, search prior work (the issue may already be
validated — e.g. #32549 was fully validated, fixed, and memorialized):

1. Obsidian: `search-vault` with the issue number (`"32549"`) and with symptom
   keywords (`"snprintf CHECK failed"`), path `memories/`; `search-by-tags`
   with `["yugabyte-db"]` / `["yugabytedb"]`.
2. Cavemem: `search` with the issue number and symptom keywords.

A complete prior validation → reuse it; do not re-reproduce.

### Step 1: Fetch and parse the issue

Use the GitHub MCP (`github:get_issue`, issue comments) or `bash gh`:

```bash
gh issue view <NNNN> --repo yugabyte/yugabyte-db --json title,body,labels,comments
```

Extract into working notes:

- **Exact failure signature** — the verbatim log/FATAL/stack line, e.g.
  `date_time.cc:111] Check failed: result > 0 && result < sizeof(buffer)`.
  This literal string is your source-grep key and your repro success test.
- **Version(s) + platform/arch** reported.
- **Configuration that matters** — gflags, env (`TZ=...`), topology, RF.
- **Repro steps** as given (often incomplete — that's what you're validating).
- **Jira cross-link** (`DB-NNNNN`) if present; keep it in the analysis header.
- **Kind**: startup crash / runtime crash / wrong result / hang / perf /
  feature request. Feature requests get behavior-delta validation (current vs
  requested), not a crash repro (cf. #31078: validated by demonstrating what
  `pg_stat_statements.track = top` hides).

Component mapping (same table as `.claude/skills/create-issue/SKILL.md`):
`src/yb/` → DocDB, `src/postgres/` → YSQL, `src/yb/yql/cql/` → YCQL,
`managed/` → YBA, `docs/` → Docs.

### Step 2: Root-cause in source (read-only)

Work in this checkout; make no modifications in this skill.

1. **Locate the failure site.** Grep the literal signature; log lines carry
   `file.cc:NNN` directly. RELEASE-build stacks are unsymbolized (`(unknown)`
   frames) — symbolize by reading source, not the binary. A FATAL line in
   newer builds embeds the full build path (`.../src/yb/util/date_time.cc:111`),
   which proves the defect file:line for that version without a local build.
2. **Confirm on master AND the reported release.** Nearby lines shift between
   versions; the defect site is what must match. State explicitly whether
   master is still affected — it decides whether a fix PR is warranted.
3. **Trace the trigger path.** Walk callers until you can state *when* the code
   runs (startup? first use? background timer?) and *what input* makes it
   fail. Distinguish deterministic-at-startup from scheduled-later paths
   (e.g. a 3h-interval callback logged at startup is NOT the startup trigger).
4. **Predict the trigger matrix before running anything.** From the code,
   derive which conditions crash and which don't (e.g. "only negative UTC
   offsets with non-zero minutes"). The repro then confirms or falsifies your
   theory — a matrix that matches prediction is the strongest validation
   evidence you can produce.
5. **Delegate deep call-chain tracing** to the `@yb-sleuth` agent when the
   chain spans subsystems and you are running in the MAIN session; inside the
   `yb-issue-validator` subagent, do the tracing yourself (subagents cannot
   nest). Require file:line citations either way.

Cite everything as `path/to/file.cc:NNN`.

### Step 3: Deterministic reproduction

Prefer official container images over local builds — fast, version-pinned, and
maintainers can rerun them. `podman` is the runtime on this host.

- **Images:** `docker.io/yugabytedb/yugabyte:<tag>`. On Apple Silicon use the
  explicit `-aarch64` tag suffix. Pin explicit versions; also test the latest
  preview tag (tracks master) to show the bug is/isn't version-specific.
- **Binaries live at `/home/yugabyte/bin/`** inside the image and are NOT on
  PATH (`yb-master`, `yb-tserver`, `yugabyted`, `ysqlsh`, `ycqlsh`).
- **Fast path** — run the one daemon that crashes, directly, with minimal
  flags. Example shape (yb-master startup crash):

  ```sh
  podman run --rm -e TZ=America/St_Johns \
    docker.io/yugabytedb/yugabyte:2026.1.0.0-b118-aarch64 bash -lc '
    mkdir -p /tmp/m
    /home/yugabyte/bin/yb-master --fs_data_dirs=/tmp/m \
      --master_addresses=127.0.0.1:7100 --rpc_bind_addresses=127.0.0.1:7100 \
      --webserver_port=7000 --logtostderr'
  ```

- **User-facing path** — also confirm via `yugabyted start` when the issue was
  reported against it; daemon FATALs land in `<base_dir>/logs/master.err` /
  `tserver.err`, not on yugabyted's stdout.
- **Daemons don't exit on success.** For OK-vs-FAIL matrix cells: start
  backgrounded, `sleep 4`, then `grep -q "<failure signature>" out.log` →
  FAIL; else `kill -0 $pid` → OK.
- **Always include control cases** (e.g. `TZ=UTC` clean start) — causality
  needs both directions.
- **Run the full predicted matrix** from Step 2.4 and record every cell.
- **Artifacts** (`reproduce.sh`, `REPRODUCTION.md`, matrix logs) go under
  `/tmp/claude/` — NOT `~/scratch` (outside the opencode sandbox; a prior
  session's `~/scratch` repro became unreadable to later sessions). If a repro
  script is worth keeping, the durable public copy is the script pasted into
  the GitHub issue comment (Step 6).

Only fall back to a local build when containers can't express the repro.
macOS prereqs (from prior sessions): writable `/opt/yb-build`, Homebrew
`cmake` + `bash`, Python 3.11, JDK 11 with explicit `JAVA_HOME`, loopback
aliases `127.0.0.2`–`127.0.0.7` on `lo0` for mini-cluster tests. Build per
`src/AGENTS.md` (`yb_build.sh` only).

### Step 4: Verdict

Pick exactly one:

- **VALIDATED** — failure reproduced with the reported signature; root cause
  identified at file:line; trigger matrix matches the source-derived
  prediction.
- **NOT-REPRODUCED** — faithful repro attempts (documented) don't show the
  failure; state what differed from the reporter's environment.
- **NOT-A-BUG** — behavior is intended/documented; cite the doc or code
  comment.
- **NEEDS-INFO** — can't proceed without specifics; draft the follow-up
  questions for the reporter.

### Step 5: Write the handoff artifact

Write `/tmp/claude/yb-issue-<NNNN>-analysis.md` — the contract consumed by
`create-yb-fix-pr`:

```markdown
# Analysis: yugabyte/yugabyte-db#<NNNN> (<Jira DB-NNNNN if any>)

## Verdict
VALIDATED | NOT-REPRODUCED | NOT-A-BUG | NEEDS-INFO — one-line justification.

## Root cause
<file.cc:NNN> — mechanism in 2-5 sentences (what value flows in, what
invariant breaks, why the failure presents as reported).

## Trigger matrix
| condition | expected | observed |

## Reproduction
Exact commands + image tags + failure signature to grep for. Control case.

## Versions tested
<tags/SHAs>; master affected: yes/no (evidence).

## Proposed fix direction
Files to change, approach, alternatives considered. Known edge cases the fix
must cover (feed Gemini/review findings here if any exist).

## Test strategy
Which existing test file/target covers this area; how to exercise the fixed
path via PUBLIC entry points (no test-only production APIs); e.g. env-driven
cases, `--cxx-test <target> --gtest_filter '<Case>'`.

## Confidentiality check
Confirm the artifact contains no customer data / PII / internal refs.
```

### Step 6 (optional): Comment on the issue — authorization required

Never post without explicit user authorization. Inside the subagent: if the
dispatch prompt did not pre-authorize posting, ask via the question tool; if
no human answer is reachable, return the drafted comment to the caller as a
pending item instead. When authorized: confirm the repro (versions, arch),
include the self-contained repro script inline, the trigger matrix, and the
root-cause file:line. Scrub per the public-artifact rule. Append the agent
signature block per `src/AGENTS.md`:

```
---
_automated · <agent>_
```

### Step 7: Memory

Bug root cause identified → memory-worthy by definition. Dedup first (search
tags + issue number), then create/update
`memories/<date>-yb-<slug>.md` covering: signature, root cause file:line,
trigger matrix, repro commands, verdict, and — if a fix follows — a pointer to
the PR. Exemplar: `memories/2026-07-09-yb-master-negative-halfhour-tz-crash.md`.
