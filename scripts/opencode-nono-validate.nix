/*
  scripts/opencode-nono-validate.nix — profile-validation + launch-contract
  verifier for the opencode-nono-sandbox spec (Task 5.1; Requirements 2.4,
  6.1, 6.2, 7.5).

  A `writeShellApplication` named `opencode-nono-validate`. It validates the
  rendered nono profile catalog against the PINNED nono version's schema
  (so a nono bump that breaks the schema is caught — R7.5) and asserts the
  managed OpenCode launch contract (the resolver execs `nono run --allow-cwd`
  with the expected profile per state, the preflight precedes the nono exec,
  and the pre-launch grant check is present). Every failure emits
  `[validate-failure: <label>] <detail>` with a corrective action (R6.2).

  Structural template: scripts/rtk-opencode-smoke-test.nix (the `fail()`
  idiom, `--help`/`--version` short-circuit, env-var inputs).

  The pinned `nono` is referenced via `runtimeInputs`, so `nono profile
  validate --strict` runs against the exact provisioned version (Task 5.3
  passes `nono = cfg.package`); version-coupled validation per R7.5.

  Inputs (env, with defaults):
    OPENCODE_NONO_VALIDATE_PROFILES_DIR
        Directory of rendered profile JSON files. Defaults to
        ${XDG_CONFIG_HOME:-$HOME/.config}/nono/profiles.
    OPENCODE_NONO_VALIDATE_PROFILES
        Optional explicit space/newline list of profile files; overrides
        the directory scan.
    OPENCODE_NONO_VALIDATE_LAUNCHER
        Path to the launcher script whose launch contract is asserted.
        Defaults to `command -v opencode`.

  Failure contract:
    [validate-failure: <label>] <detail>
*/
{
  writeShellApplication,
  coreutils,
  jq,
  nono,
}:

writeShellApplication {
  name = "opencode-nono-validate";
  runtimeInputs = [
    coreutils
    jq
    nono
  ];
  text = ''
        usage() {
          cat >&2 <<'USAGE'
    opencode-nono-validate — validate rendered nono profiles + the OpenCode launch contract

    Optional input (env):
      OPENCODE_NONO_VALIDATE_PROFILES_DIR
                                   Directory of rendered profile JSON files.
                                   Defaults to XDG_CONFIG_HOME or HOME/.config
                                   plus /nono/profiles.
      OPENCODE_NONO_VALIDATE_PROFILES
                                   Explicit space/newline list of profile
                                   files; overrides the directory scan.
      OPENCODE_NONO_VALIDATE_LAUNCHER
                                   Launcher script whose launch contract is
                                   asserted. Defaults to `command -v opencode`.

    Checks:
      1. nono profile validate --strict on each rendered opencode-*.json
      2. nono profile schema is resolvable (validation is against the pinned nono)
      3. launch-contract assertion on the launcher script text

    Failure contract:
      [validate-failure: <label>] <detail>
    USAGE
        }

        fail() {
          printf '[validate-failure: %s] %s\n' "$1" "$2" >&2
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
            printf 'opencode-nono-validate 0.1.0\n' >&2
            exit 0
            ;;
          "")
            ;;
          *)
            fail "invalid_arguments" "unknown argument: $1; run with --help for usage"
            ;;
        esac

        # ------------------------------------------------------------------
        # Resolve inputs.
        # ------------------------------------------------------------------
        PROFILES_DIR="''${OPENCODE_NONO_VALIDATE_PROFILES_DIR:-''${XDG_CONFIG_HOME:-''${HOME:-}/.config}/nono/profiles}"
        EXPLICIT_PROFILES="''${OPENCODE_NONO_VALIDATE_PROFILES:-}"
        LAUNCHER="''${OPENCODE_NONO_VALIDATE_LAUNCHER:-}"

        # ------------------------------------------------------------------
        # Check 2 (run first): the pinned nono's `profile schema` must be
        # resolvable so validation is against the provisioned version (R7.5).
        # ------------------------------------------------------------------
        if ! schema_out="$(nono profile schema 2>&1)"; then
          fail "schema-unavailable" "pinned nono 'profile schema' failed: $(printf '%s' "$schema_out" | one_line); provision a nono whose profile schema is resolvable (programs.opencode-nono.package)"
        fi
        if [[ -z "$schema_out" ]]; then
          fail "schema-unavailable" "pinned nono 'profile schema' produced no output; provision a nono whose profile schema is resolvable (programs.opencode-nono.package)"
        fi

        # ------------------------------------------------------------------
        # Collect the profile files to validate.
        # ------------------------------------------------------------------
        profile_files=()
        if [[ -n "$EXPLICIT_PROFILES" ]]; then
          while IFS= read -r line; do
            [[ -n "$line" ]] && profile_files+=("$line")
          done < <(printf '%s\n' "$EXPLICIT_PROFILES" | tr ' ' '\n')
        else
          if [[ ! -d "$PROFILES_DIR" ]]; then
            fail "profiles-missing" "profiles directory not found at $PROFILES_DIR; render the catalog (programs.opencode-nono.enable) or set OPENCODE_NONO_VALIDATE_PROFILES_DIR"
          fi
          while IFS= read -r line; do
            [[ -n "$line" ]] && profile_files+=("$line")
          done < <(find "$PROFILES_DIR" -maxdepth 1 -type f -name 'opencode-*.json' | sort)
        fi

        if [[ ''${#profile_files[@]} -eq 0 ]]; then
          fail "profiles-missing" "no opencode-*.json profiles found in $PROFILES_DIR; render the catalog (programs.opencode-nono.enable) or set OPENCODE_NONO_VALIDATE_PROFILES"
        fi

        # ------------------------------------------------------------------
        # Check 1: `nono profile validate --strict` each profile (R2.4, R7.5).
        # --strict treats deprecated-schema warnings as errors, so a schema
        # drift from a nono bump is a hard failure here.
        # ------------------------------------------------------------------
        validated=0
        for profile_file in "''${profile_files[@]}"; do
          if [[ ! -f "$profile_file" ]]; then
            fail "profile-invalid" "$profile_file is not a file; the rendered catalog is incomplete — render it (programs.opencode-nono.enable) or fix OPENCODE_NONO_VALIDATE_PROFILES"
          fi
          if ! validate_out="$(nono profile validate --strict "$profile_file" 2>&1)"; then
            fail "profile-invalid" "$profile_file failed nono profile validate --strict: $(printf '%s' "$validate_out" | one_line); fix the profile schema/groups/inheritance"
          fi
          validated=$((validated + 1))
        done

        # ------------------------------------------------------------------
        # Check 3: launch-contract assertion on the launcher script text.
        # ------------------------------------------------------------------
        if [[ -z "$LAUNCHER" ]]; then
          if ! LAUNCHER="$(command -v opencode 2>/dev/null)"; then
            fail "launcher-missing" "no launcher resolved; set OPENCODE_NONO_VALIDATE_LAUNCHER to the managed opencode launcher script path"
          fi
        fi
        if [[ -z "$LAUNCHER" ]]; then
          fail "launcher-missing" "no launcher resolved; set OPENCODE_NONO_VALIDATE_LAUNCHER to the managed opencode launcher script path"
        fi
        # Resolve through PATH if a bare name was provided.
        if [[ "$LAUNCHER" != /* ]]; then
          if ! LAUNCHER="$(command -v "$LAUNCHER" 2>/dev/null)"; then
            fail "launcher-missing" "launcher '$LAUNCHER' not found on PATH; set OPENCODE_NONO_VALIDATE_LAUNCHER to the managed opencode launcher script path"
          fi
        fi
        if [[ ! -f "$LAUNCHER" ]]; then
          fail "launcher-missing" "launcher not found at $LAUNCHER; set OPENCODE_NONO_VALIDATE_LAUNCHER to the managed opencode launcher script path"
        fi
        if [[ ! -r "$LAUNCHER" ]]; then
          fail "launcher-missing" "launcher not readable at $LAUNCHER; set OPENCODE_NONO_VALIDATE_LAUNCHER to a readable launcher script path"
        fi

        launcher_text="$(cat "$LAUNCHER")"

        # 3a. `nono run` with `--allow-cwd` (the mandatory non-interactive flag).
        if ! printf '%s' "$launcher_text" | grep -q 'nono.*run'; then
          fail "launch-contract" "launcher $LAUNCHER missing 'nono run' exec; the resolver must exec nono run for audit/enforced states (R1.2)"
        fi
        if ! printf '%s' "$launcher_text" | grep -q -- '--allow-cwd'; then
          fail "launch-contract" "launcher $LAUNCHER missing 'nono run ... --allow-cwd'; --allow-cwd is mandatory for non-interactive nono run (Phase 0)"
        fi

        # 3b. per-state profile selection: the managed + audit profile names appear.
        if ! printf '%s' "$launcher_text" | grep -q 'opencode-managed'; then
          fail "launch-contract" "launcher $LAUNCHER missing the enforced profile name 'opencode-managed'; per-state profile selection is required (R3.1)"
        fi
        if ! printf '%s' "$launcher_text" | grep -q 'opencode-audit'; then
          fail "launch-contract" "launcher $LAUNCHER missing the audit profile name 'opencode-audit'; per-state profile selection is required (R3.1)"
        fi

        # 3c. preflight precedes the nono run exec: assert the grant-check
        # `profile show` and the `nono run` exec both exist, and the first
        # `nono run ... --allow-cwd` exec line is at/after the grant check
        # line (the grant check is the pre-launch step that precedes exec).
        # `|| true` guards the grep: under `set -euo pipefail` a no-match grep
        # (exit 1) in a command substitution would otherwise abort the script
        # before the fail() with the labeled diagnostic could run.
        grant_line="$( (printf '%s\n' "$launcher_text" | grep -n 'profile show' | head -n1 | cut -d: -f1) || true)"
        exec_line="$( (printf '%s\n' "$launcher_text" | grep -n 'run.*--allow-cwd' | head -n1 | cut -d: -f1) || true)"
        if [[ -z "$exec_line" ]]; then
          fail "launch-contract" "launcher $LAUNCHER has no 'nono run ... --allow-cwd' exec line; the resolver must exec nono run --allow-cwd (R1.2)"
        fi
        if [[ -z "$grant_line" ]]; then
          fail "launch-contract" "launcher $LAUNCHER has no pre-launch step ('profile show') preceding the nono run exec; the preflight grant check must precede nono (R4.4)"
        fi
        if [[ "$grant_line" -ge "$exec_line" ]]; then
          fail "launch-contract" "launcher $LAUNCHER runs the nono exec (line $exec_line) before its pre-launch grant check (line $grant_line); the preflight/grant check must precede the nono run exec (R4.4)"
        fi

        # 3d. grant check is present: `profile show` + `--json` + open_port/8080.
        if ! printf '%s' "$launcher_text" | grep -q 'profile show'; then
          fail "grant-check-missing" "launcher $LAUNCHER missing the pre-launch grant check ('nono profile show'); the launcher must verify profile grants before exec (R4.4)"
        fi
        if ! printf '%s' "$launcher_text" | grep -q -- '--json'; then
          fail "grant-check-missing" "launcher $LAUNCHER missing '--json' on the pre-launch grant check; the grant check must parse nono profile show --json (R4.4)"
        fi
        if ! printf '%s' "$launcher_text" | grep -Eq 'open_port|8080'; then
          fail "grant-check-missing" "launcher $LAUNCHER missing the mcpproxy loopback grant assertion (open_port / 8080); the grant check must verify required access before exec (R4.4)"
        fi

        # ------------------------------------------------------------------
        # All checks passed.
        # ------------------------------------------------------------------
        printf '[validate-ok] profiles=%d dir=%s launcher=%s nono-schema=resolvable\n' \
          "$validated" "''${PROFILES_DIR}" "$LAUNCHER" >&2
  '';
}
