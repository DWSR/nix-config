{
  bearerReference,
  restEndpoint,
  writeShellApplication,
  coreutils,
  lib,
  nodejs_22,
  obsidian-importer-deps,
  keychainPath ? null,
}:

writeShellApplication {
  name = "agentmemory-import-obsidian";
  runtimeInputs = [
    coreutils
    nodejs_22
  ];
  text = ''
    requires_secret=1
    for argument in "$@"; do
      case "$argument" in
        --endpoint|--url|--endpoint=*|--url=*)
          echo "ERROR: managed importer does not accept --endpoint or --url; it always uses the configured AgentMemory service." >&2
          exit 2
          ;;
        --dry-run|--help|-h) requires_secret=0 ;;
      esac
    done

    if [ "$requires_secret" -eq 1 ] && [ -z "''${AGENTMEMORY_SECRET:-}" ]; then
      security_bin="''${AGENTMEMORY_IMPORT_SECURITY_BIN:-/usr/bin/security}"
      keychain_path="''${AGENTMEMORY_IMPORT_KEYCHAIN_PATH:-${
        if keychainPath == null then
          "$HOME/Library/Keychains/login.keychain-db"
        else
          lib.escapeShellArg keychainPath
      }}"
      agentmemory_secret=$(${coreutils}/bin/timeout --kill-after=2s 5s "$security_bin" find-generic-password -s mcpproxy -a ${lib.escapeShellArg bearerReference} -w "$keychain_path" 2>/dev/null) || agentmemory_secret=""
      if [ -z "$agentmemory_secret" ]; then
        echo "ERROR: AgentMemory bearer unavailable from macOS Keychain; import not started." >&2
        exit 1
      fi
      export AGENTMEMORY_SECRET="$agentmemory_secret"
    fi

    export AGENTMEMORY_URL=${lib.escapeShellArg restEndpoint}
    export NODE_PATH=${obsidian-importer-deps}/lib/node_modules
    exec ${nodejs_22}/bin/node --experimental-strip-types ${./agentmemory-import-obsidian.ts} "$@"
  '';
}
