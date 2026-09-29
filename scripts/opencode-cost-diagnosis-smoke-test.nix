/*
  scripts/opencode-cost-diagnosis-smoke-test.nix — post-`nix flake
  update` verifier for the opencode-cost-diagnosis spec (Task 6.3;
  Requirements 5.1, 5.2). Extended by v2-diagnosis Task 1.4
  (Requirements 3.1, 3.5) to validate the bundled pricing JSON and
  confirm the live-history models stay covered.

  Why a `writeShellApplication` rather than inlining the checks into
  the HM module or shipping a Node-based test:

  - The contract this script enforces is "after a darwin-rebuild
    switch, the diagnostic is wired up correctly AND the local
    opencode DB matches the schema the diagnostic was pinned against".
    That is an operator-runnable smoke gate, not a build-time
    assertion: it depends on the live opencode DB (XDG_DATA_HOME) and
    must be re-runnable any time the operator wants to revalidate.
    Shipping it as a real script under `scripts/` keeps it diffable
    and on PATH alongside the production CLI.
  - `writeShellApplication` gives `set -euo pipefail`, shellcheck on
    the body, and a locked-down closure (sqlite3 + coreutils) so the
    test behaves identically regardless of the operator's PATH.
  - Using `sqlite3` (not Node) keeps the check independent from the
    production CLI's own module surface. If `require('better-sqlite3')`
    breaks for any reason, the smoke test can still report that fact
    via the schema_drift / cli_missing labels rather than itself
    crashing on import.

   Why the checks fail fast:

  - Task 6.3 specifies fail-fast on each check with a labeled exit
    message (`[smoke-test-failure: <label>] <detail>`). The four
    checks are ordered by dependency: a DB missing in (a) makes (b)
    meaningless; a CLI missing in (c) makes (d) impossible. Reporting
    a downstream "version_mismatch" when the actual root cause is
     "db_missing" would be misleading.

  Why an OPENCODE_COST_SMOKE_TEST_DB override:

  - Task 6.3's Observable demands a verification path that proves the
    schema_drift label fires when the migration set is mutated. Doing
    that against the live opencode DB would require renaming a row in
    a 415 MB DB the operator is actively writing to. The env-var
    override lets the operator point the smoke test at a scratch
    SQLite fixture (cp + sqlite3 UPDATE) and exercise the failure path
    without touching the live DB. Production runs ignore the override
    because operators don't set it.

  Pinned constants below MUST stay consistent with their counterparts
  in `scripts/opencode-cost-report.js` — see the cross-reference
  comments inline. The whole point of the smoke test is to fail loudly
  when those constants drift apart, so the duplication is intentional.
*/
{
  writeShellApplication,
  coreutils,
  jq,
  sqlite,
}:
writeShellApplication {
  name = "opencode-cost-diagnosis-smoke-test";
  runtimeInputs = [
    coreutils
    jq
    sqlite
  ];
  text = ''
    # Pinned baseline migration set. MUST stay in sync with
    # SUPPORTED_MIGRATION_SET in scripts/opencode-cost-report.js
    # (search for that identifier near the top of that file). When
    # opencode lands a new migration, update BOTH the JS constant and
    # this bash array together; a drift between the two would let the
    # production CLI silently accept a schema the smoke test still
    # treats as drift, or vice versa.
    SUPPORTED_MIGRATIONS=(
      "session_usage_from_messages"
    )

    # Expected substring of `opencode-cost-report
    # --supported-opencode-version` output. MUST match
    # SUPPORTED_VERSION_RANGE in scripts/opencode-cost-report.js
    # (search for that identifier). The CLI prints
    #   `Supported opencode version range: <range>`
    # so a substring match on the range itself is sufficient to
    # confirm the CLI on PATH is the one this smoke test was built
    # against.
    EXPECTED_VERSION_RANGE=">=0.18.0 <0.30.0"

    # Path to the bundled pricing JSON, baked at smoke-test build time
    # via Nix source interpolation. Same pattern the production CLI
    # wrapper uses to wire OPENCODE_COST_PRICING_PATH in v2-diagnosis
    # Task 1.3: the store path captured here resolves to the exact
    # file shipped with this revision of the smoke test, so a flake
    # update that rebuilds the smoke test also re-pins the pricing
    # JSON it validates.
    PRICING_JSON=${./opencode-cost-report-pricing.json}

    # Models observed in the operator's live history that MUST stay
    # covered by the bundled pricing JSON. MUST stay in sync with the
    # JS CLI's PricingTable and the bundled JSON's coverage: if the
    # live history grows a new modelID, add it here AND ensure
    # `scripts/opencode-cost-report-pricing.json` has an entry for it.
    # Form: "<providerID> <modelID>" per element so the loop in check
    # (e) can `read` them into two variables without tracking separate
    # arrays.
    EXPECTED_MODELS=(
      "anthropic claude-opus-4-7"
      "anthropic claude-sonnet-4-5"
      "openai gpt-5.5-pro"
    )

    # DB path resolution. The override hook
    # (OPENCODE_COST_SMOKE_TEST_DB) is the verification handle from
    # task 6.3's Observable: it lets the operator run the smoke test
    # against a scratch SQLite fixture with a mutated data_migration
    # row to confirm the schema_drift label fires, without touching
    # the live opencode DB. When unset, the smoke test reads the same
    # XDG path the production CLI uses.
    DB="''${OPENCODE_COST_SMOKE_TEST_DB:-''${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode-stable.db}"

    # Fail mode contract from task 6.3: one-line
    # `[smoke-test-failure: <label>] <detail>` to stderr, then exit
    # non-zero. Success path exits 0 with a single "OK" line on stderr
    # so an operator running it interactively gets confirmation
    # without polluting any stdout pipeline.
    fail() {
      printf '[smoke-test-failure: %s] %s\n' "$1" "$2" >&2
      exit 1
    }

    # ---------------------------------------------------------------
    # (a) DB file exists and is readable
    # ---------------------------------------------------------------
    # `-f` rules out directories and non-regular files; `-r` catches
    # the chmod-unreadable case. Together they cover both
    # `programs.opencode.enable = false` (no DB ever created) and the
    # rarer "DB exists but permissions got mangled" case.
    if [[ ! -f "$DB" ]]; then
      fail "db_missing" "opencode DB not found at $DB"
    fi
    if [[ ! -r "$DB" ]]; then
      fail "db_missing" "opencode DB not readable at $DB"
    fi

    # ---------------------------------------------------------------
    # (b) data_migration set matches the pinned baseline
    # ---------------------------------------------------------------
    # We open the DB explicitly read-only (`-readonly`) so the smoke
    # test inherits the same safety property the production CLI gets
    # from better-sqlite3's `{ readonly: true }` open mode (R6.AC1).
    # If sqlite3 itself errors (corrupt DB, missing table, etc.) the
    # `||` branch routes the error text into the schema_drift label —
    # those failures are functionally indistinguishable from "schema
    # we don't understand" from the operator's perspective.
    if ! detected_str=$(sqlite3 -readonly "$DB" \
      "SELECT name FROM data_migration ORDER BY name" 2>&1); then
      fail "schema_drift" \
        "sqlite3 failed to read data_migration: $detected_str"
    fi

    # Parse the newline-delimited sqlite3 output into a bash array.
    # `mapfile -t` strips the terminating newline from each element.
    # An empty result set produces a one-element array containing the
    # empty string; collapse that to a zero-element array so the
    # comparison below treats "no migrations" as distinct from "one
    # migration named '''" rather than spuriously matching either.
    mapfile -t detected < <(printf '%s\n' "$detected_str")
    if [[ "''${#detected[@]}" -eq 1 && -z "''${detected[0]}" ]]; then
      detected=()
    fi

    # Compare by joining both arrays with the same separator. Avoids
    # the bash-version-specific gotchas of `[[ "''${a[@]}" == "''${b[@]}" ]]`
    # (which only compares first elements) and the per-element loop
    # alternative (which obscures the failure message).
    expected_joined=$(IFS=$'\n'; printf '%s' "''${SUPPORTED_MIGRATIONS[*]}")
    detected_joined=$(IFS=$'\n'; printf '%s' "''${detected[*]}")
    if [[ "$expected_joined" != "$detected_joined" ]]; then
      fail "schema_drift" \
        "data_migration set mismatch. expected: [''${SUPPORTED_MIGRATIONS[*]}] detected: [''${detected[*]}]"
    fi

    # ---------------------------------------------------------------
    # (c) opencode-cost-report on PATH
    # ---------------------------------------------------------------
    # The HM module from task 1.5 / 6.3 puts the production CLI on
    # PATH via home.packages. If `command -v` can't find it, either
    # the HM activation didn't run, the operator's shell hasn't
    # re-sourced PATH yet, or the module's home.packages list got
    # accidentally trimmed. The label points to the install pipeline,
    # not the DB.
    if ! command -v opencode-cost-report >/dev/null 2>&1; then
      fail "cli_missing" "opencode-cost-report not found on PATH"
    fi

    # ---------------------------------------------------------------
    # (d) --supported-opencode-version output matches pinned range
    # ---------------------------------------------------------------
    # This is the cross-binding check: a drift between the smoke
    # test's EXPECTED_VERSION_RANGE and the CLI's SUPPORTED_VERSION_RANGE
    # (e.g. someone updated one but not the other) surfaces as
    # version_mismatch here. The flag short-circuits before any DB
    # work happens inside the CLI, so this stays fast even if the
    # opencode DB is very large.
    if ! version_out=$(opencode-cost-report --supported-opencode-version 2>&1); then
      fail "version_mismatch" \
        "opencode-cost-report --supported-opencode-version exited non-zero: $version_out"
    fi
    if ! printf '%s' "$version_out" | grep -qF "$EXPECTED_VERSION_RANGE"; then
      fail "version_mismatch" \
        "opencode-cost-report --supported-opencode-version output missing expected range '$EXPECTED_VERSION_RANGE'. Got: $version_out"
    fi

    # ---------------------------------------------------------------
    # (e) Bundled pricing JSON parses and covers expected models
    # ---------------------------------------------------------------
    # This is the v2-diagnosis Task 1.4 cross-binding: a drift between
    # the bundled `scripts/opencode-cost-report-pricing.json` and the
    # live-history modelIDs the CLI must price surfaces as
    # `pricing_drift` here (label parallels the JS CLI's
    # `pricing_table_drift` finding code). The check is ordered last
    # because it's the data the CLI consumes — checks (a)-(d) prove
    # the CLI itself is wired up; (e) proves the data it depends on
    # is intact.
    if [[ ! -r "$PRICING_JSON" ]]; then
      fail "pricing_drift" \
        "pricing JSON missing or unreadable at $PRICING_JSON"
    fi

    # Capture jq's parse error on stderr+stdout so the failure message
    # carries the actual jq diagnostic (line/column of the malformed
    # token) rather than a generic "did not parse" string.
    if ! jq_parse_out=$(jq -e . "$PRICING_JSON" 2>&1 >/dev/null); then
      fail "pricing_drift" \
        "pricing JSON does not parse as valid JSON at $PRICING_JSON: $jq_parse_out"
    fi

    # Top-level shape contract: `pinDate`, `pinSource`, `models` are
    # the three keys the JS CLI's loader treats as required. Catching
    # a missing top-level key here keeps the failure label specific
    # ("the JSON is structurally wrong") rather than letting the
    # per-model loop below report a misleading "missing model" for
    # what is really a missing `models` root.
    if ! jq -e 'has("pinDate") and has("pinSource") and has("models")' \
      "$PRICING_JSON" >/dev/null 2>&1; then
      fail "pricing_drift" \
        "pricing JSON missing one of required top-level keys (pinDate, pinSource, models) at $PRICING_JSON"
    fi

    # Per-model coverage: each (providerID, modelID) in EXPECTED_MODELS
    # must resolve to a non-null entry under `.models[provider][model]`.
    # `// empty` collapses both a literal `null` and a missing key to
    # an empty jq output, which `-e` then treats as failure (exit 1).
    for entry in "''${EXPECTED_MODELS[@]}"; do
      read -r provider model <<<"$entry"
      if ! jq -e --arg p "$provider" --arg m "$model" \
        '.models[$p][$m] // empty' "$PRICING_JSON" >/dev/null 2>&1; then
        fail "pricing_drift" \
          "pricing JSON missing required model: $provider/$model at $PRICING_JSON"
      fi
    done

    printf 'opencode-cost-diagnosis-smoke-test: OK\n' >&2
    exit 0
  '';
}
