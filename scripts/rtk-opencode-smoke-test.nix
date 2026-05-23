/*
  scripts/rtk-opencode-smoke-test.nix — runtime verifier scaffold for the
  rtk-install spec (Task 1.2; Requirements 1.2, 4.4, 7.1).

  This first scaffold intentionally checks only the pre-module contracts:
  the packaged `rtk` command is available and can expose its version, and
  callers must supply the rendered metadata path explicitly. Later tasks
  add the Home Manager module, plugin, telemetry, and state-contract checks.
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

        printf '[smoke-test-ok] rtk=%s version=%s metadata=%s\n' \
          "$RTK_PATH" "$rtk_version" "$METADATA" >&2
  '';
}
