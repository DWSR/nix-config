/*
  scripts/opencode-nono-launcher.nix — the outer OpenCode launcher for the
  opencode-nono-sandbox spec (Task 4.1; Requirements 1.2, 1.4, 1.5, 3.2,
  3.3, 3.4, 5.4).

  This `writeShellApplication` named `opencode` replaces the historical
  preflight-INSIDE wrapper (`home.opencode.finalPackage` default) when the
  opencode-nono module is enabled. It runs the existing preflight host-side
  (outside any sandbox), suffixes the LSP PATH fragment (parity with today's
  wrapProgram `--suffix PATH`), resolves the effective sandbox state from the
  baked host default plus the `OPENCODE_NONO` / `OPENCODE_NONO_PROFILE`
  per-launch overrides, exports the env contract, and finally either execs
  bare opencode (disabled) or execs `nono run` (audit / enforced, fail-closed
  if the pinned nono binary is missing).

  Parameters (task 4.4 wires the real seam values):
    basePackage     unwrapped opencode (home.opencode.basePackage)
    preflightScript joined wrapperCommands (home.opencode.preflightScript)
    lspPath         makeBinPath lspPackages (home.opencode.lspPath)
    nono            pinned nono package; referenced by store path so the
                    exec'd binary version is guaranteed
    defaultState    baked host default sandbox state (disabled by default)
    managedProfile  enforced default profile name
    auditProfile    audit default profile name

  The read-only review profile is reachable only via an explicit
  OPENCODE_NONO_PROFILE override at launch, so the launcher needs no
  separate review-profile parameter.
*/
{
  writeShellApplication,
  jq,
  basePackage,
  preflightScript,
  lspPath,
  nono,
  defaultState ? "disabled",
  managedProfile ? "opencode-managed",
  auditProfile ? "opencode-audit",
}:

writeShellApplication {
  name = "opencode";
  runtimeInputs = [ jq ];
  # The embedded host `preflightScript` is the relocated-not-rewritten
  # `home.opencode.wrapperCommands` block (design Out of Boundary: existing
  # preflight snippets run outside nono, NOT rewritten). The Shopify host's
  # devx snippet uses `export OPENCODE_SESSION_ID="$(uuidgen)"`, which trips
  # shellcheck's SC2155 (declare-and-assign masks the return value). Excluding
  # SC2155 admits that trusted host-authored preflight verbatim; the launcher's
  # OWN logic uses plain `x="$(cmd)"` assignments (never `export`-with-
  # substitution), so this exclusion does not weaken the launcher's own checks.
  # `excludeShellChecks` is supported by nixpkgs 25.11's writeShellApplication.
  excludeShellChecks = [ "SC2155" ];
  text = ''
    # ----------------------------------------------------------------------
    # 1. Preflight, host-side (outside any sandbox).
    #
    # The preflight snippet is the joined `home.opencode.wrapperCommands`
    # (mcpproxy/obsidian/cavemem probes, devx token mint, LSP env, the RTK
    # resolver). It keeps its own fail-fast `exit` behavior (R5.1, R5.2),
    # and the RTK resolver's `OPENCODE_RTK_*` exports happen here so the RTK
    # and nono states are both observable on the same launch (R5.4).
    # ----------------------------------------------------------------------
    ${preflightScript}

    # ----------------------------------------------------------------------
    # 2. Suffix the LSP bin PATH (parity with today's wrapProgram
    #    `--suffix PATH`): project-local / user-provided binaries still win
    #    because the fragment is appended, not prepended. Spawned LSP servers
    #    then resolve via inherited PATH inside the sandbox.
    # ----------------------------------------------------------------------
    export PATH="$PATH:${lspPath}"

    # ----------------------------------------------------------------------
    # 3. Resolve the effective sandbox state.
    #
    #    Inputs:
    #      - baked host default (defaultState)
    #      - OPENCODE_NONO        (runtime state override: disabled|audit|enforced)
    #      - OPENCODE_NONO_PROFILE (runtime explicit profile name override)
    #
    #    An explicit OPENCODE_NONO override wins over the baked default.
    # ----------------------------------------------------------------------
    opencode_nono_default="${defaultState}"
    opencode_nono_override="''${OPENCODE_NONO:-}"
    opencode_nono_profile_override="''${OPENCODE_NONO_PROFILE:-}"
    opencode_nono_disable_reason=""

    case "$opencode_nono_override" in
      "")
        # No runtime override: fall back to the baked host default.
        opencode_nono_effective="$opencode_nono_default"
        if [ "$opencode_nono_effective" = "disabled" ]; then
          opencode_nono_disable_reason="host-default"
        fi
        ;;
      "disabled")
        opencode_nono_effective="disabled"
        opencode_nono_disable_reason="override"
        ;;
      "audit"|"enforced")
        opencode_nono_effective="$opencode_nono_override"
        ;;
      *)
        # Invalid override: fail closed before launching (R3.3, R1.5). Export
        # the env contract (matching RTK's invalid-override path) before the
        # nonzero exit so any wrapper/observer sees the disabled posture and
        # the invalid-override reason.
        export OPENCODE_NONO_EFFECTIVE="disabled"
        export OPENCODE_NONO_PROFILE_EFFECTIVE=""
        export OPENCODE_NONO_DISABLE_REASON="invalid-override"
        export OPENCODE_NONO_USAGE_TAG="nono:disabled"
        echo "ERROR: invalid OPENCODE_NONO value: $opencode_nono_override. Use disabled, audit, or enforced." >&2
        exit 1
        ;;
    esac

    # Resolve the effective profile name from the effective state plus the
    # explicit OPENCODE_NONO_PROFILE override:
    #   - disabled : empty (no profile)
    #   - audit    : OPENCODE_NONO_PROFILE if set, else the audit default
    #   - enforced : OPENCODE_NONO_PROFILE if set, else the managed default
    # The review profile is reachable only via an explicit OPENCODE_NONO_PROFILE.
    opencode_nono_profile_effective=""
    case "$opencode_nono_effective" in
      disabled)
        opencode_nono_profile_effective=""
        ;;
      audit)
        if [ -n "$opencode_nono_profile_override" ]; then
          opencode_nono_profile_effective="$opencode_nono_profile_override"
        else
          opencode_nono_profile_effective="${auditProfile}"
        fi
        ;;
      enforced)
        if [ -n "$opencode_nono_profile_override" ]; then
          opencode_nono_profile_effective="$opencode_nono_profile_override"
        else
          opencode_nono_profile_effective="${managedProfile}"
        fi
        ;;
    esac

    # ----------------------------------------------------------------------
    # 4. Export the env contract BEFORE exec (design Env Contract table; R5.4).
    # ----------------------------------------------------------------------
    export OPENCODE_NONO_EFFECTIVE="$opencode_nono_effective"
    export OPENCODE_NONO_PROFILE_EFFECTIVE="$opencode_nono_profile_effective"
    export OPENCODE_NONO_DISABLE_REASON="$opencode_nono_disable_reason"
    export OPENCODE_NONO_USAGE_TAG="nono:$opencode_nono_effective"

    # ----------------------------------------------------------------------
    # 5. Exec.
    # ----------------------------------------------------------------------
    if [ "$opencode_nono_effective" = "disabled" ]; then
      # Disabled: launch bare opencode, no nono (R1.3 equivalence path).
      exec "${basePackage}/bin/opencode" "$@"
    fi

    # audit / enforced: fail closed if the pinned nono binary is unavailable
    # (R1.4). Reference nono by store path so the exec'd version is guaranteed.
    opencode_nono_bin="${nono}/bin/nono"
    if [ ! -x "$opencode_nono_bin" ]; then
      export OPENCODE_NONO_DISABLE_REASON="missing-binary"
      echo "ERROR: OpenCode sandbox state '$opencode_nono_effective' requires the nono binary, but it is not executable at $opencode_nono_bin." >&2
      echo "Refusing to launch OpenCode unsandboxed. Provision nono (programs.opencode-nono.package) and rebuild the host." >&2
      exit 1
    fi

    # --- SEAM: task 4.2 (pre-launch grant check) -------------------------
    # Resolve the selected profile (audit/enforced only) and assert the grants
    # admit the required access before exec (R4.4). `nono profile show` resolves
    # an EXISTING rendered profile by name and emits clean JSON on stdout
    # (--silent keeps the banner on stderr). A grant check that cannot read the
    # profile fails closed rather than launching a broken opencode.
    opencode_nono_profile_json="$("$opencode_nono_bin" profile show "$opencode_nono_profile_effective" --json --silent)" || {
      echo "ERROR: failed to resolve nono profile '$opencode_nono_profile_effective' for the pre-launch grant check." >&2
      echo "Refusing to launch OpenCode: cannot verify the selected profile grants required access (R4.4)." >&2
      exit 1
    }
    if [ -z "$opencode_nono_profile_json" ] || ! printf '%s' "$opencode_nono_profile_json" | jq -e . >/dev/null 2>&1; then
      echo "ERROR: nono profile '$opencode_nono_profile_effective' produced empty or unparseable JSON for the pre-launch grant check." >&2
      echo "Refusing to launch OpenCode: cannot verify the selected profile grants required access (R4.4)." >&2
      exit 1
    fi

    # mcpproxy loopback: network.open_port must include 8080.
    if ! printf '%s' "$opencode_nono_profile_json" | jq -e '(.network.open_port // []) | index(8080) != null' >/dev/null; then
      echo "ERROR: profile '$opencode_nono_profile_effective' is missing a required grant: network.open_port must include 8080 (mcpproxy loopback)." >&2
      echo "Refusing to launch OpenCode in a broken state (R4.4)." >&2
      exit 1
    fi

    # provider network: network.block=false OR a non-empty network.allow_domain.
    if ! printf '%s' "$opencode_nono_profile_json" | jq -e '(.network.block == false) or (((.network.allow_domain // []) | length) > 0)' >/dev/null; then
      echo "ERROR: profile '$opencode_nono_profile_effective' is missing a required grant: provider network is blocked — set network.block=false or add a network.allow_domain entry." >&2
      echo "Refusing to launch OpenCode in a broken state (R4.4)." >&2
      exit 1
    fi
    # ---------------------------------------------------------------------

    # --- SEAM: task 4.3 (enforced freshness-marker check) ----------------
    # Best-effort strict-enforcement freshness check (R3.5). Runs ONLY when
    # the effective state is `enforced`. It reads the audit freshness marker
    #   ''${XDG_STATE_HOME:-$HOME/.local/state}/opencode-nono/last-report.json
    # (cross-spec shape `{ markerSchemaVersion: 1, profileVersion, … }` written
    # by opencode-nono-audit) and WARNS to stderr — never blocks — when the
    # marker is absent/unreadable, has an unknown markerSchemaVersion (≠ 1), or
    # its profileVersion is empty or does not match the live metadata
    # profileVersion. A current marker is silent. Every jq read is guarded so a
    # parse failure degrades to a warn and NEVER aborts the launch under
    # `set -euo pipefail`.
    if [ "$opencode_nono_effective" = "enforced" ]; then
      opencode_nono_marker_path="''${XDG_STATE_HOME:-$HOME/.local/state}/opencode-nono/last-report.json"
      opencode_nono_metadata_path="''${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode-nono/metadata.json"

      # Live profile version from metadata.json (best-effort; absent/unreadable
      # /malformed → empty, which still only warns, never blocks).
      opencode_nono_live_version=""
      if [ -r "$opencode_nono_metadata_path" ]; then
        opencode_nono_live_version="$(jq -r '.profileVersion // empty' "$opencode_nono_metadata_path" 2>/dev/null || true)"
      fi

      opencode_nono_fresh_warn=""
      if [ ! -r "$opencode_nono_marker_path" ]; then
        opencode_nono_fresh_warn="no compatibility report found at $opencode_nono_marker_path"
      else
        # markerSchemaVersion must parse and equal the known schema constant (1).
        opencode_nono_marker_schema="$(jq -r '.markerSchemaVersion // empty' "$opencode_nono_marker_path" 2>/dev/null || true)"
        opencode_nono_marker_version="$(jq -r '.profileVersion // empty' "$opencode_nono_marker_path" 2>/dev/null || true)"
        if [ "$opencode_nono_marker_schema" != "1" ]; then
          opencode_nono_fresh_warn="unreadable or unknown compatibility report schema at $opencode_nono_marker_path (expected markerSchemaVersion 1)"
        elif [ -z "$opencode_nono_marker_version" ] || [ "$opencode_nono_marker_version" != "$opencode_nono_live_version" ]; then
          opencode_nono_fresh_warn="stale compatibility report at $opencode_nono_marker_path (report profileVersion '$opencode_nono_marker_version' != active '$opencode_nono_live_version')"
        fi
      fi

      if [ -n "$opencode_nono_fresh_warn" ]; then
        echo "WARNING: opencode-nono strict enforcement: $opencode_nono_fresh_warn." >&2
        echo "WARNING: opencode-nono strict enforcement: re-run the opencode-nono-audit compatibility report for the active profile version, then relaunch. Continuing." >&2
      fi
    fi
    # ---------------------------------------------------------------------

    # `--allow-cwd` is MANDATORY: non-interactive `nono run` refuses CWD access
    # without it even when the profile grants workdir access (Phase 0 finding).
    exec "$opencode_nono_bin" run --profile "$opencode_nono_profile_effective" --allow-cwd -- "${basePackage}/bin/opencode" "$@"
  '';
}
