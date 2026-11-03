# fabro-darwin-dispatch-verify: capture the live dispatch observations for the
# Darwin builder path (mac-builder-for-fabro-nix-darwin-builds, task 5.6;
# design "Testing Strategy → Integration and manual verification"; requirements
# 1.4, 1.5, 3.1, 3.2, 4.3, 4.9, 4.10, 4.11, 6.6, 8.6).
#
# Task 5.6 is the live validation stage: the builder must be joined to the
# tailnet under its own tag from the OAuth credential, the guest must have
# rendered exactly one `0600` machines line and restarted its daemon, the local
# `aarch64-linux` path must still work, and the smoke's store path must resolve
# inside a sandbox. Those observations need both hosts, so this command
# packages the runbook as one executable that prints a pass/fail line per
# observation instead of leaving the operator to reconstruct the checks from
# prose:
#
#   - `builder` (run on the Builder Host) requires the
#     `mac-builder-tailscale-auth` LaunchDaemon to be loaded and its root-only
#     OAuth credential to be present without reading its value. It then records
#     the daemon's error-log offset, logs the node out, and waits for a *new*
#     join line in that log (`joining the tailnet as <name> (tag:mac-builder)`)
#     followed by `BackendState == "Running"` with the builder tag. The log line
#     is emitted by the wrapper immediately before its credential-driven
#     `tailscale up`, so a node that happened to be Running already — or that
#     joined through some other path — does not pass. Credential values never
#     appear in the status output or the log (the wrapper logs the hostname and
#     tag only).
#   - `guest` (run on the Fabro Guest) requires the renderer unit active, the
#     machines file at mode `0600` owned by `root:root` with exactly one line,
#     that line addressing the tailnet name for `aarch64-darwin`, the daemon to
#     have entered the active state after the renderer finished, and a trivial
#     `aarch64-linux` derivation to build locally.
#   - `smoke` (run on the guest) runs `fabro-darwin-build-smoke`, takes the store
#     path it reports, confirms the path is in the guest store, then confirms a
#     fresh sandbox resolves it with no per-run mount — the global host-store
#     sharing, not a workflow change, makes it visible (requirements 1.4, 1.5).
#   - `all` runs `guest` then `smoke`.
#
# Every external tool and path is overridable through `FABRO_DARWIN_VERIFY_*`
# environment variables so the same script can be pointed at fixtures; the
# suite in tests/fabro-darwin-builds/dispatch-verify.test.js drives each
# observation through fakes and asserts the failure label.
{
  pkgs,
  lib,
  imageName ? "localhost/fabro-sandbox",
  coreutils ? pkgs.coreutils,
  jq ? pkgs.jq,
  gnugrep ? pkgs.gnugrep,
  nix ? lib.getExe pkgs.nix,
  podman ? lib.getExe pkgs.podman,
  tailscale ? "tailscale",
  launchctl ? "launchctl",
  systemctl ? "systemctl",
  stat ? "stat",
  smoke ? "fabro-darwin-build-smoke",
  machinesFile ? "/run/fabro-darwin-builders/machines",
  digestFile ? "/run/fabro-sandbox/digest",
  hostName ? "mac-builder.tuxedo-musical.ts.net",
  builderName ? "mac-builder",
  builderTag ? "tag:mac-builder",
  authService ? "system/org.nixos.mac-builder-tailscale-auth",
  credentialFile ? "/run/secrets/builder-tailscale-oauth-secret",
  authLog ? "/var/log/mac-builder-tailscale-auth.err.log",
  reauthTimeout ? 180,
  localSystem ? pkgs.stdenv.hostPlatform.system,
}:
pkgs.writeShellApplication {
  name = "fabro-darwin-dispatch-verify";
  runtimeInputs = [
    coreutils
    gnugrep
    jq
  ];
  text = ''
    set -euo pipefail

    version="0.1.0"

    # The builder schedules exactly one system, so the machines entry must name
    # it and a local build must be requested for this host's own system.
    target_system="aarch64-darwin"
    local_system="${localSystem}"
    # The sandbox image name the guest loaded; the default reference stays
    # `<name>@<digest>` so the resolution step exercises the image the smoke
    # built in.
    image_name="${imageName}"

    tailscale_bin="''${FABRO_DARWIN_VERIFY_TAILSCALE:-${tailscale}}"
    launchctl_bin="''${FABRO_DARWIN_VERIFY_LAUNCHCTL:-${launchctl}}"
    systemctl_bin="''${FABRO_DARWIN_VERIFY_SYSTEMCTL:-${systemctl}}"
    stat_bin="''${FABRO_DARWIN_VERIFY_STAT:-${stat}}"
    nix_bin="''${FABRO_DARWIN_VERIFY_NIX:-${nix}}"
    podman_bin="''${FABRO_DARWIN_VERIFY_PODMAN:-${podman}}"
    smoke_bin="''${FABRO_DARWIN_VERIFY_SMOKE:-${smoke}}"
    machines="''${FABRO_DARWIN_VERIFY_MACHINES:-${machinesFile}}"
    digest_file="''${FABRO_DARWIN_VERIFY_DIGEST:-${digestFile}}"
    host_name="''${FABRO_DARWIN_VERIFY_HOST:-${hostName}}"
    builder_name="''${FABRO_DARWIN_VERIFY_BUILDER_NAME:-${builderName}}"
    tag="''${FABRO_DARWIN_VERIFY_TAG:-${builderTag}}"
    auth_service="''${FABRO_DARWIN_VERIFY_AUTH_SERVICE:-${authService}}"
    credential="''${FABRO_DARWIN_VERIFY_CREDENTIAL:-${credentialFile}}"
    auth_log="''${FABRO_DARWIN_VERIFY_AUTH_LOG:-${authLog}}"
    reauth_timeout="''${FABRO_DARWIN_VERIFY_REAUTH_TIMEOUT:-${toString reauthTimeout}}"

    workdir="$(mktemp -d)"
    cleanup() {
      rm -rf "$workdir"
    }
    trap cleanup EXIT

    fail() {
      printf 'fabro-darwin-dispatch-verify: [verify-failure: %s] %s\n' "$1" "$2" >&2
      exit 1
    }

    report() {
      printf 'fabro-darwin-dispatch-verify: [%s] %s\n' "$1" "$2"
    }

    usage() {
      cat <<'USAGE'
    fabro-darwin-dispatch-verify — capture the live Darwin dispatch observations.

    USAGE:
      fabro-darwin-dispatch-verify <subcommand>

    SUBCOMMANDS:
      builder  Run on the Builder Host: require the `mac-builder-tailscale-auth`
               LaunchDaemon and its root-only OAuth credential, then log the
               node out and wait for a *new* credential-driven join line in the
               daemon log plus `Running` with the builder tag. A node that was
               already Running without that fresh join does not pass
               (Requirements 4.3, 4.9, 4.10, 4.11).
      guest    Run on the Fabro Guest: require the machines renderer active, one
               `0600 root root` machines line that addresses the builder's tailnet
               name for `aarch64-darwin`, `nix-daemon` to have (re)started after
               the renderer, and a trivial `aarch64-linux` build to run locally
               (Requirements 1.2, 3.2, 6.6).
      smoke    Run on the Fabro Guest: run `fabro-darwin-build-smoke`, confirm the
               reported store path exists in the guest store, and confirm a fresh
               sandbox resolves it with no per-run mount (Requirements 1.4, 1.5,
               8.6).
      all      Run `guest` then `smoke`.

    ENVIRONMENT OVERRIDES:
      FABRO_DARWIN_VERIFY_TAILSCALE       tailscale executable (default: tailscale).
      FABRO_DARWIN_VERIFY_LAUNCHCTL       launchctl executable (default: launchctl).
      FABRO_DARWIN_VERIFY_SYSTEMCTL       systemctl executable (default: systemctl).
      FABRO_DARWIN_VERIFY_STAT            stat executable (default: stat).
      FABRO_DARWIN_VERIFY_NIX             nix executable (default: the packaged nix).
      FABRO_DARWIN_VERIFY_PODMAN          podman executable (default: the packaged podman).
      FABRO_DARWIN_VERIFY_SMOKE           fabro-darwin-build-smoke executable.
      FABRO_DARWIN_VERIFY_MACHINES        Machines file (default: the module's machinesFile).
      FABRO_DARWIN_VERIFY_DIGEST          Loader digest file used to form the default image reference.
      FABRO_DARWIN_VERIFY_IMAGE           Explicit sandbox image reference.
      FABRO_DARWIN_VERIFY_HOST            Builder tailnet name expected in the machines line.
      FABRO_DARWIN_VERIFY_BUILDER_NAME    Tailnet hostname the auth daemon logs when it joins.
      FABRO_DARWIN_VERIFY_TAG             Builder tailnet tag expected on the node.
      FABRO_DARWIN_VERIFY_AUTH_SERVICE    launchd job expected to be loaded on the builder.
      FABRO_DARWIN_VERIFY_CREDENTIAL      Root-only OAuth credential path (never read).
      FABRO_DARWIN_VERIFY_AUTH_LOG        Auth daemon error log carrying the join line.
      FABRO_DARWIN_VERIFY_REAUTH_TIMEOUT  Seconds to wait for the daemon rejoin (default: 180).

    OPTIONS:
      -h, --help     Print this help and exit 0.
      -V, --version  Print the version banner and exit 0.

    Failures print `fabro-darwin-dispatch-verify: [verify-failure: <label>] <detail>`.
    USAGE
    }

    run_builder() {
      local status_json backend tags marker log_offset deadline joined

      case "$reauth_timeout" in
        ""|*[!0-9]*)
          fail invalid_configuration "FABRO_DARWIN_VERIFY_REAUTH_TIMEOUT must be a non-negative integer: $reauth_timeout"
          ;;
      esac

      if ! "$launchctl_bin" print "$auth_service" >/dev/null 2>&1; then
        fail auth_service_missing "launchd job is not loaded: $auth_service (the OAuth credential path is unused)"
      fi
      report builder "auth daemon loaded: $auth_service"

      # Presence and readability only: the credential value is never read,
      # printed, or hashed. Its root-only path is what the daemon consumes.
      if [ ! -e "$credential" ]; then
        fail credential_missing "OAuth credential is missing: $credential"
      fi
      if [ ! -f "$credential" ]; then
        fail credential_missing "OAuth credential is not a regular file: $credential"
      fi
      if [ ! -r "$credential" ]; then
        fail credential_missing "OAuth credential is not readable: $credential"
      fi
      if [ ! -s "$credential" ]; then
        fail credential_missing "OAuth credential is empty: $credential"
      fi
      report builder "OAuth credential present (value not read): $credential"

      # A status read that fails outright means tailscaled itself is unusable;
      # a non-Running state is not fatal here because the controlled logout
      # below drives the same re-authentication path the daemon handles.
      if ! status_json="$("$tailscale_bin" status --json 2>/dev/null)"; then
        fail tailnet_status "cannot read tailnet state via $tailscale_bin"
      fi
      backend="$(printf '%s' "$status_json" | jq -r '.BackendState // ""')"

      if [ ! -r "$auth_log" ]; then
        fail auth_log_missing "auth daemon log is missing or unreadable: $auth_log (the credential-driven join cannot be confirmed)"
      fi
      log_offset="$(wc -l <"$auth_log" | tr -d '[:space:]')"

      # Controlled re-authentication: withdraw the current session and require
      # the installed daemon to restore it from the OAuth credential. A node
      # that is already Running was not necessarily joined this way, so only a
      # join line written after this offset counts as evidence.
      if ! "$tailscale_bin" logout; then
        if [ "$backend" = "Running" ]; then
          fail reauth_logout_failed "cannot log the node out to force a fresh credential-driven join (BackendState=$backend)"
        fi
        report builder "node is already $backend; the session is lost so no logout was needed"
      else
        report builder "logged the node out; waiting for the daemon to rejoin with the OAuth credential"
      fi

      marker="joining the tailnet as ''${builder_name} (''${tag})"
      deadline=$(( $(date +%s) + reauth_timeout ))
      joined=0
      backend=""
      tags=""
      while :; do
        tail -n "+$((log_offset + 1))" "$auth_log" >"$workdir/join.log" 2>/dev/null || true
        if grep -Fq -- "$marker" "$workdir/join.log"; then
          joined=1
        fi
        if status_json="$("$tailscale_bin" status --json 2>/dev/null)"; then
          backend="$(printf '%s' "$status_json" | jq -r '.BackendState // ""')"
          tags="$(printf '%s' "$status_json" | jq -r '(.Self.Tags // []) | join(",")')"
        else
          backend=""
        fi
        if [ "$joined" -eq 1 ] && [ "$backend" = "Running" ]; then
          if printf '%s' "$status_json" |
            jq -e --arg tag "$tag" '(.Self.Tags // []) | index($tag) != null' >/dev/null; then
            break
          fi
        fi
        if [ "$(date +%s)" -ge "$deadline" ]; then
          if [ "$joined" -eq 0 ]; then
            if [ "$backend" = "Running" ]; then
              fail fresh_join_missing "node is already Running with a tag, but $auth_log holds no new '$marker' line since the logout: a pre-existing session is not evidence of a credential-driven join"
            fi
            fail tailnet_not_running "BackendState=''${backend:-unknown} after ''${reauth_timeout}s; the OAuth credential did not restore membership (see $auth_log)"
          fi
          if [ "$backend" != "Running" ]; then
            fail tailnet_not_running "BackendState=''${backend:-unknown} after the credential-driven join was logged"
          fi
          fail tailnet_tag_missing "node rejoined without the builder tag: tags=[$tags] expected=$tag"
        fi
        sleep 2
      done

      report builder "credential-driven join logged: $marker"
      report builder "node is Running with $tag (joined from the OAuth credential without an interactive login)"
      report builder "all checks passed"
    }

    run_guest() {
      local state stat_line lines line endpoint system_field
      local daemon_mono renderer_mono local_path

      if ! state="$("$systemctl_bin" is-active fabro-darwin-builders.service 2>/dev/null)"; then
        state="unknown"
      fi
      state="$(printf '%s' "$state" | head -n 1)"
      if [ "$state" != "active" ]; then
        fail renderer_not_active "fabro-darwin-builders.service is '$state' (expected active)"
      fi
      report guest "renderer unit active: fabro-darwin-builders.service"

      if ! state="$("$systemctl_bin" is-active nix-daemon.service 2>/dev/null)"; then
        state="unknown"
      fi
      state="$(printf '%s' "$state" | head -n 1)"
      if [ "$state" != "active" ]; then
        fail daemon_not_active "nix-daemon.service is '$state' (expected active)"
      fi

      if [ ! -e "$machines" ]; then
        fail machines_missing "machines file is missing: $machines"
      fi
      if [ ! -r "$machines" ]; then
        fail machines_missing "machines file is not readable: $machines"
      fi

      if ! stat_line="$("$stat_bin" -c '%a %U %G' "$machines" 2>/dev/null)"; then
        fail machines_permissions "cannot read the machines file permissions: $machines"
      fi
      stat_line="$(printf '%s' "$stat_line" | head -n 1)"
      if [ "$stat_line" != "600 root root" ]; then
        fail machines_permissions "machines file is '$stat_line' (expected '600 root root'): $machines"
      fi

      lines=0
      line=""
      while IFS= read -r candidate || [ -n "$candidate" ]; do
        case "$candidate" in
          *[![:space:]]*)
            lines=$((lines + 1))
            if [ -z "$line" ]; then
              line="$candidate"
            fi
            ;;
        esac
      done <"$machines"
      if [ "$lines" -ne 1 ]; then
        fail machines_line_count "machines file has $lines non-empty line(s) (expected exactly one): $machines"
      fi

      read -r -a fields <<<"$line"
      if [ "''${#fields[@]}" -lt 2 ]; then
        fail machines_entry_missing "machines line is malformed: $line"
      fi
      endpoint="''${fields[0]}"
      system_field="''${fields[1]}"

      case "$endpoint" in
        "ssh-ng://"*"@$host_name") ;;
        *)
          fail machines_host_mismatch "machines endpoint is not ssh-ng://<user>@$host_name: $endpoint"
          ;;
      esac
      if [ "$system_field" != "$target_system" ]; then
        fail machines_system_mismatch "machines entry targets '$system_field' (expected $target_system): $line"
      fi
      report guest "machines file is 600 root root with one $target_system entry: $machines -> $endpoint"

      # The daemon reads `builders` when it starts, so its activation must not
      # predate the renderer finishing. Monotonic microseconds avoid clock
      # changes and both units are read from systemd itself.
      if ! renderer_mono="$("$systemctl_bin" show -p ExecMainExitTimestampMonotonic --value fabro-darwin-builders.service 2>/dev/null)"; then
        renderer_mono=""
      fi
      if ! [[ "$renderer_mono" =~ ^[0-9]+$ ]]; then
        fail renderer_state "cannot read the renderer completion timestamp: fabro-darwin-builders.service"
      fi
      if [ "$renderer_mono" -eq 0 ]; then
        fail renderer_state "fabro-darwin-builders.service has no completion timestamp (the renderer never ran)"
      fi

      if ! daemon_mono="$("$systemctl_bin" show -p ActiveEnterTimestampMonotonic --value nix-daemon.service 2>/dev/null)"; then
        daemon_mono=""
      fi
      if ! [[ "$daemon_mono" =~ ^[0-9]+$ ]]; then
        fail daemon_not_restarted "cannot read the daemon activation timestamp: nix-daemon.service"
      fi
      if [ "$daemon_mono" -eq 0 ]; then
        fail daemon_not_restarted "nix-daemon.service has never entered the active state"
      fi
      if [ "$daemon_mono" -lt "$renderer_mono" ]; then
        fail daemon_not_restarted "nix-daemon entered active at ''${daemon_mono}us, before the renderer finished at ''${renderer_mono}us"
      fi
      report guest "nix-daemon started after the renderer (''${daemon_mono}us >= ''${renderer_mono}us)"

      # `aarch64-linux` requests never match the single `aarch64-darwin` entry,
      # so a successful local build proves the dispatch wiring did not capture
      # the guest's own builds.
      # shellcheck disable=SC2016 # `$out` belongs to the Nix expression.
      local_expr='derivation {
        name = "fabro-darwin-dispatch-verify-local";
        system = "'"$local_system"'";
        builder = "/bin/sh";
        args = [ "-c" "echo ok > $out" ];
      }'
      if ! local_path="$("$nix_bin" build --no-link --print-out-paths --impure \
        --expr "$local_expr" 2>"$workdir/local-build.err")"; then
        fail local_build_failed "$(tail -n 1 "$workdir/local-build.err")"
      fi
      local_path="$(printf '%s\n' "$local_path" | tail -n 1)"
      if [ -z "$local_path" ]; then
        fail local_build_failed "nix build printed no store path for $local_system"
      fi
      if [ ! -e "$local_path" ]; then
        fail local_build_failed "local $local_system build output is missing: $local_path"
      fi
      report guest "local $local_system build ran: $local_path"

      report guest "all checks passed"
    }

    run_smoke() {
      local smoke_out store_path ref digest

      if [ ! -x "$smoke_bin" ]; then
        fail smoke_missing "fabro-darwin-build-smoke is not executable: $smoke_bin"
      fi

      if ! smoke_out="$("$smoke_bin" 2>&1)"; then
        printf '%s\n' "$smoke_out" >&2
        fail smoke_failed "fabro-darwin-build-smoke failed (see the step banner above)"
      fi

      store_path=""
      while IFS= read -r candidate || [ -n "$candidate" ]; do
        case "$candidate" in
          "fabro-darwin-build-smoke: store path: "*)
            store_path="''${candidate#"fabro-darwin-build-smoke: store path: "}"
            ;;
        esac
      done <<<"$smoke_out"
      if [ -z "$store_path" ]; then
        printf '%s\n' "$smoke_out" >&2
        fail smoke_output "fabro-darwin-build-smoke printed no store path"
      fi
      if [ ! -e "$store_path" ]; then
        fail store_path_missing "store path is not present in the guest store: $store_path"
      fi

      ref="''${FABRO_DARWIN_VERIFY_IMAGE:-}"
      if [ -z "$ref" ]; then
        if [ ! -r "$digest_file" ]; then
          fail image_reference_missing "digest file is missing: $digest_file (set FABRO_DARWIN_VERIFY_IMAGE)"
        fi
        digest="$(cat "$digest_file")"
        if [ -z "$digest" ]; then
          fail image_reference_missing "digest file is empty: $digest_file (set FABRO_DARWIN_VERIFY_IMAGE)"
        fi
        ref="$image_name@$digest"
      fi

      # No per-run mount: the sandbox reaches the guest store through the global
      # `[containers]` mounts, which is what "without any workflow change" means
      # for a Fabro run (requirements 1.4, 1.5).
      if ! "$podman_bin" run --rm "$ref" /bin/bash -c "test -e $store_path" >/dev/null 2>&1; then
        fail sandbox_resolution_failed "store path does not resolve inside the sandbox image ($ref): $store_path"
      fi

      report smoke "store path $store_path exists in the guest store"
      report smoke "store path resolves in $ref with no per-run mount"
      report smoke "all checks passed"
    }

    run_all() {
      run_guest
      run_smoke
      report all "all checks passed"
    }

    case "''${1:-}" in
      -h | --help)
        usage
        ;;
      -V | --version)
        printf 'fabro-darwin-dispatch-verify %s\n' "$version"
        ;;
      builder)
        run_builder
        ;;
      guest)
        run_guest
        ;;
      smoke)
        run_smoke
        ;;
      all)
        run_all
        ;;
      "")
        usage >&2
        fail invalid_arguments "no subcommand given (expected: builder|guest|smoke|all)"
        ;;
      *)
        fail invalid_arguments "unknown subcommand: $1 (expected: builder|guest|smoke|all)"
        ;;
    esac
  '';
}
