# fabro-darwin-build-smoke: request a trivial `aarch64-darwin` build from a
# sandbox and confirm the resulting store path landed in the guest store
# (mac-builder-for-fabro-nix-darwin-builds, task 5.1; design "Component
# Contracts → Verification → `fabro-darwin-build-smoke`"; requirements 6.12,
# 8.5, 8.6, 8.7).
#
# The command runs on the Fabro Guest as root, so it proves the whole path:
# sandbox → guest Nix daemon → ssh-ng → Builder Host → guest store. Each step
# prints a banner and a failure names the step and the offending path:
#
#   1. preflight — both build-session secret paths are readable and non-empty
#      and the rendered machines file contains an `aarch64-darwin` entry;
#   2. build     — `podman run --rm <ref> /bin/bash -c '<nix build …>'` in the
#      guest's local Podman store, requesting the design's trivial derivation
#      (builder `/bin/sh`, one output file);
#   3. report    — the printed store path exists in the guest store and is
#      reported for the operator.
#
# `name` is the sandbox image name (fabro.sandboxImage.name) baked in at build
# time. Without a positional IMAGE_REF the reference is
# `<name>@$(cat /run/fabro-sandbox/digest)`, so the smoke exercises the image
# the guest just loaded. The material paths are the module's evaluated option
# values, passed at build time; the CLI contract stays `[IMAGE_REF]`. The
# target system is not an input: it is always `aarch64-darwin`, so the smoke
# cannot be reconfigured into a local build.
{
  pkgs,
  name,
  clientKeyPath ? "/run/secrets/build-client-key",
  hostKeyPath ? "/run/secrets/build-host-key",
  machinesFile ? "/run/fabro-darwin-builders/machines",
  digestFile ? "/run/fabro-sandbox/digest",
  podman ? pkgs.podman,
  coreutils ? pkgs.coreutils,
}:
let
  # The smoke exists to prove the Darwin dispatch, so its target is fixed at
  # `aarch64-darwin` here and is deliberately not derived from the guest's
  # `fabro.darwinBuilder.machine.system` option: a misconfigured option must
  # fail this preflight, not let the smoke build a local `aarch64-linux`
  # derivation and report success without ever reaching the builder.
  targetSystem = "aarch64-darwin";
in
pkgs.writeShellApplication {
  name = "fabro-darwin-build-smoke";
  runtimeInputs = [
    podman
    coreutils
  ];
  text = ''
    set -euo pipefail

    image_ref=""
    if [ "$#" -ge 1 ]; then
      image_ref="$1"
      shift
    fi
    if [ "$#" -ne 0 ]; then
      printf 'fabro-darwin-build-smoke: unexpected argument: %s\n' "$1" >&2
      printf 'usage: fabro-darwin-build-smoke [IMAGE_REF]\n' >&2
      exit 2
    fi

    step=""
    banner() {
      printf 'fabro-darwin-build-smoke: [%s] %s\n' "$1" "$2"
    }
    fail() {
      printf 'fabro-darwin-build-smoke: [%s] %s\n' "$step" "$1" >&2
      exit 1
    }

    require_material() {
      local label="$1"
      local material_path="$2"
      if [ ! -e "$material_path" ]; then
        fail "$label is missing: $material_path"
      fi
      if [ ! -f "$material_path" ]; then
        fail "$label is not a regular file: $material_path"
      fi
      if [ ! -r "$material_path" ]; then
        fail "$label is not readable: $material_path"
      fi
      if [ ! -s "$material_path" ]; then
        fail "$label is empty: $material_path"
      fi
    }

    step="preflight"
    banner "$step" "checking build-session material"
    require_material "Build Client Key" "${clientKeyPath}"
    require_material "pinned Builder Host Key" "${hostKeyPath}"
    require_material "machines file" "${machinesFile}"

    # The machines file is one entry per line and the daemon parses the
    # system from the second whitespace-separated field (design "machines CLI
    # contract": `<host> <system> <client-key-path> …`; task 1.1). Check only
    # that column: scanning every field would accept the system token in the
    # host, the key path, or any other field while the real entry targets a
    # different system.
    found_system=0
    while IFS= read -r line || [ -n "$line" ]; do
      read -r -a fields <<< "$line" || continue
      [ "''${#fields[@]}" -ge 2 ] || continue
      case "''${fields[0]}" in
        '#'*) continue ;;
      esac
      if [ "''${fields[1]}" = "${targetSystem}" ]; then
        found_system=1
        break
      fi
    done < "${machinesFile}"
    if [ "$found_system" -ne 1 ]; then
      fail "machines file has no ${targetSystem} entry: ${machinesFile}"
    fi

    step="build"
    banner "$step" "requesting a trivial ${targetSystem} build"
    if [ -z "$image_ref" ]; then
      if [ ! -r "${digestFile}" ]; then
        fail "image reference unavailable: digest file is missing: ${digestFile}"
      fi
      digest="$(cat "${digestFile}")"
      if [ -z "$digest" ]; then
        fail "image reference unavailable: digest file is empty: ${digestFile}"
      fi
      image_ref="${name}@$digest"
    fi

    # The design's trivial derivation: the builder is /bin/sh (present on
    # macOS), it runs unsandboxed, and the output is one file. `$out` stays
    # inside the single-quoted Nix expression.
    # shellcheck disable=SC2016
    build_expr='derivation {
      name = "fabro-darwin-build-smoke";
      system = "${targetSystem}";
      builder = "/bin/sh";
      args = [ "-c" "echo ok > $out" ];
    }'
    build_command="nix build --no-link --print-out-paths --expr '$build_expr'"

    if ! container_output="$(podman run --rm "$image_ref" /bin/bash -c "$build_command")"; then
      fail "podman run failed for image reference: $image_ref"
    fi
    store_path="$(printf '%s\n' "$container_output" | tail -n 1)"
    if [ -z "$store_path" ]; then
      fail "build printed no store path for image reference: $image_ref"
    fi

    step="report"
    banner "$step" "confirming the store path in the guest store"
    if [ ! -e "$store_path" ]; then
      fail "store path is not present in the guest store: $store_path"
    fi

    printf 'fabro-darwin-build-smoke: store path: %s\n' "$store_path"
    printf 'fabro-darwin-build-smoke: all steps passed (ref=%s)\n' "$image_ref"
  '';
}
