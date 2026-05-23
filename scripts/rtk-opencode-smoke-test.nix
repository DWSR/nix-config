/*
  scripts/rtk-opencode-smoke-test.nix — runtime verifier for the rtk-install
  spec (Task 5.3; Requirements 1.2, 1.4, 3.1, 4.2, 4.4, 5.1, 5.2, 5.3,
  5.4, 7.1, 7.2, 7.5).
*/
{
  writeShellApplication,
  coreutils,
  jq,
  rtk,
}:

writeShellApplication {
  name = "rtk-opencode-smoke-test";
  runtimeInputs = [
    coreutils
    jq
    rtk
  ];
  text = ''
        usage() {
          cat >&2 <<'USAGE'
    rtk-opencode-smoke-test — verify RTK OpenCode runtime prerequisites

    Required input:
      OPENCODE_RTK_SMOKE_METADATA  Path to rendered RTK metadata JSON.

    Optional input:
      OPENCODE_RTK_SMOKE_RTK       RTK command to probe. Defaults to `rtk`.
      OPENCODE_RTK_SMOKE_CONFIG_HOME
                                   Config root for relative metadata pluginPath.
                                   Defaults to XDG_CONFIG_HOME or HOME/.config.
      OPENCODE_RTK_SMOKE_PLUGIN    Explicit plugin file path override.

    Failure contract:
      [smoke-test-failure: <label>] <detail>
    USAGE
        }

        fail() {
          printf '[smoke-test-failure: %s] %s\n' "$1" "$2" >&2
          exit 1
        }

        one_line() {
          tr '\n' ' '
        }

        metadata_string() {
          local field="$1"
          local expected="$2"
          local label="$3"
          local value
          if ! value="$(jq -er --arg field "$field" '.[$field] | select(type == "string")' "$METADATA" 2>/dev/null)"; then
            fail "$label" "metadata field $field must be the string '$expected'"
          fi
          if [[ "$value" != "$expected" ]]; then
            fail "$label" "metadata field $field must be '$expected'; got '$value'"
          fi
        }

        case "''${1:-}" in
          --help|-h)
            usage
            exit 0
            ;;
          --version)
            printf 'rtk-opencode-smoke-test 0.1.0\n' >&2
            exit 0
            ;;
          "")
            ;;
          *)
            fail "invalid_arguments" "unknown argument: $1"
            ;;
        esac

        RTK_CLI="''${OPENCODE_RTK_SMOKE_RTK:-rtk}"
        METADATA="''${OPENCODE_RTK_SMOKE_METADATA:-}"

        if ! RTK_PATH="$(command -v "$RTK_CLI" 2>/dev/null)"; then
          fail "rtk_missing" "RTK command not found: $RTK_CLI"
        fi

        if ! rtk_version="$($RTK_PATH --version 2>&1)"; then
          fail "rtk_version_failed" "RTK version probe failed: $(printf '%s' "$rtk_version" | one_line)"
        fi
        if [[ -z "$rtk_version" ]]; then
          fail "rtk_version_failed" "RTK version probe produced no output"
        fi
        if [[ "$rtk_version" != *"0.40.0"* ]]; then
          fail "rtk_version_mismatch" "RTK version must identify 0.40.0; got $(printf '%s' "$rtk_version" | one_line)"
        fi

        if [[ -z "$METADATA" ]]; then
          fail "metadata_input_missing" "set OPENCODE_RTK_SMOKE_METADATA to the rendered RTK metadata JSON path"
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

        metadata_string "feature" "rtk-install" "metadata_feature_invalid"
        metadata_string "packageName" "rtk" "metadata_package_invalid"
        metadata_string "packageVersion" "0.40.0" "metadata_version_invalid"
        metadata_string "sourceOwner" "rtk-ai" "metadata_source_invalid"
        metadata_string "sourceRepo" "rtk" "metadata_source_invalid"
        metadata_string "sourceRev" "v0.40.0" "metadata_source_invalid"
        metadata_string "overrideEnv" "OPENCODE_RTK" "metadata_contract_invalid"
        metadata_string "effectiveEnv" "OPENCODE_RTK_EFFECTIVE" "metadata_contract_invalid"
        metadata_string "usageTagEnv" "OPENCODE_RTK_USAGE_TAG" "metadata_contract_invalid"
        metadata_string "telemetryEnv" "RTK_TELEMETRY_DISABLED" "metadata_contract_invalid"
        metadata_string "pluginPath" "opencode/plugins/rtk.ts" "metadata_plugin_path_invalid"

        default_enabled_type="$(jq -r '.defaultEnabled | type' "$METADATA")"
        if [[ "$default_enabled_type" != "boolean" ]]; then
          fail "metadata_default_invalid" "metadata field defaultEnabled must be boolean; got $default_enabled_type"
        fi

        CONFIG_HOME="''${OPENCODE_RTK_SMOKE_CONFIG_HOME:-''${XDG_CONFIG_HOME:-''${HOME:-}/.config}}"
        metadata_plugin_path="$(jq -er '.pluginPath' "$METADATA")"
        PLUGIN="''${OPENCODE_RTK_SMOKE_PLUGIN:-}"
        if [[ -z "$PLUGIN" ]]; then
          case "$metadata_plugin_path" in
            /*)
              PLUGIN="$metadata_plugin_path"
              ;;
            *)
              PLUGIN="$CONFIG_HOME/$metadata_plugin_path"
              ;;
          esac
        fi
        if [[ ! -f "$PLUGIN" ]]; then
          fail "plugin_missing" "RTK OpenCode plugin not found at $PLUGIN"
        fi
        if [[ ! -r "$PLUGIN" ]]; then
          fail "plugin_missing" "RTK OpenCode plugin not readable at $PLUGIN"
        fi

        telemetry_env_name="$(jq -er '.telemetryEnv' "$METADATA")"
        telemetry_value="''${!telemetry_env_name:-}"
        if [[ "$telemetry_value" != "1" ]]; then
          fail "telemetry_disabled_invalid" "$telemetry_env_name must be 1 for the RTK telemetry posture; got ''${telemetry_value:-<unset>}"
        fi

        effective_env_name="$(jq -er '.effectiveEnv' "$METADATA")"
        effective_value="''${!effective_env_name:-}"
        case "$effective_value" in
          enabled|disabled)
            ;;
          *)
            fail "effective_state_invalid" "$effective_env_name must be enabled or disabled; got ''${effective_value:-<unset>}"
            ;;
        esac

        usage_tag_env_name="$(jq -er '.usageTagEnv' "$METADATA")"
        usage_tag_value="''${!usage_tag_env_name:-}"
        expected_usage_tag="rtk:$effective_value"
        if [[ "$usage_tag_value" != "$expected_usage_tag" ]]; then
          fail "usage_tag_mismatch" "$usage_tag_env_name must be $expected_usage_tag when $effective_env_name=$effective_value; got ''${usage_tag_value:-<unset>}"
        fi

        disable_reason="''${OPENCODE_RTK_DISABLE_REASON:-}"
        if [[ -n "$disable_reason" ]]; then
          case "$disable_reason" in
            host-default|override|missing-binary|telemetry-unsafe|invalid-override)
              ;;
            *)
              fail "disable_reason_invalid" "OPENCODE_RTK_DISABLE_REASON has invalid value '$disable_reason'"
              ;;
          esac
        fi

        printf '[smoke-test-ok] rtk=%s version=%s metadata=%s plugin=%s effective=%s usageTag=%s\n' \
          "$RTK_PATH" "$rtk_version" "$METADATA" "$PLUGIN" "$effective_value" "$usage_tag_value" >&2
  '';
}
