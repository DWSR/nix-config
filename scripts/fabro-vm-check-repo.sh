#!/usr/bin/env bash
set -euo pipefail

# Copy the current working tree into the running Fabro Lima VM and perform
# evaluation, package-presence, and NixOS build checks using the VM's Nix daemon.
# This deliberately does not run nixos-rebuild switch or activate the result.

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
vm_name="${FABRO_VM_NAME:-fabro}"
remote_dir="${FABRO_VM_CHECK_DIR:-/tmp/fabro-vm-check-repo}"
lima_home="${LIMA_HOME:-${HOME}/.local/state/lima}"
ssh_config="${lima_home}/${vm_name}/ssh.config"
remote_host="lima-${vm_name}"

if [[ ! -f "${repo}/flake.nix" || ! -f "${repo}/flake.lock" ]]; then
  printf 'Expected a locked flake at %s\n' "${repo}" >&2
  exit 1
fi
if [[ ! -f "${ssh_config}" ]]; then
  printf 'Fabro VM SSH config not found: %s (is the VM running?)\n' "${ssh_config}" >&2
  exit 1
fi

remote() {
  ssh -F "${ssh_config}" "${remote_host}" "$@"
}

printf 'Copying %s to %s:%s\n' "${repo}" "${remote_host}" "${remote_dir}"
remote "mkdir -p '${remote_dir}'"
tar \
  --exclude=.git \
  --exclude=.direnv \
  --exclude=result \
  --exclude='result-*' \
  --exclude=.pre-commit-config.yaml \
  --exclude='*.aac' \
  --exclude='*.mp4*' \
  --exclude='*.mp3' \
  -cf - -C "${repo}" . \
  | gzip \
  | remote "tar -xzf - -C '${remote_dir}'"

printf 'Running checks on Fabro VM (no activation)\n'
remote "bash -s -- '${remote_dir}'" <<'REMOTE_SCRIPT'
set -euo pipefail
repo="$1"
cd "$repo"

echo '== Guest configuration evaluation =='
printf '%s\n' "$(nix eval --raw .#nixosConfigurations.fabro-vm.config.system.build.toplevel.drvPath)"

echo '== Smoke package is in guest system packages =='
if ! nix eval --impure --raw --expr '
  let
    flake = builtins.getFlake (toString ./.);
    packages = flake.nixosConfigurations.fabro-vm.config.environment.systemPackages;
  in
    if builtins.any (package: package.name == "fabro-darwin-build-smoke") packages
    then "present"
    else throw "fabro-darwin-build-smoke is missing from fabro-vm system packages"
'
then
  echo 'fabro-darwin-build-smoke is missing from fabro-vm system packages' >&2
  exit 1
fi

echo '== Build guest system closure without activating it =='
nix build .#nixosConfigurations.fabro-vm.config.system.build.toplevel --no-link

echo 'All Fabro VM checks passed. No nixos-rebuild switch was run.'
REMOTE_SCRIPT
