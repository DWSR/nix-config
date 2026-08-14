/*
  scripts/cavemem-smoke-test.nix — runtime verifier for the patched
  `pkgs.cavemem` derivation (Task 8.1 of the cavemem-integration spec;
  Requirements 9.1-9.6 + 10.6).

  Why a `writeShellApplication` and not a one-liner inlined into the HM
  module:

  - The smoke test is the contract enforcement boundary for four
    independent upstream patches (overlays/cavemem-14-*, -25-*, -39-*,
    -data-dir-env). Shipping it as a real script under `scripts/` keeps
    the assertions diffable and reviewable, and lets the operator run
    `cavemem-smoke-test` directly after a `nix flake update` to confirm
    a cavemem version bump didn't silently regress any of the four
    bugs.
  - `writeShellApplication` brings shellcheck against the body for
    free, enables `set -euo pipefail` by default, and locks runtime
    inputs onto the closure so the test is reproducible regardless of
    the operator's PATH.

  Why the four checks are independent (not short-circuiting):

  - The task contract (tasks.md §8.1) requires that "one failure does
    not skip the others" — operators investigating a regression need
    the full failure set to triage which patches survived a version
    bump and which didn't. The aggregate exit code is computed at the
    tail from a `fail_labels` array.

  Why a temp dataDir (mktemp -d + EXIT trap):

  - The test must not pollute the operator's real `~/.cavemem` /
    `${"$"}{home.cavemem.dataDir}` SQLite database with smoke-test
    sessions and observations. The patched cavemem honors
    `CAVEMEM_DATA_DIR` (overlays/cavemem-data-dir-env.patch, task 1.3)
    so pointing every cavemem invocation at a `mktemp -d` directory
    fully isolates the test.
  - The EXIT trap removes the directory on success and on every
    failure path including signals. cavemem's hook runner fires
    `ensureWorkerRunning` after every non-session-end hook, which
    spawns a detached background worker; we set `CAVEMEM_NO_AUTOSTART=1`
    to suppress that spawn so the smoke test exits cleanly with no
    zombie processes (auto-spawn.ts honors the env var).
*/
{
  cavemem,
  coreutils,
  jq,
  sqlite,
  writeShellApplication,
}:

writeShellApplication {
  name = "cavemem-smoke-test";
  runtimeInputs = [
    cavemem
    coreutils
    jq
    sqlite
  ];
  text = ''
    # Temp dataDir: cavemem's data.db, settings.json, worker.pid,
    # worker.state.json, and models/ all resolve under
    # `${"$"}{CAVEMEM_DATA_DIR}` thanks to the resolveDataDir() patch
    # (overlays/cavemem-data-dir-env.patch). The first `cavemem hook
    # run` invocation inside the test will materialise data.db here
    # automatically — Storage's constructor calls mkdirSync + opens
    # `data.db` (NOT `cavemem.db`; see Implementation Notes from
    # task 7.2) on first use, so no separate bootstrap is needed.
    tmpdir="$(mktemp -d -t cavemem-smoke-test.XXXXXX)"
    export CAVEMEM_DATA_DIR="$tmpdir"

    # On every exit path (success, error, INT, TERM): tear down the
    # temp dataDir. The detached worker is suppressed below via
    # CAVEMEM_NO_AUTOSTART so there are no zombie children to chase.
    trap 'rm -rf -- "$tmpdir"' EXIT

    # Suppress kleur ANSI escape codes from `cavemem config show` so
    # the bug-25 grep can match the description text literally.
    export NO_COLOR=1

    # Suppress the post-hook `ensureWorkerRunning` spawn — the worker
    # would just churn against an empty dataDir and dirty up the
    # process table for no value here. Honored by
    # `packages/hooks/src/auto-spawn.ts` in cavemem v0.2.x.
    export CAVEMEM_NO_AUTOSTART=1

    # Each check appends to fail_labels on failure. Aggregate exit at
    # the tail of the script returns 0 iff this array is empty.
    fail_labels=()

    # ----------------------------------------------------------------
    # bug-14: post-tool-use captures both input and output (Req 9.1)
    # ----------------------------------------------------------------
    # The cavemem post-tool-use handler builds the observation body as
    #   `${"$"}{tool} input=${"$"}{stringify(input)} output=${"$"}{stringify(output)}`
    # and persists the result via addObservation (which redacts +
    # compresses + INSERTs into observations).
    #
    # Upstream bug #14 (closed by overlays/cavemem-14-hook-payload-
    # shape.patch) was that the opencode plugin emitted a payload
    # with `tool_input` and `tool_response` undefined, so cavemem
    # stored `Read input= output=` for every tool call — the entire
    # captured-context surface was empty. The patched plugin emits
    # `tool_input: args` and `tool_response: output?.output ??
    # output?.title ?? null`, populating both halves.
    #
    # We send the payload directly to `cavemem hook run post-tool-use`
    # rather than going through opencode: the test verifies that the
    # cavemem handler faithfully persists what a correctly-shaped
    # payload contains. (The vendored plugin file at
    # `home-manager/common/opencode-plugins/cavemem.js` is the
    # upstream-fixed shape; the inline `dist/index.js` plugin emitter
    # in pkgs.cavemem matches it via the bug-14 patch. Both paths
    # produce the same payload shape that we reproduce here.)
    #
    # Markers: 17-char alphanumeric tokens distinct from any cavemem
    # compress() stop-list entry (pleasantries / hedges / fillers /
    # articles / abbreviations) so they survive the compress pass
    # verbatim and remain greppable in the stored content. The
    # surrounding JSON path `/tmp/cavemem-smoke` separately matches
    # the tokenizer's path rule and is preserved as a single segment,
    # which keeps the body shape close to what opencode emits in
    # production.
    bug14_input_marker="INPUTMARKERXYZ987"
    bug14_output_marker="OUTPUTMARKERXYZ987"
    bug14_payload=$(jq -nc \
      --arg sid "bug14-session" \
      --arg tin "$bug14_input_marker" \
      --arg tout "$bug14_output_marker" '
      {
        session_id: $sid,
        tool_name: "Read",
        tool_input: { file_path: "/tmp/cavemem-smoke", marker: $tin },
        tool_response: { output: $tout, status: "ok" }
      }')

    if ! printf '%s' "$bug14_payload" \
      | cavemem hook run post-tool-use --ide opencode >/dev/null 2>&1; then
      echo "FAIL: bug-14: cavemem hook run post-tool-use exited non-zero" >&2
      fail_labels+=("bug-14")
    else
      # The handler always writes the freshest observation last; ORDER
      # BY id DESC LIMIT 1 picks it without depending on a session-id
      # filter (the runner's `ensureSession` may also have inserted a
      # row for the synthetic session id, so the count of observations
      # for this session_id is 1).
      bug14_content=$(sqlite3 "$tmpdir/data.db" \
        "SELECT content FROM observations ORDER BY id DESC LIMIT 1;" \
        2>/dev/null || true)
      if [ -z "$bug14_content" ]; then
        echo "FAIL: bug-14: no observation row produced" >&2
        fail_labels+=("bug-14")
      elif ! printf '%s' "$bug14_content" | grep -qF "$bug14_input_marker"; then
        echo "FAIL: bug-14: input marker absent from observation content" >&2
        fail_labels+=("bug-14")
      elif ! printf '%s' "$bug14_content" | grep -qF "$bug14_output_marker"; then
        echo "FAIL: bug-14: output marker absent from observation content" >&2
        fail_labels+=("bug-14")
      else
        echo "OK: bug-14"
      fi
    fi

    # ----------------------------------------------------------------
    # Pi default mode: omission preserves compressed legacy behavior
    # ----------------------------------------------------------------
    pi_default_prefix=$(printf 'D%.0s' {1..600})
    pi_default_payload=$(jq -nc \
      --arg marker "${"$"}pi_default_prefix-default-tail" '
      {
        session_id: "pi-default-mode-session",
        tool_name: "Read",
        tool_input: { marker: $marker },
        tool_response: { status: "ok" }
      }')

    if ! printf '%s' "${"$"}pi_default_payload" \
      | cavemem hook run post-tool-use --ide opencode >/dev/null 2>&1; then
      echo "FAIL: pi-default-mode: omitted capture mode exited non-zero" >&2
      fail_labels+=("pi-default-mode")
    else
      pi_default_state=$(sqlite3 "${"$"}tmpdir/data.db" \
        "SELECT compressed || '|' || COALESCE(intensity, 'NULL')
         FROM observations WHERE session_id = 'pi-default-mode-session';" \
        2>/dev/null || true)
      pi_default_content=$(sqlite3 "${"$"}tmpdir/data.db" \
        "SELECT content FROM observations
         WHERE session_id = 'pi-default-mode-session';" \
        2>/dev/null || true)
      if [ "${"$"}pi_default_state" != "1|full" ]; then
        echo "FAIL: pi-default-mode: expected compressed=1 and intensity=full" >&2
        fail_labels+=("pi-default-mode")
      elif printf '%s' "${"$"}pi_default_content" | grep -qF "default-tail"; then
        echo "FAIL: pi-default-mode: legacy 500-character truncation was bypassed" >&2
        fail_labels+=("pi-default-mode")
      else
        echo "OK: pi-default-mode"
      fi
    fi

    # ----------------------------------------------------------------
    # Pi invalid mode: fail before inserting any observation
    # ----------------------------------------------------------------
    pi_invalid_before=$(sqlite3 "${"$"}tmpdir/data.db" \
      "SELECT COUNT(*) FROM observations;" 2>/dev/null || true)
    pi_invalid_stdout="${"$"}tmpdir/pi-invalid-stdout.txt"
    pi_invalid_stderr="${"$"}tmpdir/pi-invalid-stderr.txt"
    if printf '%s' "${"$"}pi_default_payload" \
      | cavemem hook run post-tool-use --ide pi --capture-mode pi-full-v2 \
        >"${"$"}pi_invalid_stdout" 2>"${"$"}pi_invalid_stderr"; then
      echo "FAIL: pi-invalid-mode: unsupported mode exited zero" >&2
      fail_labels+=("pi-invalid-mode")
    else
      pi_invalid_after=$(sqlite3 "${"$"}tmpdir/data.db" \
        "SELECT COUNT(*) FROM observations;" 2>/dev/null || true)
      if [ "${"$"}pi_invalid_after" != "${"$"}pi_invalid_before" ]; then
        echo "FAIL: pi-invalid-mode: unsupported mode inserted an observation" >&2
        fail_labels+=("pi-invalid-mode")
      elif [ -s "${"$"}pi_invalid_stdout" ]; then
        echo "FAIL: pi-invalid-mode: unsupported mode wrote protocol output" >&2
        fail_labels+=("pi-invalid-mode")
      elif ! grep -qF '"error":"unknown capture mode pi-full-v2"' \
        "${"$"}pi_invalid_stderr"; then
        echo "FAIL: pi-invalid-mode: expected diagnostic was absent" >&2
        fail_labels+=("pi-invalid-mode")
      else
        echo "OK: pi-invalid-mode"
      fi
    fi

    # ----------------------------------------------------------------
    # bug-39: session-start hints scoped to current cwd (Req 9.2)
    # ----------------------------------------------------------------
    # The patched session-start handler (overlays/cavemem-39-session-
    # start-cwd-filter.patch) filters listSessions() by
    # `s.id !== input.session_id && s.cwd === input.cwd` before
    # collecting summaries for the prior-context surface. The
    # unpatched handler had no cwd filter and would echo summaries
    # from ALL recent sessions across every cwd into the new
    # session's stdout — the cross-project leak the patch closes.
    #
    # Reproduction:
    #   1. Bootstrap session A in cwd-a via session-start.
    #   2. Insert a summary for session A directly via SQL with a
    #      distinctive leak marker. cavemem v0.2.x has no CLI for
    #      inserting summaries, but the realistic scenario is "stop
    #      hook auto-generated a session summary" — the table shape
    #      and listSummaries() consumer are the same regardless of
    #      who wrote the row. Direct SQL bypasses compress() so the
    #      marker is preserved verbatim through to the consumer.
    #   3. Run session-start for session B in cwd-b. With the patched
    #      filter, A is dropped, hints array is empty, the handler
    #      returns an empty string, and writeIdeOutput emits NOTHING
    #      on stdout. With the unpatched filter, A summary content
    #      (with the marker) ends up in B stdout via the JSON
    #      additionalContext payload.
    #
    # Assertion: B's stdout MUST NOT contain the marker. This is the
    # negative test that catches the leak. The positive control
    # (B's stdout DOES contain its own session's hints when cwd
    # matches) is not exercised here — B has no prior-cwd-matching
    # session, so its stdout is simply empty under the patched code.
    bug39_marker="SECRETLEAKMARKERZ123"
    bug39_a_payload=$(jq -nc '
      { session_id: "bug39-session-a", ide: "opencode",
        cwd: "/tmp/cwd-a", source: "startup" }')
    bug39_b_payload=$(jq -nc '
      { session_id: "bug39-session-b", ide: "opencode",
        cwd: "/tmp/cwd-b", source: "startup" }')

    if ! printf '%s' "$bug39_a_payload" \
      | cavemem hook run session-start --ide opencode >/dev/null 2>&1; then
      echo "FAIL: bug-39: session-start for session A exited non-zero" >&2
      fail_labels+=("bug-39")
    else
      # Confirm session A landed with the right cwd. If the row is
      # missing or has the wrong cwd, the test setup itself broke;
      # report it as bug-39 since this is what the rest of the check
      # depends on.
      bug39_a_cwd=$(sqlite3 "$tmpdir/data.db" \
        "SELECT cwd FROM sessions WHERE id = 'bug39-session-a';" \
        2>/dev/null || true)
      if [ "$bug39_a_cwd" != "/tmp/cwd-a" ]; then
        echo "FAIL: bug-39: session A cwd not stored (got '$bug39_a_cwd')" >&2
        fail_labels+=("bug-39")
      elif ! sqlite3 "$tmpdir/data.db" \
        "INSERT INTO summaries(session_id, scope, content, compressed, intensity, ts)
         VALUES ('bug39-session-a', 'session', '$bug39_marker', 0, 'full',
                 CAST(strftime('%s','now') AS INTEGER) * 1000);" \
        >/dev/null 2>&1; then
        echo "FAIL: bug-39: failed to seed summary for session A" >&2
        fail_labels+=("bug-39")
      else
        # Capture B's stdout. session-start writes telemetry to
        # stderr (ignored) and the additionalContext JSON to stdout
        # iff there are hints. For the patched handler with cwd-b
        # input and only a cwd-a session present, stdout is empty.
        bug39_b_stdout=$(printf '%s' "$bug39_b_payload" \
          | cavemem hook run session-start --ide opencode 2>/dev/null || true)
        if printf '%s' "$bug39_b_stdout" | grep -qF "$bug39_marker"; then
          echo "FAIL: bug-39: session B stdout leaks session A marker (cross-project leak)" >&2
          fail_labels+=("bug-39")
        else
          echo "OK: bug-39"
        fi
      fi
    fi

    # ----------------------------------------------------------------
    # bug-25: search.alpha description matches the patched wording
    # ----------------------------------------------------------------
    # The patched Zod schema (overlays/cavemem-25-search-alpha-doc.
    # patch) corrects the .describe() string so it accurately
    # reflects the ranker formula `alpha * bm25 + (1 - alpha) *
    # cosine`. The literal text below is rendered verbatim by
    # `cavemem config show` (kleur is suppressed via NO_COLOR=1
    # exported above). The unpatched wording inverted the BM25 /
    # cosine descriptions and would not match this exact substring.
    bug25_expected="Hybrid rank weight: 1 = pure BM25, 0 = pure cosine, 0.5 = balanced."
    bug25_show=$(cavemem config show 2>/dev/null || true)
    if [ -z "$bug25_show" ]; then
      echo "FAIL: bug-25: cavemem config show produced no output" >&2
      fail_labels+=("bug-25")
    elif ! printf '%s' "$bug25_show" | grep -qF "$bug25_expected"; then
      echo "FAIL: bug-25: search.alpha description does not match patched wording" >&2
      fail_labels+=("bug-25")
    else
      echo "OK: bug-25"
    fi

    # ----------------------------------------------------------------
    # tool-surface: MCP server exposes the four contract tools (Req 10.6)
    # ----------------------------------------------------------------
    # Stdio probe (NOT mcphub) so the smoke test stays self-contained:
    # the rest of the test runs against an isolated CAVEMEM_DATA_DIR
    # while the operator's real mcphub-spawned cavemem talks to the
    # real ~/.cavemem; routing this check through mcphub would
    # contaminate the isolation.
    #
    # JSON-RPC dance: send `initialize` (the SDK rejects tools/list
    # before initialize completes) followed by `tools/list`. The
    # trailing `sleep 2` keeps stdin open long enough for the server
    # to flush both responses to stdout before we close the pipe;
    # `timeout 10` bounds the total wait if the server somehow
    # doesn't exit on EOF.
    #
    # Contract-locked tool names (Req 10.6 / design.md §"Service
    # Interface (cavemem MCP tools)"): list_sessions, timeline,
    # get_observations, search. A cavemem version bump that renames
    # any of these is a Revalidation Trigger; this check fails
    # immediately on the first missing name.
    expected_tools=(list_sessions timeline get_observations search)
    mcp_out_file="$tmpdir/mcp-out.txt"
    {
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cavemem-smoke","version":"0.0.0"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
      sleep 2
    } | timeout 10 cavemem mcp >"$mcp_out_file" 2>/dev/null || true

    if [ ! -s "$mcp_out_file" ]; then
      echo "FAIL: tool-surface: cavemem mcp produced no output" >&2
      fail_labels+=("tool-surface")
    else
      # The MCP server emits one JSON object per line. `jq -s` slurps
      # them into an array; we pick the response with id == 2
      # (tools/list) and extract `.result.tools[].name`. Robust to
      # extra log lines: any non-JSON line on stdout would cause jq
      # to error, which we treat as no tools and FAIL below.
      mcp_tools=$(jq -rs '
        map(select(type == "object" and .id == 2)) | .[0].result.tools[]?.name
      ' "$mcp_out_file" 2>/dev/null || true)

      missing_tool=""
      for expected in "''${expected_tools[@]}"; do
        if ! printf '%s\n' "$mcp_tools" | grep -qx "$expected"; then
          missing_tool="$expected"
          break
        fi
      done
      if [ -n "$missing_tool" ]; then
        echo "FAIL: tool-surface: missing $missing_tool" >&2
        fail_labels+=("tool-surface")
      else
        echo "OK: tool-surface"
      fi
    fi

    # ----------------------------------------------------------------
    # Aggregate exit
    # ----------------------------------------------------------------
    # Exit 0 iff every check passed. On any failure, emit a one-line
    # summary of failing labels to stderr (in addition to each
    # check's own FAIL: line) so an operator scrolling through CI
    # output sees the aggregate without scanning back through the
    # individual lines.
    if [ "''${#fail_labels[@]}" -gt 0 ]; then
      printf 'cavemem-smoke-test: FAILED checks: %s\n' "''${fail_labels[*]}" >&2
      exit 1
    fi
    exit 0
  '';
}
