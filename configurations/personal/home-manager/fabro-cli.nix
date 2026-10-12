# Fabro CLI on the personal host: after the Lima pivot this mac runs only
# the CLI (the fabro server launchd agent in home-manager/common/fabro.nix
# retired with it) and must reach the guest engine across the tailnet, so
# settings.toml declares the same [cli.target] shape the guest's in-guest
# CLI consumer uses (configurations/fabro-vm/fabro.nix), pointed at
# svc:fabro's 443 advertisement. Without the file the CLI aborts ("Cannot
# reach Fabro server: no settings.toml configured") because fabro's
# default target is a Unix socket at $FABRO_HOME/fabro.sock and the mac
# has no local server anymore.
#
# FABRO_HOME is the only path fabro resolves (verified with the nightly
# 0.382.0 binary: a populated $XDG_CONFIG_HOME is ignored outright), so
# it is exported under the XDG config tree — everything fabro writes
# (auth.json, logs, tmp, local storage) relocates to
# $XDG_CONFIG_HOME/.fabro with it. Authentication stays imperative on
# purpose: tokens are session-bound and per-user state, so the one-time
# login command is
#   fabro auth login --server https://fabro.tuxedo-musical.ts.net/api/v1 \
#     --dev-token <op://Private/Fabro/Dev Token>
# which writes auth.json here.
{
  config,
  pkgs,
  ...
}:
let
  fabroHome = "${config.xdg.configHome}/.fabro";

  cliSettings = pkgs.writeText "fabro-cli-settings.toml" ''
    [cli.target]
    type = "http"
    url = "https://fabro.tuxedo-musical.ts.net/api/v1"
  '';
in
{
  # The CLI binary itself: the fabro package came from programs.fabro's
  # home.packages, and that module is disabled since the server moved to
  # the VM, so this module owns the install instead.
  home.packages = [ pkgs.fabro ];

  home.sessionVariables.FABRO_HOME = fabroHome;

  xdg.configFile.".fabro/settings.toml".source = cliSettings;
}
