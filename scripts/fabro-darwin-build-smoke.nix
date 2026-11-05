{
  pkgs,
  clientKeyPath ? "/run/secrets/build-client-key",
  hostKeyPath ? "/run/secrets/build-host-key",
  machinesFile ? "/run/fabro-darwin-builders/machines",
  imageName ? "localhost/fabro-sandbox",
  digestFile ? "/run/fabro-sandbox/digest",
  podman ? "podman",
  storeRoot ? "/nix/store",
}:
pkgs.writeShellApplication {
  name = "fabro-darwin-build-smoke";
  runtimeInputs = [
    pkgs.coreutils
    pkgs.gnugrep
    pkgs.gawk
    pkgs.nix
  ];
  text = ''
        set -euo pipefail

        client_key_path="''${FABRO_BUILD_SMOKE_CLIENT_KEY:-${clientKeyPath}}"
        host_key_path="''${FABRO_BUILD_SMOKE_HOST_KEY:-${hostKeyPath}}"
        machines_file="''${FABRO_BUILD_SMOKE_MACHINES:-${machinesFile}}"
        digest_file="''${FABRO_BUILD_SMOKE_DIGEST:-${digestFile}}"
        podman_cmd="''${FABRO_BUILD_SMOKE_PODMAN:-${podman}}"
        store_root="''${FABRO_BUILD_SMOKE_STORE_ROOT:-${storeRoot}}"

        fail() {
          printf 'FAILED: %s: %s\n' "$1" "$2" >&2
          exit 1
        }

        image_ref="''${1:-}"
        if [ "$#" -gt 1 ]; then
          fail 'Usage' 'fabro-darwin-build-smoke [IMAGE_REF]'
        fi
        if [ -z "$image_ref" ]; then
          [ -r "$digest_file" ] || fail 'Step 1' "missing or unreadable path $digest_file"
          digest="$(cat "$digest_file")" || fail 'Step 1' "cannot read $digest_file"
          [ -n "$digest" ] || fail 'Step 1' "empty digest in $digest_file"
          image_ref="${imageName}@$digest"
        fi

        printf '%s\n' 'STEP 1: Preflight'
        for secret in "$client_key_path" "$host_key_path"; do
          [ -r "$secret" ] || fail 'Step 1' "missing or unreadable path $secret"
          [ -s "$secret" ] || fail 'Step 1' "empty path $secret"
        done
        [ -r "$machines_file" ] || fail 'Step 1' "missing or unreadable path $machines_file"
        [ -s "$machines_file" ] || fail 'Step 1' "empty path $machines_file"
        if ! grep -Eq '(^|[[:space:]])aarch64-darwin([[:space:]]|$)' "$machines_file"; then
          fail 'Step 1' "path $machines_file does not include an aarch64-darwin entry"
        fi

        printf '%s\n' 'STEP 2: Build Darwin derivation'
        # shellcheck disable=SC1009,SC1073,SC1072,SC1083
        output="$(
          "$podman_cmd" run --rm "$image_ref" /bin/bash -c "$(cat <<'GUEST_SCRIPT'
    set -euo pipefail
    nix_expr='derivation { name = "fabro-darwin-build-smoke"; system = "aarch64-darwin"; builder = "/bin/sh"; args = [ "-c" "echo ok > $out" ]; }'
    nix build --no-link --print-out-paths --expr "$nix_expr"
    GUEST_SCRIPT
          )"
        )" || fail 'Step 2' 'podman/Nix Darwin build failed'

        store_path="$(printf '%s\n' "$output" | awk 'NF { line = $0 } END { print line }')"
        case "$store_path" in
          ''${store_root}/*) ;;
          *) fail 'Step 2' "build did not report a guest store path: $store_path" ;;
        esac

        printf '%s\n' 'STEP 3: Verify guest store path'
        "$podman_cmd" run --rm "$image_ref" /bin/bash -c "test -e '$store_path'" || fail 'Step 3' "store path does not exist in guest: $store_path"
        printf 'Darwin build smoke output: %s\n' "$store_path"
  '';
}
