/*
  scripts/opencode-nono-smoke-test.nix — host-run end-to-end smoke test for
  the opencode-nono-sandbox spec (Task 5.2; Requirement 6.4).

  A `writeShellApplication` named `opencode-nono-smoke-test`. It launches the
  bare OpenCode binary INSIDE the nono sandbox under the default managed
  profile:

      nono run --profile opencode-managed --allow-cwd -- opencode --version

  and reports success. A clean `--version` from opencode under the managed
  profile proves the profile's `extends ["default"]` + groups reconstruction
  (Tasks 2.1/2.2) actually lets opencode start under Seatbelt (R6.4). This is
  the authoritative startup check that the grant reconstruction works.

  Structural template: scripts/rtk-opencode-smoke-test.nix (the `fail()`
  idiom, `--help`/`--version` short-circuit, `one_line`, env-var inputs).

  The bare opencode binary — NOT the outer launcher — runs inside nono: nono
  wraps the bare binary, the launcher is the outer layer. Task 5.3 / the
  module wire this script with `opencode = config.home.opencode.basePackage`
  (the bare base package) and `nono = cfg.package` (the pinned nono).

  Inputs (env, with defaults):
    OPENCODE_NONO_SMOKE_PROFILE
        Profile name to launch under. Defaults to `opencode-managed`. The
        profile is resolved by name from
        ${XDG_CONFIG_HOME:-$HOME/.config}/nono/profiles/<name>.json (rendered
        by programs.opencode-nono on a switched host).
    OPENCODE_NONO_SMOKE_NONO
        nono binary to invoke. Defaults to the pinned `nono` on runtimeInputs.
    OPENCODE_NONO_SMOKE_OPENCODE
        Bare opencode binary launched inside nono. Defaults to the bare base
        package's `${opencode}/bin/opencode`.

  Failure contract:
    [smoke-test-failure: <label>] <detail>
*/
{
  writeShellApplication,
  coreutils,
  nono,
  opencode,
}:

writeShellApplication {
  name = "opencode-nono-smoke-test";
  runtimeInputs = [
    coreutils
    nono
  ];
  text = ''
        usage() {
          cat >&2 <<'USAGE'
    opencode-nono-smoke-test — start opencode under the managed nono profile

    Optional input (env):
      OPENCODE_NONO_SMOKE_PROFILE
                                   Profile name to launch under. Defaults to
                                   opencode-managed.
      OPENCODE_NONO_SMOKE_NONO     nono binary to invoke. Defaults to the
                                   pinned nono on PATH.
      OPENCODE_NONO_SMOKE_OPENCODE Bare opencode binary launched inside nono.
                                   Defaults to the pinned base opencode.

    Behavior:
      Runs `nono run --profile <profile> --allow-cwd -- opencode --version`
      and reports success — proving the managed profile's extends-default
      grant reconstruction lets opencode start under the sandbox (R6.4).

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
            printf 'opencode-nono-smoke-test 0.1.0\n' >&2
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
        profile="''${OPENCODE_NONO_SMOKE_PROFILE:-opencode-managed}"
        nono_bin="''${OPENCODE_NONO_SMOKE_NONO:-${nono}/bin/nono}"
        opencode_bin="''${OPENCODE_NONO_SMOKE_OPENCODE:-${opencode}/bin/opencode}"

        # ------------------------------------------------------------------
        # The nono binary must be present (an override may point elsewhere).
        # ------------------------------------------------------------------
        if [[ "$nono_bin" == /* ]]; then
          if [[ ! -x "$nono_bin" ]]; then
            fail "nono_missing" "nono binary not found or not executable at $nono_bin; set OPENCODE_NONO_SMOKE_NONO or provision a nono (programs.opencode-nono.package)"
          fi
        else
          if ! nono_bin="$(command -v "$nono_bin" 2>/dev/null)"; then
            fail "nono_missing" "nono binary not found on PATH; set OPENCODE_NONO_SMOKE_NONO or provision a nono (programs.opencode-nono.package)"
          fi
        fi

        # ------------------------------------------------------------------
        # The named profile must be rendered and readable. nono resolves the
        # profile by name from $XDG_CONFIG_HOME/nono/profiles/<name>.json.
        # ------------------------------------------------------------------
        profiles_dir="''${XDG_CONFIG_HOME:-''${HOME:-}/.config}/nono/profiles"
        profile_file="$profiles_dir/$profile.json"
        if [[ ! -r "$profile_file" ]]; then
          fail "profile_missing" "nono profile '$profile' not found at $profile_file; render the profile (programs.opencode-nono enabled) and rebuild the host"
        fi

        # ------------------------------------------------------------------
        # Real end-to-end smoke: start opencode under the managed profile.
        # `|| run_rc=$?` captures the nono run exit code without tripping
        # `set -euo pipefail`.
        # ------------------------------------------------------------------
        run_rc=0
        run_out="$("$nono_bin" run --profile "$profile" --allow-cwd -- "$opencode_bin" --version 2>&1)" || run_rc=$?

        if [[ "$run_rc" -ne 0 ]]; then
          fail "smoke-launch-failed" "nono run --profile $profile --allow-cwd -- opencode --version exited $run_rc: $(printf '%s' "$run_out" | one_line); confirm the managed profile grants let opencode start (run opencode-nono-validate; check nono's audit log)"
        fi

        opencode_version="$(printf '%s' "$run_out" | one_line)"
        if [[ -z "''${run_out//[[:space:]]/}" ]]; then
          fail "version_empty" "nono run started but opencode --version produced no output under profile $profile; the launch did not reach a working opencode"
        fi

        # ------------------------------------------------------------------
        # Success: opencode started under the sandbox (R6.4).
        # ------------------------------------------------------------------
        printf '[smoke-test-ok] profile=%s nono=%s opencode-version=%s\n' \
          "$profile" "$nono_bin" "$opencode_version" >&2
  '';
}
