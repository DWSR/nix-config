{ pkgs }:
pkgs.writeShellApplication {
  name = "fabro-darwin-live-failure-validate";
  runtimeInputs = [
    pkgs.coreutils
    pkgs.gawk
    pkgs.gnugrep
    pkgs.jq
  ];
  text = ''
    set -euo pipefail

    guest_name="''${FABRO_GUEST_LIMA_NAME:-fabro}"
    builder_name="''${MAC_BUILDER_LIMA_NAME:-mac-builder}"
    guest_key_path=/run/secrets/build-client-key
    oauth_path=/run/secrets/builder-tailscale-oauth-secret
    machines_file=/run/fabro-darwin-builders/machines
    auth_log=/var/log/mac-builder-tailscale-auth.err
    backup_suffix=.fabro-live-failure-validation-backup
    # RFC 8032 Ed25519 public test vector rendered as OpenSSH public-key text.
    # The machines field contains base64 of the complete key-file contents.
    test_host_key="$(printf '%s\n' 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINdamAGCsQq31Uv+08lkBzoO4XLz2qYjJa8CGmj3B1Ea fabro-live-failure-test' | base64 | tr -d '\n')"
    results="''${FABRO_DARWIN_FAILURE_VALIDATION_RESULTS:-$PWD/.kiro/specs/mac-builder-for-fabro-nix-darwin-builds/live-failure-validation-5.7.md}"
    lima_vmctl="''${LIMA_VMCTL:-lima-vmctl}"
    restore_only=false
    confirmed=false
    guest_restore_pending=false
    builder_restore_pending=false
    machines_restore_pending=false
    acl_denied_active=false
    builder_rejoin_required=false
    builder_rejoin_confirmed=false
    tmp_output=
    tmp_journal=
    probe_counter=0

    is_client_key_rejection() {
      local builder_host="$1"
      local diagnostic="$2"
      [[ -n "$builder_host" ]] || return 1
      printf '%s\n' "$diagnostic" | ${pkgs.gawk}/bin/awk -v host="$builder_host" '
        BEGIN { text = "" }
        { text = text "\n" tolower($0); if (index($0, host)) host_found = 1 }
        END {
          rejected = text ~ /(permission denied[^\n]*publickey|publickey[^\n]*permission denied|authentication failed[^\n]*publickey)/
          exit !(host_found && rejected)
        }
      '
    }

    is_host_key_mismatch() {
      local builder_host="$1"
      local diagnostic="$2"
      [[ -n "$builder_host" ]] || return 1
      printf '%s\n' "$diagnostic" | ${pkgs.gawk}/bin/awk -v host="$builder_host" '
        BEGIN { text = "" }
        { text = text "\n" tolower($0); if (index($0, host)) host_found = 1 }
        END {
          mismatch = text ~ /(host key verification failed|remote host identification has changed|host key mismatch|host key.*does not match|does not match.*host key)/
          exit !(host_found && mismatch)
        }
      '
    }

    parse_journal_cursor() {
      local journal_output="$1"
      printf '%s\n' "$journal_output" | ${pkgs.gawk}/bin/awk '
        /^-- cursor: / {
          cursor = substr($0, 12)
          if (cursor == "" || cursor ~ /[[:space:]]/ || count != 0) invalid = 1
          count++
          next
        }
        NF { invalid = 1 }
        END {
          if (count != 1 || invalid) exit 1
          print cursor
        }
      '
    }

    combine_probe_diagnostics() {
      printf '%s\n%s' "$1" "$2"
    }

    is_expected_failure() {
      case "$1" in
        failure|client-key-failure|host-key-failure|acl-failure) return 0 ;;
        *) return 1 ;;
      esac
    }

    expected_failure_matches() {
      local expectation="$1"
      local owner="$2"
      local diagnostic="$3"
      case "$expectation" in
        failure)
          [[ -n "$owner" ]] && printf '%s\n' "$diagnostic" | ${pkgs.gnugrep}/bin/grep -Fq -- "$owner"
          ;;
        client-key-failure) is_client_key_rejection "$owner" "$diagnostic" ;;
        host-key-failure) is_host_key_mismatch "$owner" "$diagnostic" ;;
        acl-failure) is_acl_transport_failure "$owner" "$diagnostic" ;;
        *) return 1 ;;
      esac
    }

    builder_backend_not_running() {
      printf '%s\n' "$1" | ${pkgs.jq}/bin/jq -e '(.BackendState | type == "string" and length > 0) and (.BackendState != "Running")' >/dev/null
    }

    # These remote transactions keep a byte-for-byte backup and the exact
    # generated variant beside the machines file, so restore-only can reject
    # edits it did not create.
    # shellcheck disable=SC2016
    machines_override_remote="$(cat <<'MACHINES_OVERRIDE'
    set -euo pipefail
    machine_file="$1"
    field="$2"
    replacement="$3"
    enforce_root="$4"
    backup="''${machine_file}.fabro-live-failure-validation-backup"
    variant="''${machine_file}.fabro-live-failure-validation-override"
    case "$field" in
      client-key) field_number=3 ;;
      host-key) field_number=8 ;;
      *) printf "Unsupported machines field: %s\n" "$field" >&2; exit 2 ;;
    esac
    if [[ "$replacement" =~ [[:space:]] ]]; then
      printf "Machines replacement must be one field.\n" >&2
      exit 2
    fi
    if [[ -e "$backup" || -L "$backup" || -e "$variant" || -L "$variant" ]]; then
      printf "A machines override backup already exists; restore it before starting another.\n" >&2
      exit 1
    fi
    for stage_path in "$machine_file".fabro-live-failure-validation-stage.*; do
      if [[ -e "$stage_path" || -L "$stage_path" ]]; then
        printf "A machines transaction staging path already exists at %s; manual recovery is required.\n" "$stage_path" >&2
        exit 1
      fi
    done
    if [[ ! -f "$machine_file" || -L "$machine_file" ]]; then
      printf "Machines file is not a regular file: %s\n" "$machine_file" >&2
      exit 1
    fi
    if [[ "$enforce_root" == true && "$(stat -c "%u:%g:%a" "$machine_file")" != "0:0:600" ]]; then
      printf "Machines file must remain root:root mode 0600: %s\n" "$machine_file" >&2
      exit 1
    fi
    cp -p -- "$machine_file" "$backup"
    chmod 0600 "$backup"
    if [[ "$enforce_root" == true ]]; then chown root:root "$backup"; fi
    if ! cmp -s -- "$machine_file" "$backup"; then
      printf "Machines file changed while its backup was created.\n" >&2
      exit 1
    fi
    candidate="$(mktemp "''${machine_file}.tmp.XXXXXX")"
    trap 'rm -f -- "$candidate"' EXIT
    if awk -v target="$field_number" -v replacement="$replacement" '
      NR == 1 {
        offset = 1
        count = 0
        while (match(substr($0, offset), /[^[:space:]]+/)) {
          count++
          start = offset + RSTART - 1
          if (count == target) {
            target_start = start
            target_length = RLENGTH
            target_value = substr($0, start, RLENGTH)
          }
          offset += RSTART + RLENGTH - 1
        }
        if (count != 8 || target_start == 0 || target_value == replacement) exit 1
        print substr($0, 1, target_start - 1) replacement substr($0, target_start + target_length)
        changed = 1
        next
      }
      { exit 1 }
      END { if (NR != 1 || !changed) exit 1 }
    ' "$machine_file" > "$candidate"; then
      :
    else
      printf "Machines file must contain exactly one eight-field line with a replaceable field.\n" >&2
      exit 1
    fi
    chmod 0600 "$candidate"
    if [[ "$enforce_root" == true ]]; then chown root:root "$candidate"; fi
    if ! cmp -s -- "$machine_file" "$backup"; then
      printf "Machines file changed before the override could be installed.\n" >&2
      exit 1
    fi
    if ! ln -T -- "$candidate" "$variant"; then
      printf "Could not create the machines override marker without replacing an existing path.\n" >&2
      exit 1
    fi
    rm -- "$candidate"
    candidate=
    trap - EXIT
    stage_dir="$(mktemp -d "$machine_file.fabro-live-failure-validation-stage.XXXXXX")"
    staged_file="$stage_dir/current"
    if ! mv -- "$machine_file" "$staged_file"; then
      printf "Could not preserve the current machines file for the override transaction; backup remains at %s.\n" "$backup" >&2
      exit 1
    fi
    if ! cmp -s -- "$staged_file" "$backup"; then
      printf "Machines file changed during override installation; preserved staged file at %s and backup at %s. Manual recovery is required.\n" "$staged_file" "$backup" >&2
      exit 1
    fi
    if [[ -e "$machine_file" || -L "$machine_file" ]]; then
      printf "Machines path reappeared during override installation; preserved it, staged file at %s, and backup at %s. Manual recovery is required.\n" "$staged_file" "$backup" >&2
      exit 1
    fi
    install_temp="$stage_dir/install"
    cp -- "$variant" "$install_temp"
    chmod 0600 "$install_temp"
    if [[ "$enforce_root" == true ]]; then chown root:root "$install_temp"; fi
    if ! ln -T -- "$install_temp" "$machine_file"; then
      printf "Machines path reappeared before override installation; preserved it, staged file at %s, and backup at %s. Manual recovery is required.\n" "$staged_file" "$backup" >&2
      exit 1
    fi
    if ! cmp -s -- "$machine_file" "$variant" || ! cmp -s -- "$staged_file" "$backup"; then
      printf "Machines transaction changed during override installation; preserved the current path, staged file at %s, and backup at %s. Manual recovery is required.\n" "$staged_file" "$backup" >&2
      exit 1
    fi
    rm -- "$staged_file" "$install_temp"
    rmdir -- "$stage_dir"
    printf OVERRIDDEN
    MACHINES_OVERRIDE
    )"

    # shellcheck disable=SC2016
    machines_restore_remote="$(cat <<'MACHINES_RESTORE'
    set -euo pipefail
    machine_file="$1"
    enforce_root="$2"
    test_host_key="$3"
    backup="''${machine_file}.fabro-live-failure-validation-backup"
    variant="''${machine_file}.fabro-live-failure-validation-override"
    shopt -s nullglob
    stage_dirs=( "$machine_file".fabro-live-failure-validation-stage.* )
    shopt -u nullglob
    if [[ ! -e "$backup" && ! -L "$backup" && ! -e "$variant" && ! -L "$variant" && "''${#stage_dirs[@]}" -eq 0 ]]; then
      printf NO_OVERRIDE
      exit 0
    fi
    if [[ ! -f "$backup" || -L "$backup" ]]; then
      printf "Machines backup is missing or not a regular file; refusing restoration.\n" >&2
      exit 1
    fi
    if [[ "$enforce_root" == true && "$(stat -c "%u:%g:%a" "$backup")" != "0:0:600" ]]; then
      printf "Machines backup must remain root:root mode 0600; refusing restoration.\n" >&2
      exit 1
    fi
    variant_valid=false
    if [[ -e "$variant" || -L "$variant" ]]; then
      if [[ ! -f "$variant" || -L "$variant" ]]; then
        printf "Machines override variant is not a regular file; refusing restoration.\n" >&2
        exit 1
      fi
      if [[ "$enforce_root" == true && "$(stat -c "%u:%g:%a" "$variant")" != "0:0:600" ]]; then
        printf "Machines override variant must remain root:root mode 0600; refusing restoration.\n" >&2
        exit 1
      fi
      expected="$(mktemp "''${machine_file}.tmp.XXXXXX")"
      trap 'rm -f -- "$expected"' EXIT
      for target in 3 8; do
        if [[ "$target" == 3 ]]; then replacement=/dev/null; else replacement="$test_host_key"; fi
        if awk -v target="$target" -v replacement="$replacement" '
          NR == 1 {
            offset = 1
            count = 0
            while (match(substr($0, offset), /[^[:space:]]+/)) {
              count++
              start = offset + RSTART - 1
              if (count == target) {
                target_start = start
                target_length = RLENGTH
                target_value = substr($0, start, RLENGTH)
              }
              offset += RSTART + RLENGTH - 1
            }
            if (count != 8 || target_start == 0 || target_value == replacement) exit 1
            print substr($0, 1, target_start - 1) replacement substr($0, target_start + target_length)
            changed = 1
            next
          }
          { exit 1 }
          END { if (NR != 1 || !changed) exit 1 }
        ' "$backup" > "$expected" && cmp -s -- "$expected" "$variant"; then
          variant_valid=true
          break
        fi
      done
      rm -f -- "$expected"
      trap - EXIT
      if [[ "$variant_valid" != true ]]; then
        printf "Machines override variant is not one of the exact helper-generated test variants; refusing restoration.\n" >&2
        exit 1
      fi
    fi
    validate_stage_directory() {
      local stage_dir="$1"
      local stage_basename="''${stage_dir##*/}"
      local machine_basename="''${machine_file##*/}"
      local expected_prefix="''${machine_basename}.fabro-live-failure-validation-stage."
      local stage_suffix="''${stage_basename#"$expected_prefix"}"
      local child
      local child_name
      local -a stage_children
      if [[ "$stage_basename" != "$expected_prefix"* || ! "$stage_suffix" =~ ^[[:alnum:]]{6}$ ]]; then
        printf "Machines staging directory has an invalid helper-generated name: %s; refusing restoration.\n" "$stage_dir" >&2
        exit 1
      fi
      if [[ ! -d "$stage_dir" || -L "$stage_dir" ]]; then
        printf "Machines staging path is not a regular directory: %s; refusing restoration.\n" "$stage_dir" >&2
        exit 1
      fi
      shopt -s nullglob dotglob
      stage_children=( "$stage_dir"/* )
      shopt -u dotglob nullglob
      for child in "''${stage_children[@]}"; do
        child_name="''${child##*/}"
        case "$child_name" in
          current|install|restore) ;;
          *)
            printf "Machines staging directory contains an unexpected staging child: %s; refusing restoration.\n" "$child" >&2
            exit 1
            ;;
        esac
        if [[ ! -f "$child" || -L "$child" ]]; then
          printf "Machines staging child is not a regular non-symlink file: %s; refusing restoration.\n" "$child" >&2
          exit 1
        fi
        if [[ "$enforce_root" == true && "$(stat -c "%u:%g:%a" "$child")" != "0:0:600" ]]; then
          printf "Machines staging child must remain root:root mode 0600: %s; refusing restoration.\n" "$child" >&2
          exit 1
        fi
        case "$child_name" in
          current)
            if cmp -s -- "$child" "$backup"; then
              :
            elif [[ "$variant_valid" == true ]] && cmp -s -- "$child" "$variant"; then
              :
            else
              printf "Staged current file differs from both the original backup and exact helper-generated variant; refusing restoration.\n" >&2
              exit 1
            fi
            ;;
          install)
            if [[ "$variant_valid" != true ]] || ! cmp -s -- "$child" "$variant"; then
              printf "Staged install file differs from the exact helper-generated variant; refusing restoration.\n" >&2
              exit 1
            fi
            ;;
          restore)
            if ! cmp -s -- "$child" "$backup"; then
              printf "Staged restore file differs from the original backup; refusing restoration.\n" >&2
              exit 1
            fi
            ;;
        esac
      done
    }
    for stage_dir in "''${stage_dirs[@]}"; do
      if [[ ! -f "$backup" || -L "$backup" || "$variant_valid" != true ]]; then
        printf "Machines transaction staging paths require a valid original backup and helper-generated variant; refusing restoration.\n" >&2
        exit 1
      fi
      validate_stage_directory "$stage_dir"
    done
    if [[ -e "$machine_file" || -L "$machine_file" ]]; then
      if [[ ! -f "$machine_file" || -L "$machine_file" ]]; then
        printf "Machines path is not a regular file; refusing restoration.\n" >&2
        exit 1
      fi
      if [[ "$enforce_root" == true && "$(stat -c "%u:%g:%a" "$machine_file")" != "0:0:600" ]]; then
        printf "Machines file must remain root:root mode 0600; refusing restoration.\n" >&2
        exit 1
      fi
      if cmp -s -- "$machine_file" "$backup"; then
        :
      elif [[ "$variant_valid" == true ]] && cmp -s -- "$machine_file" "$variant"; then
        stage_dir="$(mktemp -d "$machine_file.fabro-live-failure-validation-stage.XXXXXX")"
        staged_file="$stage_dir/current"
        if ! mv -- "$machine_file" "$staged_file"; then
          printf "Could not preserve the current machines file for restoration; backup remains at %s. Manual recovery is required.\n" "$backup" >&2
          exit 1
        fi
        if ! cmp -s -- "$staged_file" "$variant"; then
          printf "Machines file changed during restoration; preserved staged file at %s and backup at %s. Manual recovery is required.\n" "$staged_file" "$backup" >&2
          exit 1
        fi
        if [[ -e "$machine_file" || -L "$machine_file" ]]; then
          printf "Machines path reappeared during restoration; preserved it, staged file at %s, and backup at %s. Manual recovery is required.\n" "$staged_file" "$backup" >&2
          exit 1
        fi
        restore_temp="$stage_dir/restore"
        cp -- "$backup" "$restore_temp"
        chmod 0600 "$restore_temp"
        if [[ "$enforce_root" == true ]]; then chown root:root "$restore_temp"; fi
        if ! ln -T -- "$restore_temp" "$machine_file"; then
          printf "Machines path reappeared before restoration; preserved it, staged file at %s, and backup at %s. Manual recovery is required.\n" "$staged_file" "$backup" >&2
          exit 1
        fi
        if ! cmp -s -- "$machine_file" "$backup" || ! cmp -s -- "$staged_file" "$variant"; then
          printf "Machines transaction changed during restoration; preserved the current path, staged file at %s, and backup at %s. Manual recovery is required.\n" "$staged_file" "$backup" >&2
          exit 1
        fi
        rm -- "$staged_file" "$restore_temp"
        rmdir -- "$stage_dir"
      else
        printf "Machines file differs from both its original backup and helper-generated override; refusing to overwrite it.\n" >&2
        exit 1
      fi
    else
      if [[ ! -f "$variant" || -L "$variant" || "$variant_valid" != true ]]; then
        printf "Machines file is absent and no exact helper-generated override exists; refusing restoration.\n" >&2
        exit 1
      fi
      stage_dir="$(mktemp -d "$machine_file.fabro-live-failure-validation-stage.XXXXXX")"
      restore_temp="$stage_dir/restore"
      cp -- "$backup" "$restore_temp"
      chmod 0600 "$restore_temp"
      if [[ "$enforce_root" == true ]]; then chown root:root "$restore_temp"; fi
      if ! ln -T -- "$restore_temp" "$machine_file"; then
        printf "Machines path reappeared before restoration; preserved it, staged install at %s and backup at %s. Manual recovery is required.\n" "$restore_temp" "$backup" >&2
        exit 1
      fi
      if ! cmp -s -- "$machine_file" "$backup"; then
        printf "Machines transaction changed during restoration; preserved the current path and backup at %s. Manual recovery is required.\n" "$backup" >&2
        exit 1
      fi
      rm -- "$restore_temp"
      rmdir -- "$stage_dir"
    fi
    if ! cmp -s -- "$machine_file" "$backup"; then
      printf "Machines restore did not reproduce the original file.\n" >&2
      exit 1
    fi
    for stage_dir in "''${stage_dirs[@]}"; do
      validate_stage_directory "$stage_dir"
      shopt -s nullglob dotglob
      stage_children=( "$stage_dir"/* )
      shopt -u dotglob nullglob
      for staged_path in "''${stage_children[@]}"; do
        rm -- "$staged_path"
      done
      rmdir -- "$stage_dir"
    done
    rm -f -- "$backup" "$variant"
    printf RESTORED
    MACHINES_RESTORE
    )"

    # shellcheck disable=SC2016
    machines_state_remote="$(cat <<'MACHINES_STATE'
    if [[ -e "$1.fabro-live-failure-validation-backup" || -L "$1.fabro-live-failure-validation-backup" ]]; then backup=1; else backup=0; fi
    if [[ -e "$1.fabro-live-failure-validation-override" || -L "$1.fabro-live-failure-validation-override" ]]; then variant=1; else variant=0; fi
    printf "BACKUP=%s VARIANT=%s\n" "$backup" "$variant"
    MACHINES_STATE
    )"

    usage() {
      cat <<'USAGE'
    Usage: fabro-darwin-live-failure-validate --confirm-live-state-changes [--restore-only]

    Runs the operator-gated task 5.7 failure and recovery checks against the
    live fabro and mac-builder Lima guests. The script temporarily moves only
    the named runtime secret path entries and restores them automatically.

    Options:
      --classify-acl-probe HOST     Offline diagnostic classifier; reads stdin and never contacts Lima
      --classify-client-key-probe HOST Offline public-key diagnostic classifier
      --classify-host-key-probe HOST  Offline pinned-host-key diagnostic classifier
      --classify-journal-probe KIND HOST Offline expected-failure classifier; stdin supplies journal-only diagnostics
      --test-parse-journal-cursor    Offline nix-daemon journal cursor parser check
      --check-builder-not-running    Offline Tailscale status fixture check
      --check-builder-self-identity Offline identity fixture check; reads stdin and never contacts Lima
      --test-machines-override FILE FIELD VALUE Offline machines transaction test
      --test-machines-restore FILE   Offline machines transaction restore test
      --confirm-live-state-changes  Acknowledge that validation changes live state
      --restore-only                Restore stale same-directory secret backups only
      --help                        Show this help

    Live operation requires an interactive TTY. ACL changes remain manual.
    During ACL denial, retain an ICMP-only grant to preserve MagicDNS visibility
    while denying TCP/22; see configurations/mac-builder/README.md.
    Do not run this command unless the operator can restore the ACL grant and
    remain available through the recovery probes.
    USAGE
    }

    fail() {
      printf 'ERROR: %s\n' "$1" >&2
      exit 1
    }

    validate_test_machines_path() {
      local machine_file="$1"
      local temp_root
      local fixture_dir
      local fixture_name
      temp_root="$(realpath -e -- "''${TMPDIR:-/tmp}")" || fail 'Test machines modes require an existing TMPDIR.'
      case "$temp_root" in
        /tmp|/private/tmp|/var/tmp|/private/var/tmp|/var/folders/*/T|/private/var/folders/*/T) ;;
        *) fail "Test machines modes require a canonical system temporary directory; refusing TMPDIR $temp_root." ;;
      esac
      fixture_dir="$(realpath -e -- "$(dirname -- "$machine_file")")" || fail 'Test machines modes require an existing temporary fixture directory.'
      fixture_name="$(basename -- "$machine_file")"
      [[ "$fixture_name" == fabro-machines-* && "$fixture_name" != fabro-machines- ]] || fail 'Test machines modes require a fixture filename beginning with fabro-machines-.'
      case "$fixture_dir" in
        "$temp_root"/*) ;;
        *) fail "Test machines modes require a temporary fixture beneath canonical TMPDIR ($temp_root)." ;;
      esac
      [[ ! -L "$machine_file" ]] || fail 'Test machines modes refuse a symlink fixture.'
      if [[ -e "$machine_file" && ! -f "$machine_file" ]]; then
        fail 'Test machines modes require a regular fixture file.'
      fi
    }

    is_acl_transport_failure() {
      local builder_host="$1"
      local diagnostic="$2"
      [[ -n "$builder_host" ]] || return 1
      printf '%s\n' "$diagnostic" | ${pkgs.gawk}/bin/awk -v host="$builder_host" '
        index($0, host) && tolower($0) ~ /(connection timed out|operation timed out|connection refused|no route to host|network is unreachable|network unreachable|network is down|host is down|connection reset by peer)/ {
          found = 1
        }
        END { exit !found }
      '
    }

    builder_self_has_required_tag() {
      local identity_json="$1"
      printf '%s\n' "$identity_json" | ${pkgs.jq}/bin/jq -e '
        .status as $status |
        .whois.Node as $node |
        ($status.Self.TailscaleIPs[0] // "") as $self_ip |
        ($status.BackendState == "Running") and
        ($self_ip != "") and
        (($node.Name // "" | ascii_downcase | sub("\\.$"; "") | split(".")[0]) == "mac-builder") and
        (any(($node.Addresses // [])[]?; split("/")[0] == $self_ip)) and
        (any(($node.Tags // [])[]?; . == "tag:nix-remote-builder"))
      ' >/dev/null
    }

    while (($#)); do
      case "$1" in
        --classify-acl-probe)
          [[ $# -eq 2 ]] || fail '--classify-acl-probe requires exactly one host argument and diagnostics on stdin.'
          diagnostic="$(cat)"
          if is_acl_transport_failure "$2" "$diagnostic"; then
            printf 'ACL_TRANSPORT_FAILURE\n'
            exit 0
          else
            printf 'NOT_ACL_TRANSPORT_FAILURE\n'
            exit 1
          fi
          ;;
        --classify-client-key-probe)
          [[ $# -eq 2 ]] || fail '--classify-client-key-probe requires exactly one host argument and diagnostics on stdin.'
          diagnostic="$(cat)"
          if is_client_key_rejection "$2" "$diagnostic"; then
            printf 'CLIENT_KEY_REJECTED\n'
            exit 0
          else
            printf 'NOT_CLIENT_KEY_REJECTION\n'
            exit 1
          fi
          ;;
        --classify-host-key-probe)
          [[ $# -eq 2 ]] || fail '--classify-host-key-probe requires exactly one host argument and diagnostics on stdin.'
          diagnostic="$(cat)"
          if is_host_key_mismatch "$2" "$diagnostic"; then
            printf 'HOST_KEY_MISMATCH\n'
            exit 0
          else
            printf 'NOT_HOST_KEY_MISMATCH\n'
            exit 1
          fi
          ;;
        --classify-journal-probe)
          [[ $# -eq 3 ]] || fail '--classify-journal-probe requires an expectation, one host argument, and journal diagnostics on stdin.'
          diagnostic="$(cat)"
          diagnostics="$(combine_probe_diagnostics "" "$diagnostic")"
          if expected_failure_matches "$2" "$3" "$diagnostics"; then
            case "$2" in
              failure) printf 'EXPECTED_FAILURE\n' ;;
              client-key-failure) printf 'CLIENT_KEY_REJECTED\n' ;;
              host-key-failure) printf 'HOST_KEY_MISMATCH\n' ;;
              acl-failure) printf 'ACL_TRANSPORT_FAILURE\n' ;;
            esac
            exit 0
          else
            printf 'NOT_EXPECTED_FAILURE\n'
            exit 1
          fi
          ;;
        --test-parse-journal-cursor)
          [[ $# -eq 1 ]] || fail '--test-parse-journal-cursor accepts journalctl --show-cursor output on stdin.'
          cursor_output="$(cat)"
          parse_journal_cursor "$cursor_output"
          exit $?
          ;;
        --check-builder-not-running)
          [[ $# -eq 1 ]] || fail '--check-builder-not-running accepts a JSON Tailscale status fixture on stdin.'
          status_fixture="$(cat)"
          if builder_backend_not_running "$status_fixture"; then
            printf 'BUILDER_NOT_RUNNING\n'
            exit 0
          else
            printf 'BUILDER_STILL_RUNNING\n'
            exit 1
          fi
          ;;
        --check-builder-self-identity)
          [[ $# -eq 1 ]] || fail '--check-builder-self-identity accepts a JSON identity fixture on stdin.'
          identity_fixture="$(cat)"
          if builder_self_has_required_tag "$identity_fixture"; then
            printf 'BUILDER_SELF_TAG_VERIFIED\n'
            exit 0
          else
            printf 'BUILDER_SELF_TAG_NOT_VERIFIED\n'
            exit 1
          fi
          ;;
        --test-machines-override)
          [[ $# -eq 4 ]] || fail '--test-machines-override requires FILE FIELD VALUE.'
          validate_test_machines_path "$2"
          bash -c "$machines_override_remote" bash "$2" "$3" "$4" false
          exit $?
          ;;
        --test-machines-restore)
          [[ $# -eq 2 ]] || fail '--test-machines-restore requires FILE.'
          validate_test_machines_path "$2"
          bash -c "$machines_restore_remote" bash "$2" false "$test_host_key"
          exit $?
          ;;
        --confirm-live-state-changes) confirmed=true; shift ;;
        --restore-only) restore_only=true; shift ;;
        --help|-h) usage; exit 0 ;;
        *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
      esac
    done

    [[ "$confirmed" == true ]] || fail 'Live operation requires --confirm-live-state-changes.'
    [[ -t 0 && -t 1 && -r /dev/tty ]] || fail 'Live operation requires an interactive TTY on stdin and stdout.'
    command -v "$lima_vmctl" >/dev/null 2>&1 || fail 'lima-vmctl is unavailable; use the host environment that manages these VMs.'

    lima_shell() {
      LIMA_HOME="''${LIMA_HOME:-$HOME/.local/state/lima}" "$lima_vmctl" shell "$@"
    }

    remote_root_script() {
      local instance="$1"
      local script="$2"
      shift 2
      if [[ "$instance" == "$builder_name" ]]; then
        lima_shell "$instance" env SUDO_ASKPASS=/tmp/mac-builder-askpass sudo -A bash -c "$script" bash "$@"
      else
        lima_shell "$instance" sudo -n bash -c "$script" bash "$@"
      fi
    }

    remote_root_command() {
      local instance="$1"
      shift
      if [[ "$instance" == "$builder_name" ]]; then
        lima_shell "$instance" env SUDO_ASKPASS=/tmp/mac-builder-askpass sudo -A "$@"
      else
        lima_shell "$instance" sudo -n "$@"
      fi
    }

    # shellcheck disable=SC2016
    journal_cursor_remote='journalctl --unit=nix-daemon.service --lines=0 --show-cursor --no-pager --quiet'
    # shellcheck disable=SC2016
    journal_after_cursor_remote='set -euo pipefail
    journalctl --unit=nix-daemon.service --after-cursor="$1" --output=cat --no-pager'

    capture_journal_cursor() {
      local cursor_output
      local cursor
      if ! cursor_output="$(remote_root_script "$guest_name" "$journal_cursor_remote" 2>/dev/null)"; then
        return 1
      fi
      cursor="$(parse_journal_cursor "$cursor_output")" || return 1
      printf '%s' "$cursor"
    }

    fetch_journal_after_cursor() {
      local cursor="$1"
      : > "$tmp_journal"
      chmod 0600 "$tmp_journal"
      if remote_root_script "$guest_name" "$journal_after_cursor_remote" "$cursor" > "$tmp_journal" 2>&1; then
        return 0
      fi
      : > "$tmp_journal"
      return 1
    }

    backup_path() {
      printf '%s%s' "$1" "$backup_suffix"
    }

    # shellcheck disable=SC2016
    path_exists_remote='if [[ -e "$1" || -L "$1" ]]; then printf PRESENT; else printf ABSENT; fi'
    # shellcheck disable=SC2016
    hide_path_remote='set -euo pipefail
    source_path="$1"
    backup_path="$2"
    if [[ -e "$backup_path" || -L "$backup_path" ]]; then
      printf "Backup already exists: %s\n" "$backup_path" >&2
      exit 1
    fi
    if [[ ! -e "$source_path" && ! -L "$source_path" ]]; then
      printf "Runtime path is missing: %s\n" "$source_path" >&2
      exit 1
    fi
    mv -n "$source_path" "$backup_path"
    if [[ -e "$source_path" || -L "$source_path" ]] || [[ ! -e "$backup_path" && ! -L "$backup_path" ]]; then
      printf "Could not move runtime path to its backup: %s\n" "$source_path" >&2
      exit 1
    fi
    printf HIDDEN'
    # shellcheck disable=SC2016
    restore_path_remote='set -euo pipefail
    source_path="$1"
    backup_path="$2"
    if [[ ! -e "$backup_path" && ! -L "$backup_path" ]]; then
      printf NO_BACKUP
      exit 0
    fi
    if [[ -e "$source_path" || -L "$source_path" ]]; then
      printf "Refusing to overwrite reappeared runtime path: %s\n" "$source_path" >&2
      exit 1
    fi
    mv -n "$backup_path" "$source_path"
    if [[ -e "$backup_path" || -L "$backup_path" ]]; then
      printf "Refusing to overwrite reappeared runtime path: %s\n" "$source_path" >&2
      exit 1
    fi
    if [[ ! -e "$source_path" && ! -L "$source_path" ]]; then
      printf "Restore did not recreate runtime path: %s\n" "$source_path" >&2
      exit 1
    fi
    printf RESTORED'

    has_stale_backup() {
      local instance="$1"
      local source_path="$2"
      local backup
      backup="$(backup_path "$source_path")"
      local state
      state="$(remote_root_script "$instance" "$path_exists_remote" "$backup")" || fail "Could not check for a stale backup on $instance."
      if [[ "$state" == PRESENT ]]; then
        fail "Stale backup exists on $instance at $backup; run --restore-only before validation."
      fi
    }

    restore_backup() {
      local instance="$1"
      local source_path="$2"
      local backup
      backup="$(backup_path "$source_path")"
      local result
      result="$(remote_root_script "$instance" "$restore_path_remote" "$source_path" "$backup")" || return 1
      case "$result" in
        RESTORED) printf 'Restored runtime path on %s: %s\n' "$instance" "$source_path" ;;
        NO_BACKUP)
          local source_state
          source_state="$(remote_root_script "$instance" "$path_exists_remote" "$source_path")" || return 1
          [[ "$source_state" == PRESENT ]] || return 1
          ;;
        *) printf 'Unexpected restore response from %s.\n' "$instance" >&2; return 1 ;;
      esac
    }

    override_machines_file() {
      local field="$1"
      local replacement="$2"
      local result
      result="$(remote_root_script "$guest_name" "$machines_override_remote" "$machines_file" "$field" "$replacement" true)" || return 1
      [[ "$result" == OVERRIDDEN ]] || {
        printf 'Unexpected machines override response: %s\n' "$result" >&2
        return 1
      }
    }

    restore_machines_file() {
      local result
      result="$(remote_root_script "$guest_name" "$machines_restore_remote" "$machines_file" true "$test_host_key")" || return 1
      case "$result" in
        RESTORED) printf 'Restored guest machines file: %s\n' "$machines_file" ;;
        NO_OVERRIDE) ;;
        *) printf 'Unexpected machines restore response: %s\n' "$result" >&2; return 1 ;;
      esac
    }

    has_stale_machines_override() {
      local state
      state="$(remote_root_script "$guest_name" "$machines_state_remote" "$machines_file")" || fail 'Could not inspect stale machines-file recovery artifacts.'
      [[ "$state" == 'BACKUP=0 VARIANT=0' ]] || fail "Stale machines-file recovery artifacts exist ($state); run --restore-only before validation."
    }

    append_evidence() {
      printf '%s\n' "$1" >> "$results"
    }

    manual_acl_reminder() {
      local message='MANUAL RESTORATION REQUIRED: restore the fabro-vm ACL access to mac-builder.tuxedo-musical.ts.net before considering the live system recovered.'
      printf '\n> **%s**\n' "$message" >> "$results" 2>/dev/null || true
      printf '\n*** %s ***\n' "$message" >&2
    }

    cleanup() {
      local status="$?"
      trap - EXIT INT TERM HUP
      if [[ "$builder_restore_pending" == true ]]; then
        if restore_backup "$builder_name" "$oauth_path"; then
          if [[ "$builder_rejoin_required" == true && "$builder_rejoin_confirmed" != true ]]; then
            printf 'MANUAL RECOVERY REQUIRED: the builder OAuth path was restored, but local mac-builder rejoin with tag:nix-remote-builder was not confirmed.\n' >&2
            append_evidence '> **MANUAL RECOVERY REQUIRED:** verify that the local mac-builder identity rejoins with tag:nix-remote-builder.' 2>/dev/null || true
            status=1
          else
            builder_restore_pending=false
          fi
        else
          printf 'MANUAL RESTORATION REQUIRED: restore %s on %s from its same-directory backup without overwriting a reappeared path.\n' "$oauth_path" "$builder_name" >&2
          append_evidence '> **MANUAL RESTORATION REQUIRED:** restore the builder OAuth runtime path from its same-directory backup.' 2>/dev/null || true
          status=1
        fi
      fi
      if [[ "$machines_restore_pending" == true ]]; then
        if restore_machines_file; then
          machines_restore_pending=false
        else
          printf 'MANUAL RESTORATION REQUIRED: restore %s only from its same-directory backup if the current file is the exact helper-generated override; preserve unexpected edits.\n' "$machines_file" >&2
          append_evidence '> **MANUAL RESTORATION REQUIRED:** restore the guest machines file only after checking it against its original backup and helper-generated override.' 2>/dev/null || true
          status=1
        fi
      fi
      if [[ "$guest_restore_pending" == true ]]; then
        if restore_backup "$guest_name" "$guest_key_path"; then
          guest_restore_pending=false
        else
          printf 'MANUAL RESTORATION REQUIRED: restore %s on %s from its same-directory backup without overwriting a reappeared path.\n' "$guest_key_path" "$guest_name" >&2
          append_evidence '> **MANUAL RESTORATION REQUIRED:** restore the guest build-client-key runtime path from its same-directory backup.' 2>/dev/null || true
          status=1
        fi
      fi
      if [[ "$acl_denied_active" == true ]]; then
        manual_acl_reminder
        status=1
      fi
      if [[ -n "$tmp_output" ]]; then
        rm -f -- "$tmp_output"
      fi
      if [[ -n "$tmp_journal" ]]; then
        rm -f -- "$tmp_journal"
      fi
      exit "$status"
    }

    confirm_step() {
      local prompt="$1"
      local answer
      read -r -p "$prompt [y/N] " answer </dev/tty
      case "$answer" in
        y|Y|yes|YES) return 0 ;;
        *) printf 'Operator declined: %s\n' "$prompt" >&2; return 1 ;;
      esac
    }

    run_probe() {
      local expectation="$1"
      local owner="$2"
      local label="$3"
      local status=0
      local probe_id
      local probe_name
      local remote_script
      local journal_cursor=
      probe_counter=$((probe_counter + 1))
      probe_id="''${BASHPID:-$$}-''${RANDOM}-''${RANDOM}-$probe_counter"
      probe_name="fabro-live-failure-$probe_id"
      remote_script="$(cat <<'REMOTE'
    set -euo pipefail
    probe_id="$1"
    image_digest="$(cat /run/fabro-sandbox/digest)"
    case "$image_digest" in
      sha256:*) ;;
      *) printf '%s\n' 'Sandbox image digest is unavailable.' >&2; exit 1 ;;
    esac
    image_ref="localhost/fabro-sandbox@$image_digest"
    nix_expr="derivation { name = \"fabro-live-failure-''${probe_id}\"; system = \"aarch64-darwin\"; builder = \"/bin/sh\"; args = [ \"-c\" \"echo ok > \$out\" ]; }"
    podman run --rm "$image_ref" /bin/bash -c '
      set -euo pipefail
      nix build --no-link --print-out-paths --option substitute false --expr "$1"
    ' bash "$nix_expr"
    REMOTE
      )"
      if is_expected_failure "$expectation"; then
        journal_cursor="$(capture_journal_cursor)" || {
          printf 'ERROR: %s could not establish a fresh nix-daemon journal cursor; refusing to classify the probe.\n' "$label" >&2
          return 1
        }
      fi
      if remote_root_script "$guest_name" "$remote_script" "$probe_id" > "$tmp_output" 2>&1; then
        status=0
      else
        status=$?
      fi

      if is_expected_failure "$expectation"; then
        if ! fetch_journal_after_cursor "$journal_cursor"; then
          printf 'ERROR: %s could not read fresh nix-daemon journal entries; refusing to classify the probe.\n' "$label" >&2
          return 1
        fi
        diagnostics="$(combine_probe_diagnostics "$(<"$tmp_output")" "$(<"$tmp_journal")")"
      else
        diagnostics="$(<"$tmp_output")"
      fi
      if [[ "$expectation" == acl-failure ]]; then
        if [[ "$status" -eq 0 ]]; then
          printf 'ERROR: %s unexpectedly succeeded.\n' "$label" >&2
          return 1
        fi
        if ! expected_failure_matches acl-failure "$owner" "$diagnostics"; then
          printf 'ERROR: %s failed without a connection-level transport failure naming %s.\n' "$label" "$owner" >&2
          return 1
        fi
        append_evidence "- $label: expected connection-level transport failure named $owner"
      elif [[ "$expectation" == client-key-failure ]]; then
        if [[ "$status" -eq 0 ]] || ! expected_failure_matches client-key-failure "$owner" "$diagnostics"; then
          printf 'ERROR: %s was not a builder-named public-key/authentication rejection.\n' "$label" >&2
          return 1
        fi
        append_evidence "- $label: expected public-key rejection named $owner"
      elif [[ "$expectation" == host-key-failure ]]; then
        if [[ "$status" -eq 0 ]] || ! expected_failure_matches host-key-failure "$owner" "$diagnostics"; then
          printf 'ERROR: %s was not a builder-named host-key verification failure.\n' "$label" >&2
          return 1
        fi
        append_evidence "- $label: expected host-key mismatch named $owner"
      elif [[ "$expectation" == failure ]]; then
        if [[ "$status" -eq 0 ]] || ! expected_failure_matches failure "$owner" "$diagnostics"; then
          printf 'ERROR: %s did not fail while naming %s.\n' "$label" "$owner" >&2
          return 1
        fi
        append_evidence "- $label: expected failure named $owner"
      else
        if [[ "$status" -ne 0 ]] || ! ${pkgs.gnugrep}/bin/grep -Fq -- "/nix/store/" "$tmp_output" || ! ${pkgs.gnugrep}/bin/grep -Fq -- "$probe_name" "$tmp_output"; then
          printf 'ERROR: %s did not complete its unique Darwin derivation successfully.\n' "$label" >&2
          return 1
        fi
        append_evidence "- $label: PASS"
      fi
    }

    if [[ "$restore_only" == true ]]; then
      mkdir -p -- "$(dirname -- "$results")"
      touch "$results"
      trap cleanup EXIT
      trap 'exit 130' INT
      trap 'exit 143' TERM
      trap 'exit 129' HUP
      printf 'Restore-only recovery for the guest machines file and runtime secret paths.\n'
      machines_state="$(remote_root_script "$guest_name" "$machines_state_remote" "$machines_file")" || fail "Could not inspect guest machines-file recovery artifacts; check $guest_name and rerun --restore-only."
      if [[ "$machines_state" != 'BACKUP=0 VARIANT=0' ]]; then
        confirm_step "Restore the guest machines file $machines_file from its matching same-directory backup?" || exit 1
        machines_restore_pending=true
        restore_machines_file || fail 'Could not safely restore the guest machines file; check both backup and override, then rerun --restore-only.'
        machines_restore_pending=false
      fi
      guest_backup="$(backup_path "$guest_key_path")"
      guest_backup_state="$(remote_root_script "$guest_name" "$path_exists_remote" "$guest_backup")" || fail "Could not inspect the guest backup; check $guest_name and rerun --restore-only."
      if [[ "$guest_backup_state" == PRESENT ]]; then
        confirm_step "Restore the guest runtime path $guest_key_path from its same-directory backup?" || exit 1
        guest_restore_pending=true
        restore_backup "$guest_name" "$guest_key_path" || fail "Could not restore the guest runtime path; check $guest_name and rerun --restore-only."
        guest_restore_pending=false
      fi
      builder_backup="$(backup_path "$oauth_path")"
      builder_backup_state="$(remote_root_script "$builder_name" "$path_exists_remote" "$builder_backup")" || fail "Could not inspect the builder backup; check $builder_name and rerun --restore-only."
      if [[ "$builder_backup_state" == PRESENT ]]; then
        confirm_step "Restore the builder OAuth runtime path $oauth_path from its same-directory backup?" || exit 1
        builder_restore_pending=true
        restore_backup "$builder_name" "$oauth_path" || fail "Could not restore the builder runtime path; check $builder_name and rerun --restore-only."
        builder_restore_pending=false
      fi
      append_evidence '- Restore-only recovery completed; no validation probes were run.'
      trap - EXIT
      exit 0
    fi

    has_stale_backup "$guest_name" "$guest_key_path"
    has_stale_backup "$builder_name" "$oauth_path"
    has_stale_machines_override
    mkdir -p -- "$(dirname -- "$results")"
    touch "$results"
    tmp_output="$(mktemp "''${TMPDIR:-/tmp}/fabro-darwin-live-failure.XXXXXX")"
    chmod 0600 "$tmp_output"
    tmp_journal="$(mktemp "''${TMPDIR:-/tmp}/fabro-darwin-live-journal.XXXXXX")"
    chmod 0600 "$tmp_journal"
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP

    confirm_step 'Temporarily hide the guest build-client-key path; the script will restore it automatically.' || exit 1
    guest_restore_pending=true
    remote_root_script "$guest_name" "$hide_path_remote" "$guest_key_path" "$(backup_path "$guest_key_path")" >/dev/null || fail 'Could not safely hide the guest build-client-key path.'
    append_evidence '- Guest build-client-key runtime path was temporarily hidden.'
    confirm_step 'Run one unique Darwin dispatch probe; it must fail naming /run/secrets/build-client-key.' || exit 1
    missing_key_probe_status=0
    run_probe failure "$guest_key_path" 'Guest missing build-client-key probe' || missing_key_probe_status=$?
    restore_backup "$guest_name" "$guest_key_path" || fail 'Could not restore the guest build-client-key path; automatic cleanup will retry.'
    guest_restore_pending=false
    append_evidence '- Guest build-client-key path restored.'
    confirm_step 'Run a unique Darwin recovery dispatch probe with substitutions disabled.' || exit 1
    run_probe success "" 'Guest build-client-key recovery probe' || fail 'Guest build-client-key recovery probe failed.'
    [[ "$missing_key_probe_status" -eq 0 ]] || fail 'Missing build-client-key probe did not name its runtime path.'

    confirm_step 'Temporarily point the guest machines client-key field to /dev/null; the original file will be restored automatically.' || exit 1
    machines_restore_pending=true
    override_machines_file client-key /dev/null || fail 'Could not safely install the /dev/null client-key override.'
    append_evidence '- Guest machines client-key field temporarily pointed to /dev/null.'
    confirm_step 'Run a unique Darwin dispatch probe; it must report a public-key rejection naming mac-builder.tuxedo-musical.ts.net.' || exit 1
    client_key_probe_status=0
    run_probe client-key-failure mac-builder.tuxedo-musical.ts.net 'Guest unauthorized client-key probe' || client_key_probe_status=$?
    restore_machines_file || fail 'Could not restore the original guest machines file; automatic cleanup will retry.'
    machines_restore_pending=false
    append_evidence '- Guest machines client-key field restored.'
    confirm_step 'Run a unique Darwin recovery dispatch probe after restoring the client-key field.' || exit 1
    run_probe success "" 'Guest unauthorized client-key recovery probe' || fail 'Guest unauthorized client-key recovery probe failed.'
    [[ "$client_key_probe_status" -eq 0 ]] || fail 'Unauthorized client-key probe did not produce the required public-key rejection.'

    confirm_step 'Temporarily replace the guest machines pinned host key with the fixed test-only public key; the original file will be restored automatically.' || exit 1
    machines_restore_pending=true
    override_machines_file host-key "$test_host_key" || fail 'Could not safely install the test-only host-key override.'
    append_evidence '- Guest machines pinned host key temporarily replaced with a test-only public key.'
    confirm_step 'Run a unique Darwin dispatch probe; it must report a host-key verification failure naming mac-builder.tuxedo-musical.ts.net.' || exit 1
    host_key_probe_status=0
    run_probe host-key-failure mac-builder.tuxedo-musical.ts.net 'Guest mismatched host-key probe' || host_key_probe_status=$?
    restore_machines_file || fail 'Could not restore the original guest machines file; automatic cleanup will retry.'
    machines_restore_pending=false
    append_evidence '- Guest machines pinned host key restored.'
    confirm_step 'Run a unique Darwin recovery dispatch probe after restoring the pinned host key.' || exit 1
    run_probe success "" 'Guest mismatched host-key recovery probe' || fail 'Guest mismatched host-key recovery probe failed.'
    [[ "$host_key_probe_status" -eq 0 ]] || fail 'Mismatched host-key probe did not produce the required host-key verification failure.'

    confirm_step 'Temporarily hide the builder OAuth runtime path; the script will restore it automatically.' || exit 1
    builder_restore_pending=true
    remote_root_script "$builder_name" "$hide_path_remote" "$oauth_path" "$(backup_path "$oauth_path")" >/dev/null || fail 'Could not safely hide the builder OAuth runtime path.'
    append_evidence '- Builder OAuth runtime path was temporarily hidden.'
    confirm_step 'Log the local builder out while its OAuth file is hidden; the script will verify its backend is no longer Running.' || exit 1
    builder_rejoin_required=true
    remote_root_command "$builder_name" tailscale logout >/dev/null 2>&1 || fail 'The builder could not be logged out while the OAuth credential was hidden.'
    append_evidence '- Builder logged out while its OAuth runtime path was hidden.'
    logout_status_json="$(remote_root_command "$builder_name" tailscale status --json 2>/dev/null)" || fail 'Could not verify builder status after logout.'
    builder_backend_not_running "$logout_status_json" || fail 'Builder Tailscale backend remained Running after logout; OAuth recovery is not proven.'
    append_evidence '- Builder Tailscale backend was confirmed non-Running after logout.'
    # shellcheck disable=SC2016
    auth_log_count_remote='if [[ -r "$1" ]]; then wc -l < "$1" | tr -d "[:space:]"; else printf 0; fi'
    auth_log_start="$(remote_root_script "$builder_name" "$auth_log_count_remote" "$auth_log")" || fail 'Could not establish the builder auth-log baseline.'
    [[ "$auth_log_start" =~ ^[0-9]+$ ]] || fail 'Builder auth-log baseline was not a line count.'
    printf 'Waiting 65 seconds for the mac-builder auth daemon to iterate with the OAuth path hidden.\n'
    sleep 65
    auth_log_check_remote="$(cat <<'REMOTE'
    set -euo pipefail
    awk -v start="$2" -v path="$3" -v marker="$4" '
      NR > start {
        if (index($0, path)) path_found = 1
        if (index($0, marker)) marker_found = 1
      }
      END { printf "PATH=%d MARKER=%d\n", path_found, marker_found }
    ' "$1"
    REMOTE
    )"
    auth_log_result="$(remote_root_script "$builder_name" "$auth_log_check_remote" "$auth_log" "$auth_log_start" "$oauth_path" FABRO_TAILSCALE_UP_ATTEMPT)" || fail 'Could not inspect new builder auth-log lines.'
    [[ "$auth_log_result" == 'PATH=1 MARKER=0' ]] || fail 'New builder auth-log lines did not prove a missing OAuth path with no tailscale up marker.'
    append_evidence '- Builder auth daemon logged the missing OAuth runtime path; no tailscale-up marker appeared in new log lines.'
    restore_backup "$builder_name" "$oauth_path" || fail 'Could not restore the builder OAuth path; automatic cleanup will retry.'
    append_evidence '- Builder OAuth runtime path restored.'
    printf 'Waiting up to 90 seconds for the auth daemon to rejoin with tag:nix-remote-builder.\n'
    rejoined=false
    elapsed=0
    status_json=
    local_ip=
    whois_json=
    identity_json=
    while ((elapsed < 90)); do
      if status_json="$(remote_root_command "$builder_name" tailscale status --json 2>/dev/null)" \
        && local_ip="$(printf '%s\n' "$status_json" | ${pkgs.jq}/bin/jq -er 'select(.BackendState == "Running") | .Self.TailscaleIPs[0] | strings | select(length > 0)')" \
        && whois_json="$(remote_root_command "$builder_name" tailscale whois --json "$local_ip" 2>/dev/null)" \
        && identity_json="$(printf '%s\n' "$status_json" "$whois_json" | ${pkgs.jq}/bin/jq -cs '{status: .[0], whois: .[1]}')" \
        && builder_self_has_required_tag "$identity_json"; then
        rejoined=true
        break
      fi
      sleep 5
      elapsed=$((elapsed + 5))
    done
    [[ "$rejoined" == true ]] || fail 'Builder did not rejoin with tag:nix-remote-builder within 90 seconds.'
    builder_rejoin_confirmed=true
    builder_restore_pending=false
    append_evidence '- Builder auth daemon rejoined with tag:nix-remote-builder.'

    acl_denied_active=true
    append_evidence '- ACL denial probe started; operator must restore the grant if this process is interrupted.'
    confirm_step 'Pause: deny fabro-vm TCP/22 access to mac-builder.tuxedo-musical.ts.net, retaining an ICMP-only grant (ip: ["icmp:*"]) for MagicDNS visibility; see configurations/mac-builder/README.md. Confirm after saving the policy.' || exit 1
    confirm_step 'Run a unique Darwin dispatch probe; it must fail naming mac-builder.tuxedo-musical.ts.net.' || exit 1
    acl_probe_status=0
    run_probe acl-failure mac-builder.tuxedo-musical.ts.net 'Guest denied-ACL probe' || acl_probe_status=$?
    confirm_step 'Pause: restore fabro-vm TCP/22 access to mac-builder.tuxedo-musical.ts.net and remove the temporary ICMP-only grant, then confirm here.' || exit 1
    append_evidence '- Operator confirmed the guest ACL grant was restored.'
    confirm_step 'Run a unique Darwin recovery dispatch probe after the ACL grant is restored.' || exit 1
    run_probe success "" 'Guest ACL recovery probe' || fail 'Guest ACL recovery probe failed; manual ACL restoration remains required.'
    acl_denied_active=false
    [[ "$acl_probe_status" -eq 0 ]] || fail 'ACL-denial probe did not produce the required connection-level transport failure.'

    append_evidence '- Task 5.7 helper probes completed; live observations remain operator evidence.'
    printf 'Task 5.7 helper evidence recorded at %s\n' "$results"
  '';
}
