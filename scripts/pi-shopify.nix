{
  lib,
  pi,
  pkgs,
}:
pkgs.writeShellScriptBin "pi" ''
  set -eu

  PI_PROXY_API_KEY="$(${pkgs.coreutils}/bin/timeout --kill-after=2s 15s devx llm-gateway print-token --key 2>/dev/null)" || {
    echo "Error: Failed to get PI_PROXY_API_KEY from devx llm-gateway print-token --key within 15 seconds" >&2
    exit 1
  }
  export PI_PROXY_API_KEY
  export PI_PROXY_AUTH_HEADER="Bearer $PI_PROXY_API_KEY"

  PI_PROXY_BASE_URL="$(${pkgs.coreutils}/bin/timeout --kill-after=2s 15s devx llm-gateway print-token --base 2>/dev/null)" || {
    echo "Error: Failed to get PI_PROXY_BASE_URL from devx llm-gateway print-token --base within 15 seconds" >&2
    exit 1
  }
  export PI_PROXY_BASE_URL

  exec ${lib.getExe pi} "$@"
''
