{
  writeShellApplication,
  coreutils,
  jq,
  subagentContextBudget,
  smokeCatalog ? ../home-manager/common/subagent-context-budget/smoke-catalog.json,
}:
writeShellApplication {
  name = "subagent-context-budget-smoke-test";
  runtimeInputs = [
    coreutils
    jq
    subagentContextBudget
  ];
  text = ''
    DEFAULT_METADATA="''${XDG_CONFIG_HOME:-$HOME/.config}/opencode/subagent-context-budget/metadata.json"
    DEFAULT_PLUGIN_SELF_CHECK="''${XDG_STATE_HOME:-$HOME/.local/state}/opencode/subagent-context-budget/plugin-self-check.json"
    DEFAULT_SMOKE_CATALOG=${smokeCatalog}

    CLI="''${SUBAGENT_CONTEXT_BUDGET_SMOKE_CLI:-subagent-context-budget}"
    METADATA="''${SUBAGENT_CONTEXT_BUDGET_SMOKE_METADATA:-$DEFAULT_METADATA}"
    PLUGIN_SELF_CHECK="''${SUBAGENT_CONTEXT_BUDGET_SMOKE_PLUGIN_SELF_CHECK:-$DEFAULT_PLUGIN_SELF_CHECK}"
    CATALOG="''${SUBAGENT_CONTEXT_BUDGET_SMOKE_CATALOG:-$DEFAULT_SMOKE_CATALOG}"

    fail() {
      printf '[smoke-test-failure: %s] %s\n' "$1" "$2" >&2
      exit 1
    }

    one_line() {
      tr '\n' ' '
    }

    if ! CLI_PATH="$(command -v "$CLI" 2>/dev/null)"; then
      fail "cli_missing" "subagent-context-budget CLI not found: $CLI"
    fi

    if [[ ! -f "$METADATA" ]]; then
      fail "metadata_missing" "metadata JSON not found at $METADATA"
    fi
    if [[ ! -r "$METADATA" ]]; then
      fail "metadata_missing" "metadata JSON not readable at $METADATA"
    fi
    if ! metadata_parse_error="$(jq -e . "$METADATA" 2>&1 >/dev/null)"; then
      fail "metadata_invalid" "metadata JSON did not parse: $(printf '%s' "$metadata_parse_error" | one_line)"
    fi

    plugin_status=""
    if [[ -f "$PLUGIN_SELF_CHECK" ]]; then
      if [[ ! -r "$PLUGIN_SELF_CHECK" ]]; then
        fail "plugin_self_check_failed" "plugin self-check JSON not readable at $PLUGIN_SELF_CHECK"
      fi
      if ! plugin_status="$(jq -r '.status // .expected.status // empty' "$PLUGIN_SELF_CHECK" 2>/dev/null)"; then
        fail "plugin_self_check_failed" "plugin self-check JSON did not parse at $PLUGIN_SELF_CHECK"
      fi
      case "$plugin_status" in
        ready|disabled)
          ;;
        failed)
          detail="$(jq -r '.detail // .message // .expected.reason // "plugin self-check status is failed"' "$PLUGIN_SELF_CHECK" 2>/dev/null || true)"
          fail "plugin_self_check_failed" "$detail"
          ;;
        *)
          fail "plugin_self_check_failed" "plugin self-check status must be ready, disabled, or failed; got '$plugin_status'"
          ;;
      esac
    else
      enforcement_enabled="$(jq -r 'if .enforcementEnabled == true then "true" else "false" end' "$METADATA")"
      if [[ "$enforcement_enabled" == "true" ]]; then
        fail "plugin_self_check_failed" "plugin self-check JSON not found at $PLUGIN_SELF_CHECK"
      fi
      plugin_status="disabled"
    fi

    if ! smoke_output="$($CLI_PATH smoke-plan --metadata "$METADATA" --smoke-catalog "$CATALOG" 2>&1 >/dev/null)"; then
      smoke_detail="$(printf '%s' "$smoke_output" | one_line)"
      if [[ "$smoke_output" == *"smoke-plan: invalid-metadata"* ]]; then
        fail "metadata_invalid" "$smoke_detail"
      fi
      fail "smoke_plan_failed" "$smoke_detail"
    fi

    printf '[smoke-test-ok] cli=%s metadata=%s pluginSelfCheck=%s smokePlan=available\n' \
      "$CLI_PATH" "$METADATA" "$plugin_status" >&2
  '';
}
