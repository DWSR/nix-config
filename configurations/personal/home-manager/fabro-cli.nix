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
# $XDG_CONFIG_HOME/.fabro with it.
#
# Authentication: the dev token is the bootstrap credential (the same
# 1Password pair the VM's sops template carries), while auth.json is
# session-bound runtime state that stays out of management. fabro-login
# bridges them: it resolves the token from the Keychain (provisioned at
# darwin-rebuild switch from op://Private/Fabro/Dev Token via
# home.mcp.keychainSecrets, scripts/mcp-secrets-activate.nix) and runs
# the one-time `fabro auth login` exchange against svc:fabro, writing
# auth.json into FABRO_HOME.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  fabroHome = "${config.xdg.configHome}/.fabro";
  fabroServerUrl = "https://fabro.tuxedo-musical.ts.net/api/v1";

  cliSettings = pkgs.writeText "fabro-cli-settings.toml" ''
    [cli.target]
    type = "http"
    url = "https://fabro.tuxedo-musical.ts.net/api/v1"
  '';

  # One-shot dev-token login helper (see the header): token from the
  # Keychain, exchange against the tailnet service, auth.json lands in
  # FABRO_HOME. The pre-flight /auth/me probe exists because `fabro auth
  # login` never contacts the server (observed on 0.382.0-nightly.0: no
  # login-relevant hit in the server journal), so a rotated token
  # otherwise "logs in" silently and every API call later 401s with
  # "Authentication required". Fails loudly when the Keychain entry is
  # absent or stale so the mismatch is surfaced at login time.
  fabroLogin = pkgs.writeShellApplication {
    name = "fabro-login";
    runtimeInputs = [ pkgs.curl ];
    text = ''
      set -eu

      server=${lib.escapeShellArg fabroServerUrl}
      keychain_path="$HOME/Library/Keychains/login.keychain-db"

      if ! dev_token="$(/usr/bin/security find-generic-password -s mcpproxy -a fabro-dev-token -w "$keychain_path" 2>/dev/null)" || [ -z "$dev_token" ]; then
        echo "ERROR: fabro-dev-token unavailable from the macOS Keychain; not logging in." >&2
        echo "  Provision it from op://Private/Fabro/Dev Token via" >&2
        echo "  home.mcp.keychainSecrets, then rerun the switch." >&2
        exit 1
      fi

      if ! curl -fsS --connect-timeout 2 --max-time 6 \
             -H "Authorization: Bearer $dev_token" \
             "$server/auth/me" > /dev/null; then
        echo "ERROR: the Keychain fabro-dev-token does not authenticate against $server." >&2
        echo "  It is likely stale (stale tokens also appear to \"log in\" silently" >&2
        echo "  — fabro auth login is offline-only). Refresh it from" >&2
        echo "  op://Private/Fabro/Dev Token (mcp-secrets-activate at switch time is" >&2
        echo "  the provisioning path) and rerun fabro-login." >&2
        exit 1
      fi

      exec ${pkgs.fabro}/bin/fabro auth login --server "$server" --dev-token "$dev_token"
    '';
  };
in
{
  # The CLI binary itself: the fabro package came from programs.fabro's
  # home.packages, and that module is disabled since the server moved to
  # the VM, so this module owns the install instead.
  home.packages = [
    pkgs.fabro
    fabroLogin
  ];

  home.sessionVariables.FABRO_HOME = fabroHome;

  xdg.configFile.".fabro/settings.toml".source = cliSettings;
}
