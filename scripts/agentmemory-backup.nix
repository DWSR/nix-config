{
  agentmemoryPackage,
  backupDestination,
  coreutils,
  dataDir,
  enginePort,
  lsof,
  restPort,
  runtimeDir,
  streamPort,
  timeoutSeconds ? 30,
  viewerPort,
  writeShellApplication,
}:

writeShellApplication {
  name = "agentmemory-backup";
  runtimeInputs = [
    coreutils
    lsof
  ];
  text = ''
    configured_data_dir=${builtins.toJSON (toString dataDir)}
    configured_backup_destination=${builtins.toJSON (toString backupDestination)}
    configured_runtime_dir=${builtins.toJSON (toString runtimeDir)}
    configured_rest_port=${builtins.toJSON (toString restPort)}
    configured_stream_port=${builtins.toJSON (toString streamPort)}
    configured_viewer_port=${builtins.toJSON (toString viewerPort)}
    configured_engine_port=${builtins.toJSON (toString enginePort)}
    timeout_seconds=${toString timeoutSeconds}
    launchd_label="dev.dwsr.agentmemory"

    data_dir="''${AGENTMEMORY_BACKUP_DATA_DIR:-$configured_data_dir}"
    backup_destination="''${AGENTMEMORY_BACKUP_DESTINATION:-$configured_backup_destination}"
    runtime_dir="''${AGENTMEMORY_BACKUP_RUNTIME_DIR:-$configured_runtime_dir}"
    rest_port="''${AGENTMEMORY_BACKUP_REST_PORT:-$configured_rest_port}"
    lsof_bin="''${AGENTMEMORY_BACKUP_LSOF_BIN:-${lsof}/bin/lsof}"
    pgrep_bin="''${AGENTMEMORY_BACKUP_PGREP_BIN:-/usr/bin/pgrep}"
    cp_bin="''${AGENTMEMORY_BACKUP_CP_BIN:-cp}"
    launchctl_bin="''${AGENTMEMORY_BACKUP_LAUNCHCTL_BIN:-/bin/launchctl}"
    launchd_domain="''${AGENTMEMORY_BACKUP_LAUNCHD_DOMAIN:-gui/$(id -u)}"
    agentmemory_bin="''${AGENTMEMORY_BACKUP_AGENTMEMORY_BIN:-${agentmemoryPackage}/bin/agentmemory}"

    report_failure() {
      phase="$1"
      reason="$2"
      printf 'backup %s=failed: %s\n' "$phase" "$reason" >&2
    }

    if ! AGENTMEMORY_DATA_DIR="$data_dir" AGENTMEMORY_RUNTIME_DIR="$runtime_dir" \
      "$agentmemory_bin" stop --force --port "$rest_port"; then
      report_failure stop "stock stop command"
      exit 1
    fi

    deadline=$((SECONDS + timeout_seconds))
    while :; do
      active_listener=0
      for port in "$rest_port" "$configured_stream_port" "$configured_viewer_port" "$configured_engine_port"; do
        if "$lsof_bin" -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
          active_listener=1
          break
        fi
      done

      active_process=0
      for process_name in agentmemory iii; do
        if "$pgrep_bin" -x "$process_name" >/dev/null 2>&1; then
          active_process=1
          break
        fi
      done

      if [ "$active_listener" -eq 0 ] && [ "$active_process" -eq 0 ]; then
        break
      fi
      if [ "$SECONDS" -ge "$deadline" ]; then
        report_failure stop "timeout waiting for AgentMemory processes/listeners"
        exit 1
      fi
      sleep 1
    done
    printf 'backup stop=ok\n'

    if ! mkdir -p "$backup_destination" \
      || ! "$cp_bin" -a "$data_dir" "$backup_destination"; then
      report_failure copy "managed data directory"
      copy_failed=1
    else
      archive_path="$backup_destination/''${data_dir##*/}"
      printf 'backup copy=ok path=%s\n' "$archive_path"
      copy_failed=0
    fi

    if "$launchctl_bin" kickstart -k "$launchd_domain/$launchd_label"; then
      printf 'backup restart=ok\n'
      restart_failed=0
    else
      report_failure restart "launchd kickstart"
      restart_failed=1
    fi

    if [ "$copy_failed" -ne 0 ] || [ "$restart_failed" -ne 0 ]; then
      exit 1
    fi
  '';
}
