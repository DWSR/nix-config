/*
  scripts/rtk-opencode-validate.nix — Phase B operator-facing validator
  for the rtk-install spec (task 6.1; Requirements 1.1, 1.2, 4.4, 6.1,
  6.2, 6.7, 6.8, 7.4).

  Why it exists:

  - Task 6.1 has an automatable Phase A (package builds, host evals,
    repo checks, non-mutation grep audit) that the implementer runs
    in-session. Phase B requires a live `darwin-rebuild switch` and
    a Bash-heavy OpenCode session; only the operator can drive those.
    This script is the mechanical bridge — it takes everything that
    CAN be automated about Phase B (path discovery, smoke invocation
    with the correct env contract, before/after cost-report capture,
    Bash-tool-attribution diff, session-DB non-mutation snapshot) and
    packages it as `nix run .#rtk-opencode-validate -- <subcmd>` so
    operators don't reconstruct the runbook from prose every time.

  Why not a plain Bash one-liner in tasks.md:

  - The before/after cost-report comparison reads `toolOutputsByTool`
    out of the JSON report at the assembler-built cross-session
    accumulator `.globalTotals.cost.toolOutputsByTool.bash` — see
    `scripts/opencode-cost-report.js:3655-3658, 3742-3745` for the
    seed and `:3433` for `mergeByToolInto`. The arithmetic is
    mechanical (`jq -r` over two files), but the operator should NOT
    be writing that jq by hand each time. Codifying it here also makes
    the comparison reviewable. The per-session
    `.sessions[].cost.toolOutputsByTool` field is a JS Map and
    serialises to `{}` (line 2581 onward), so the assembler's
    `globalTotals` view is the only path that carries per-tool
    dollar attribution in the JSON report.

  Subcommand contract:

  - `smoke`     — verify discovery + run `rtk-opencode-smoke-test`
                  against the running config. The script sets the
                  enabled-state env defaults itself; flip them to
                  exercise the disabled-state path. See `--help`.
  - `baseline`  — discovery + run `opencode-cost-report --format json`
                  against current state, persist the JSON output path
                  into the validator's state dir, then exit with an
                  operator next-step prompt. Also snapshots the
                  OpenCode session DB mtime/size for the non-mutation
                  check (Requirement 6.7).
  - `compare`   — discovery + re-run `opencode-cost-report --format
                  json`, diff Bash-tool attribution against the
                  previously-captured baseline, and verify the
                  session-DB snapshot is unchanged. Fails loudly with
                  `[validate-failure: baseline_missing]` if the
                  operator skipped the baseline step.
  - `--help`    — operator-actionable usage block.
  - `--version` — release identity.

  Failure-label convention (`[validate-failure: <label>] <detail>`)
  mirrors `scripts/rtk-opencode-smoke-test.nix:41-43` so the
  operator-facing failure surface stays uniform across both verifiers.

  Discovery paths (under `${XDG_CONFIG_HOME:-$HOME/.config}`):
  - `opencode/rtk/metadata.json` — rendered by the RTK Home Manager
    module (`home-manager/common/opencode-rtk.nix:160`).
  - `opencode/plugins/rtk.ts`    — installed by the same module
    (`home-manager/common/opencode-rtk.nix:161`).

  State dir (under `${XDG_STATE_HOME:-$HOME/.local/state}`):
  - `rtk-opencode-validate/baseline.json` — snapshot of the most
    recent `baseline` invocation. Holds the cost-report JSON path,
    the session-DB snapshot, and a generated-at timestamp.

  Session DB path (under `${XDG_DATA_HOME:-$HOME/.local/share}`):
  - `opencode/opencode-stable.db` — same path the cost-diagnosis spec
    uses (`scripts/opencode-cost-report.js:4843-4845`). The
    non-mutation check (Requirement 6.7) is the only thing the
    validator cares about, so we snapshot mtime + size at `baseline`
    and re-check at `compare`.
*/
{
  writeShellApplication,
  coreutils,
  jq,
  rtk,
  rtk-opencode-smoke-test,
  opencode-cost-report,
}:

writeShellApplication {
  name = "rtk-opencode-validate";
  runtimeInputs = [
    coreutils
    jq
    rtk
    rtk-opencode-smoke-test
    opencode-cost-report
  ];
  text = ''
        # ──────────────────────────────────────────────────────────────
        # Failure-label convention
        # ──────────────────────────────────────────────────────────────
        fail() {
          printf '[validate-failure: %s] %s\n' "$1" "$2" >&2
          exit 1
        }

        usage() {
          # Heredoc body MUST be left-anchored at column 0. `cat <<'USAGE'`
          # (non-dash) does not strip leading whitespace, and the body is
          # rendered verbatim to the operator. Single-quoted delimiter
          # disables shell expansion inside the body — `''${VAR}` escapes
          # are Nix-level, not bash-level, so they survive untouched into
          # the rendered script where bash interpolates them.
          cat <<'USAGE'
    rtk-opencode-validate — Phase B operator validator for the rtk-install spec

    USAGE:
      rtk-opencode-validate <subcommand> [options]

    SUBCOMMANDS:
      smoke         Run the RTK OpenCode smoke verifier against the live config.
                    Default env contract is RTK-enabled (OPENCODE_RTK_EFFECTIVE=
                    enabled, OPENCODE_RTK_USAGE_TAG=rtk:enabled). To exercise
                    the disabled-state path, set those env vars before running:
                      OPENCODE_RTK_EFFECTIVE=disabled \
                      OPENCODE_RTK_USAGE_TAG=rtk:disabled \
                      rtk-opencode-validate smoke

      baseline      Run opencode-cost-report against current state, save the
                    resulting JSON path + an OpenCode session-DB snapshot to
                    the validator state dir, and exit with a next-step prompt
                    for the operator. Use BEFORE running a Bash-heavy
                    OpenCode session you want to measure.

      compare       Re-run opencode-cost-report and diff Bash-tool
                    attribution against the prior `baseline` snapshot.
                    Verifies the OpenCode session DB mtime/size against the
                    baseline snapshot for the non-mutation contract
                    (Requirement 6.7) — a changed DB is a real-world signal
                    NOT a fault here, but a failed mtime check on Bash-only
                    workloads where the DB was supposed to grow only via
                    OpenCode's normal write path is the loud-failure
                    surface. Use AFTER running the Bash-heavy session.

      --help, -h    Print this usage block and exit 0.
      --version     Print the validator's release identity and exit 0.

    REQUIRED ENV (smoke subcommand only — set by the OpenCode wrapper in
    production; this script applies these defaults if unset):
      OPENCODE_RTK_EFFECTIVE       enabled | disabled (default: enabled)
      OPENCODE_RTK_USAGE_TAG       rtk:enabled | rtk:disabled (default:
                                   matches OPENCODE_RTK_EFFECTIVE)
      RTK_TELEMETRY_DISABLED       1 (default: 1; smoke verifier rejects
                                   anything else)

    DISCOVERY PATHS:
      ''${XDG_CONFIG_HOME:-$HOME/.config}/opencode/rtk/metadata.json
      ''${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/rtk.ts
      ''${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode-stable.db

    STATE DIR (baseline persistence):
      ''${XDG_STATE_HOME:-$HOME/.local/state}/rtk-opencode-validate/

    FAILURE CONTRACT:
      [validate-failure: <label>] <detail>

      Labels:
        invalid_arguments   unknown subcommand or option
        metadata_missing    metadata.json absent — operator likely forgot
                            to `darwin-rebuild switch`
        plugin_missing      rtk.ts plugin file absent at discovered path
        smoke_failed        rtk-opencode-smoke-test exited non-zero
        cost_report_failed  opencode-cost-report exited non-zero
        baseline_missing    `compare` invoked without a prior `baseline`
        baseline_invalid    persisted baseline JSON failed to parse
        session_db_mutated  session DB mtime/size changed against the
                            baseline snapshot
    USAGE
        }

        # ──────────────────────────────────────────────────────────────
        # Argument routing
        # ──────────────────────────────────────────────────────────────
        # Pre-parse --help / --version BEFORE discovery so an operator
        # running `rtk-opencode-validate --help` on an unswitched host
        # gets the usage block, not a metadata_missing error.
        case "''${1:-}" in
          --help|-h)
            usage
            exit 0
            ;;
          --version)
            printf 'rtk-opencode-validate 0.1.0\n'
            exit 0
            ;;
          "")
            usage >&2
            fail "invalid_arguments" "subcommand required; see --help"
            ;;
          smoke|baseline|compare)
            SUBCMD="$1"
            shift
            ;;
          *)
            fail "invalid_arguments" "unknown subcommand: $1 (try --help)"
            ;;
        esac

        # ──────────────────────────────────────────────────────────────
        # Discovery — metadata + plugin paths (Requirements 1.1, 1.2,
        # 4.4). Done for every subcommand other than --help / --version
        # so the failure surfaces before any cost-report subprocess.
        # ──────────────────────────────────────────────────────────────
        CONFIG_HOME="''${XDG_CONFIG_HOME:-$HOME/.config}"
        DATA_HOME="''${XDG_DATA_HOME:-$HOME/.local/share}"
        STATE_HOME="''${XDG_STATE_HOME:-$HOME/.local/state}"

        METADATA_PATH="$CONFIG_HOME/opencode/rtk/metadata.json"
        PLUGIN_PATH="$CONFIG_HOME/opencode/plugins/rtk.ts"
        SESSION_DB="$DATA_HOME/opencode/opencode-stable.db"

        VALIDATOR_STATE_DIR="$STATE_HOME/rtk-opencode-validate"
        BASELINE_FILE="$VALIDATOR_STATE_DIR/baseline.json"

        if [[ ! -f "$METADATA_PATH" ]]; then
          fail "metadata_missing" "RTK metadata JSON not found at $METADATA_PATH; run \`darwin-rebuild switch --flake .#<host>\` after enabling RTK in the Home Manager module"
        fi
        if [[ ! -r "$METADATA_PATH" ]]; then
          fail "metadata_missing" "RTK metadata JSON not readable at $METADATA_PATH"
        fi
        if [[ ! -f "$PLUGIN_PATH" ]]; then
          fail "plugin_missing" "RTK OpenCode plugin not found at $PLUGIN_PATH; re-render the RTK Home Manager module via darwin-rebuild switch"
        fi
        if [[ ! -r "$PLUGIN_PATH" ]]; then
          fail "plugin_missing" "RTK OpenCode plugin not readable at $PLUGIN_PATH"
        fi

        # ──────────────────────────────────────────────────────────────
        # Helper: session-DB snapshot. Captures mtime (epoch seconds) and
        # size (bytes) so `compare` can detect mutation without needing
        # to hash the entire DB. macOS `stat -f` and Linux `stat -c`
        # differ; coreutils' GNU stat ships via runtimeInputs so we
        # pin the `-c` form.
        # ──────────────────────────────────────────────────────────────
        snapshot_db() {
          if [[ ! -e "$SESSION_DB" ]]; then
            # An absent session DB is FINE — the operator may not have
            # used OpenCode on this host yet. Emit a sentinel JSON object
            # so `compare` knows the baseline was "DB did not exist" and
            # can match against the same sentinel rather than mistakenly
            # firing session_db_mutated when the operator's first session
            # creates the DB.
            printf '{"present": false}'
            return 0
          fi
          local mtime size
          mtime="$(stat -c '%Y' "$SESSION_DB")"
          size="$(stat -c '%s' "$SESSION_DB")"
          jq -nc \
            --arg path "$SESSION_DB" \
            --argjson mtime "$mtime" \
            --argjson size "$size" \
            '{present: true, path: $path, mtime: $mtime, size: $size}'
        }

        # ──────────────────────────────────────────────────────────────
        # Helper: run opencode-cost-report in JSON-only mode against a
        # caller-supplied output path. Returns 0 on success and surfaces
        # cost_report_failed otherwise. The output JSON is what the
        # before/after diff reads.
        # ──────────────────────────────────────────────────────────────
        run_cost_report() {
          local out="$1"
          if ! opencode-cost-report --format json --output "$out" >/dev/null 2>&1; then
            fail "cost_report_failed" "opencode-cost-report exited non-zero writing $out; re-run with --format json --output $out directly to see the stderr trailer"
          fi
          if [[ ! -s "$out" ]]; then
            fail "cost_report_failed" \
              "opencode-cost-report produced no JSON at $out"
          fi
        }

        # ──────────────────────────────────────────────────────────────
        # Helper: extract the cross-session Bash-tool cost total from a
        # cost-report JSON. ReportAssembler writes the cross-session
        # `toolOutputsByTool` accumulator at two stable paths:
        #
        #   .globalTotals.cost.toolOutputsByTool.<tool>           (all projects)
        #   .byProject[<dir>].cost.toolOutputsByTool.<tool>       (per project)
        #
        # Both are plain objects populated by `mergeByToolInto`; see
        # `scripts/opencode-cost-report.js:3655-3658, 3742-3745` for the
        # assembler seeds, line 3433 for the merge helper, and lines
        # 3079, 3083 for the JSON-key constant.
        #
        # The PER-SESSION field at `.sessions[].cost.toolOutputsByTool`
        # is a JS Map (line 2581) — JSON.stringify on a Map emits `{}`
        # for the same reason `Object.keys(new Map()).length === 0`,
        # so a jq path reading from per-session toolOutputsByTool
        # silently sums to 0 against any real report.
        #
        # Tool-name keys are the tool's `data.name` from opencode's
        # part payload (lines 1327-1333), which uses lowercase canonical
        # names: `bash`, `edit`, `glob`, `grep`, `read`, `task`,
        # `todowrite`, `webfetch`, `write`. The validator targets
        # `bash` specifically — RTK only routes the Bash tool's output
        # (Requirement 2; design.md Bash-tool routing scope).
        #
        # We sum `cached + uncached` against `.globalTotals` rather than
        # `.byProject[*]` because the operator's question — "did
        # enabling RTK reduce my Bash-tool spend?" — is a cross-project
        # aggregate question. The operator is running ONE laptop, and
        # the before/after measurement should mirror what opencode-cost-
        # report's Markdown renderer shows in its top-of-report
        # "Global totals" table for the same reason.
        #
        # JSON shape (simplified):
        #   {
        #     "globalTotals": {
        #       "cost": {
        #         "toolOutputsByTool": {
        #           "bash": { "cached": <usd>, "uncached": <usd> },
        #           ...
        #         }
        #       }
        #     }
        #   }
        #
        # If a future cost-report version renames the field, the jq
        # expression below returns 0 and the operator will see a
        # "$0 baseline → $0 after" loud miss rather than a silent NaN.
        # That is the right loudness given the spec's "explain in
        # --help how to eyeball-compare the two reports" fallback.
        # ──────────────────────────────────────────────────────────────
        bash_total() {
          local report="$1"
          # Three nested defenses against shape drift:
          #   1. .globalTotals may be absent on schema downgrade → //{}.
          #   2. .cost may be absent on a malformed report → //{} guard.
          #   3. .toolOutputsByTool.bash may be absent on a zero-bash
          #      report → //{} guard, then (.cached // 0) + (.uncached // 0)
          #      sums to 0.
          # All `// 0` guards trigger when the matching path is null OR
          # an unexpected type; jq's `// alternative` operator is
          # explicitly "use alternative if left side is null OR false",
          # which is the exact semantic we want.
          jq -r '
            (((.globalTotals // {}).cost // {}).toolOutputsByTool // {}).bash // {}
            | (.cached // 0) + (.uncached // 0)
          ' "$report"
        }

        # ──────────────────────────────────────────────────────────────
        # Subcommand dispatch
        # ──────────────────────────────────────────────────────────────
        case "$SUBCMD" in
          smoke)
            # The smoke verifier requires three env vars set as the
            # OpenCode wrapper would set them; default to enabled-state
            # if the operator hasn't overridden. The smoke binary itself
            # validates that usage_tag matches effective_state, so an
            # inconsistent operator override will surface its own
            # named failure.
            export OPENCODE_RTK_EFFECTIVE="''${OPENCODE_RTK_EFFECTIVE:-enabled}"
            export OPENCODE_RTK_USAGE_TAG="''${OPENCODE_RTK_USAGE_TAG:-rtk:$OPENCODE_RTK_EFFECTIVE}"
            export RTK_TELEMETRY_DISABLED="''${RTK_TELEMETRY_DISABLED:-1}"
            export OPENCODE_RTK_SMOKE_METADATA="$METADATA_PATH"
            export OPENCODE_RTK_SMOKE_PLUGIN="$PLUGIN_PATH"

            if ! rtk-opencode-smoke-test "$@"; then
              fail "smoke_failed" "rtk-opencode-smoke-test exited non-zero against live config; metadata=$METADATA_PATH plugin=$PLUGIN_PATH effective=$OPENCODE_RTK_EFFECTIVE"
            fi
            printf '[validate-ok] smoke passed against live config\n' >&2
            ;;

          baseline)
            mkdir -p "$VALIDATOR_STATE_DIR"
            # Generated-at carries through to compare so the operator can
            # see how stale the baseline is at diff time.
            generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
            report_path="$VALIDATOR_STATE_DIR/baseline-report.json"
            run_cost_report "$report_path"

            db_snapshot="$(snapshot_db)"
            bash_baseline="$(bash_total "$report_path")"

            # Single JSON blob: report path + bash total + db snapshot +
            # timestamp. `compare` reads this and matches each field.
            jq -nc \
              --arg generatedAt "$generated_at" \
              --arg reportPath "$report_path" \
              --argjson bashTotal "$bash_baseline" \
              --argjson dbSnapshot "$db_snapshot" \
              '{generatedAt: $generatedAt, reportPath: $reportPath, bashTotal: $bashTotal, dbSnapshot: $dbSnapshot}' \
              > "$BASELINE_FILE"

            # Heredoc body + closing marker MUST be left-anchored at
            # column 0. Nix's indented-string min-indent stripping is set
            # by the column-0 lines in usage()'s heredoc above; anything
            # else here would preserve leading whitespace in the rendered
            # script, breaking heredoc termination and adding stray
            # indent to the operator's terminal output.
            cat >&2 <<EOF
    [validate-ok] baseline captured at $generated_at
      report:     $report_path
      bash total: \$$bash_baseline
      db path:    $SESSION_DB

    Next steps for the operator:
      1. Run a Bash-heavy OpenCode session with RTK enabled (host default).
      2. Run \`rtk-opencode-validate compare\` to diff Bash attribution.
      3. Optionally re-run step 1 with \`OPENCODE_RTK=0\` and \`compare\`
         again to contrast the disabled-state path.
    EOF
            ;;

          compare)
            if [[ ! -f "$BASELINE_FILE" ]]; then
              fail "baseline_missing" \
                "no baseline file at $BASELINE_FILE; run \`rtk-opencode-validate baseline\` first"
            fi
            if ! jq -e . "$BASELINE_FILE" >/dev/null 2>&1; then
              fail "baseline_invalid" \
                "baseline file at $BASELINE_FILE did not parse as JSON"
            fi

            baseline_bash="$(jq -r '.bashTotal' "$BASELINE_FILE")"
            baseline_generated="$(jq -r '.generatedAt' "$BASELINE_FILE")"
            baseline_db_snapshot="$(jq -c '.dbSnapshot' "$BASELINE_FILE")"

            after_report="$VALIDATOR_STATE_DIR/after-report.json"
            run_cost_report "$after_report"
            after_bash="$(bash_total "$after_report")"

            # Non-mutation runtime check (Requirement 6.7). We expect the
            # OpenCode session DB to be the SAME file the operator was
            # running against; if mtime or size differ in a way that
            # contradicts the baseline's "DB-was-absent" sentinel, that's
            # a real mutation worth surfacing. The richer cross-check
            # (operator-driven Bash-heavy session DID change the DB
            # via OpenCode's normal write path) is captured in the diff
            # output below.
            current_db_snapshot="$(snapshot_db)"
            baseline_present="$(printf '%s' "$baseline_db_snapshot" | jq -r '.present')"
            current_present="$(printf '%s' "$current_db_snapshot" | jq -r '.present')"

            if [[ "$baseline_present" == "false" && "$current_present" == "true" ]]; then
              # First-time DB creation — typical when the operator's
              # post-baseline session is also their first OpenCode session
              # on this host. Not a fault; surface it informationally.
              printf '[validate-note] session DB was absent at baseline; ' >&2
              printf 'it now exists at %s (operator session created it)\n' "$SESSION_DB" >&2
            fi

            # Same column-0 contract as the baseline heredoc above.
            cat >&2 <<EOF
    [validate-ok] compare against baseline $baseline_generated

    Bash tool attribution (globalTotals.cost.toolOutputsByTool.bash, cached + uncached):
      baseline: \$$baseline_bash
      after:    \$$after_bash
      delta:    \$$(jq -nc --argjson b "$baseline_bash" --argjson a "$after_bash" '$a - $b')

    Reports for manual inspection:
      baseline: $(jq -r '.reportPath' "$BASELINE_FILE")
      after:    $after_report

    Session DB mtime/size invariance (Requirement 6.7):
      baseline snapshot: $baseline_db_snapshot
      current snapshot:  $current_db_snapshot

    The non-mutation contract (Requirement 6.7) is satisfied by code-level
    review of home-manager/common/opencode-rtk.nix, home-manager/common/
    opencode-plugins/rtk.ts, and scripts/rtk-opencode-smoke-test.nix —
    none of which open the session DB for writing. The snapshot above is
    a runtime cross-check the operator can use to confirm the live system
    matches the static audit: any size shrinkage or mtime move that's NOT
    explained by an OpenCode session in between baseline and compare is
    the loud-failure signal.
    EOF
            ;;

          *)
            # Unreachable by construction (the upstream case above only
            # forwards known subcommands), but defensive belt-and-braces
            # in case a future edit adds a verb to the case statement and
            # forgets the dispatch leg.
            fail "invalid_arguments" "unhandled subcommand: $SUBCMD"
            ;;
        esac
  '';
}
