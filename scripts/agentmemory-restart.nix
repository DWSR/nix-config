{
  coreutils,
  writeShellApplication,
}:

writeShellApplication {
  name = "restart-agentmemory";
  runtimeInputs = [ coreutils ];
  text = ''
    set -eu

    launchctl_bin="''${AGENTMEMORY_RESTART_LAUNCHCTL_BIN:-/bin/launchctl}"
    launchd_domain="''${AGENTMEMORY_RESTART_LAUNCHD_DOMAIN:-gui/$(id -u)}"
    launchd_label="dev.dwsr.agentmemory"

    exec "$launchctl_bin" kickstart -k "$launchd_domain/$launchd_label"
  '';
}
