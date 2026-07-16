#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

check_rejected() {
  local fixture="$1"
  local option_path="$2"
  local expression diagnostics diagnostic_path

  diagnostic_path="option \`${option_path}'"

  expression="let
    flake = builtins.getFlake (toString ${repo_root});
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
  in import ${repo_root}/tests/local-binary-cache/invalid-option.test.nix {
    inherit pkgs;
    fixture = \"${fixture}\";
  }"

  if diagnostics="$(nix eval --impure --raw --expr "$expression" 2>&1)"; then
    printf 'fixture %s unexpectedly evaluated successfully\n' "$fixture" >&2
    exit 1
  fi

  if [[ "$diagnostics" != *"$diagnostic_path"* ]]; then
    printf 'fixture %s failed without naming option %s:\n%s\n' \
      "$fixture" "$option_path" "$diagnostics" >&2
    exit 1
  fi
}

check_rejected store-root services.localBinaryCache.publisher.tokenFile
check_rejected store-descendant services.localBinaryCache.publisher.stateDirectory
check_rejected store-dot-component services.localBinaryCache.publisher.tokenFile
check_rejected store-parent-component services.localBinaryCache.publisher.tokenFile
check_rejected store-repeated-separator services.localBinaryCache.publisher.tokenFile
check_rejected store-trailing-separator services.localBinaryCache.publisher.tokenFile
check_rejected store-case-variant services.localBinaryCache.publisher.tokenFile
check_rejected contextual-store services.localBinaryCache.publisher.tokenFile
check_rejected key-not-base64 services.localBinaryCache.cachePublicKey
check_rejected key-bad-padding services.localBinaryCache.cachePublicKey
check_rejected key-noncanonical services.localBinaryCache.cachePublicKey
check_rejected endpoint-fragment services.localBinaryCache.endpoint
check_rejected endpoint-query services.localBinaryCache.endpoint
check_rejected endpoint-userinfo services.localBinaryCache.endpoint
check_rejected endpoint-whitespace services.localBinaryCache.endpoint
check_rejected endpoint-cache-path services.localBinaryCache.endpoint
check_rejected endpoint-trailing-slash services.localBinaryCache.endpoint
check_rejected endpoint-alternate-host services.localBinaryCache.endpoint
