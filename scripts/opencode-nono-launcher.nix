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
    # Before the audit/enforced exec, task 4.2 will resolve
    #   nono profile show "$opencode_nono_profile_effective" --json --silent
    # and assert the resolved grants admit the required access (loopback
    # `open_port 8080` for mcpproxy and provider network access). A missing
    # required grant must exit 1 naming the grant (R4.4) rather than launch a
    # broken opencode. Do NOT implement here.
    # ---------------------------------------------------------------------

    # --- SEAM: task 4.3 (enforced freshness-marker check) ----------------
    # When "$opencode_nono_effective" = "enforced", task 4.3 will read the
    # audit freshness marker
    #   ''${XDG_STATE_HOME}/opencode-nono/last-report.json
    # and, if it is absent / unreadable / has an unknown markerSchemaVersion /
    # has a profileVersion differing from the active managed profile's
    # profileVersion in metadata.json, WARN (not block) before enforcement
    # proceeds (R3.5). Do NOT implement here.
    # ---------------------------------------------------------------------

    # `--allow-cwd` is MANDATORY: non-interactive `nono run` refuses CWD access
    # without it even when the profile grants workdir access (Phase 0 finding).
    exec "$opencode_nono_bin" run --profile "$opencode_nono_profile_effective" --allow-cwd -- "${basePackage}/bin/opencode" "$@"
  '';
}
