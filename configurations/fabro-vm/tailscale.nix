# Tailscale on the fabro host: the guest joins the tailnet as an ephemeral,
# tagged node and advertises the five application services as Tailscale
# Services (`svc:fabro`, `svc:litellm`, `svc:opencode`, `svc:iii`, and
# `svc:iii-console`, defined in the admin console).
#
# Node registration uses the OAuth client credentials from the 1Password
# item `Fabro Host Tailscale Credentials`
# (op://Infrastructure/Fabro Host Tailscale Credentials). Per
# tailscale.com/kb/1215 ("Register new nodes using OAuth credentials") the
# client secret doubles as the auth key (`tskey-client-…`), and nodes
# registered this way are tag-owned, so:
#   * ephemeral=true releases the node from the tailnet shortly after it
#     disconnects, so recreating the guest does not accumulate stale node
#     records; the next boot re-registers it from this OAuth credential;
#   * preauthorized=true skips manual device approval;
#   * extraUpFlags passes `--advertise-tags=tag:fabro`, the tag granted to
#     this OAuth client.
# The tailscaled-autoconnect unit (created by nixpkgs' module whenever
# authKeyFile is set) drives registration: it re-runs `tailscale up` with
# the stored key only while the backend is logged out. It is a boot-time
# oneshot and treats any Running backend as healthy, so rotating the
# 1Password secret affects future registrations, not the live bond of an
# already-registered node.
#
# A long host sleep can outlast the ephemeral node's lifetime: on resume
# tailscaled may stay Running with a control-plane node that no longer
# exists (`404: node not found`) or wait for an interactive AuthURL, while
# the local serve handlers stay configured. The tailscale-reconcile timer
# checks the live status every two minutes and re-runs `tailscale up` with
# the OAuth key whenever the node is not online, an AuthURL is pending, or
# the backend needs login. It is a no-op while the node is healthy.
#
# The five services are advertised by the tailscale-serve oneshot, which
# runs once tailscaled-autoconnect completes (Type=notify means that unit
# returns only when the backend reaches Running). Each `tailscale serve
# --service` invocation sets the web handler (TLS terminated by tailscaled
# under the service's tailnet DNS name) and marks this node as a service
# host for the console-defined service. Every invocation is idempotent
# (same handler → same config; advertise-prefs is a no-op if already
# listed), so re-applying on every boot is the convergence mechanism. The
# engine handler is appended after the three original handlers, then the
# console handler, so a failing `svc:iii` or `svc:iii-console` invocation
# still leaves the earlier handlers applied, and the unit deliberately
# does not require iii.service: registration is the gate, so the engine and
# console stay loopback-only until the tailnet is up.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.tailscale;
  reconcile = pkgs.callPackage ../../scripts/fabro-tailscale-reconcile.nix { };
in
{
  services.tailscale = {
    enable = true;

    # The `tskey-client-…` OAuth secret from the 1Password item (the client
    # ID is embedded in the secret; see secrets/README.md, fabro store).
    # sops-nix lands it at /run/secrets before normal units start.
    authKeyFile = config.sops.secrets."tailscale-oauth-secret".path;

    authKeyParameters = {
      # OAuth credential registration defaults to ephemeral nodes. Keep it
      # explicit: a disconnected node is released from the tailnet, so a
      # recreated guest leaves no stale record, and the next boot
      # re-registers from this OAuth credential.
      ephemeral = true;

      # Skip manual device approval in the admin console.
      preauthorized = true;
    };

    # Nodes registered with OAuth credentials are tag-owned: the node must
    # join with a tag the OAuth client is authorized to grant.
    extraUpFlags = [ "--advertise-tags=tag:fabro" ];

    openFirewall = true;
  };

  systemd.services.tailscale-serve = {
    description = "Advertise the fabro, litellm, opencode, iii, and iii-console Tailscale Services";
    after = [
      "tailscaled.service"
      "tailscaled-autoconnect.service"
    ];
    requires = [ "tailscaled-autoconnect.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      Restart = "on-failure";
      RestartSec = 5;
      # Tailnet-facing ports: all five admin-console resource definitions
      # use tcp:443, so the services are reachable at
      # https://fabro.tuxedo-musical.ts.net/,
      # https://litellm.tuxedo-musical.ts.net/,
      # https://opencode.tuxedo-musical.ts.net/,
      # https://iii.tuxedo-musical.ts.net/, and
      # https://iii-console.tuxedo-musical.ts.net/ (no port suffix; TLS is
      # terminated by tailscaled under each service name). Tailnet clients
      # reach the engine over WebSocket at wss://iii.tuxedo-musical.ts.net/
      # and the console at https://iii-console.tuxedo-musical.ts.net/.
      # The loopback targets are the listeners from fabro.nix
      # (127.0.0.1:32276, API + web UI), litellm.nix (127.0.0.1:4000),
      # opencode.nix (127.0.0.1:4096), iii.nix (the loopback-only engine),
      # and iii-console.nix (the loopback-only ADE console). The `svc:iii`
      # entry follows the three original handlers and `svc:iii-console` is
      # last; while either Service is absent or not granted to tag:fabro the
      # invocation fails, journals its error, and the console stays
      # loopback-only.
      ExecStart = [
        "${lib.getExe cfg.package} serve --service=svc:fabro --https=443 http://127.0.0.1:32276"
        "${lib.getExe cfg.package} serve --service=svc:litellm --https=443 http://127.0.0.1:4000"
        "${lib.getExe cfg.package} serve --service=svc:opencode --https=443 http://127.0.0.1:4096"
        "${lib.getExe cfg.package} serve --service=svc:iii --https=443 http://127.0.0.1:49134"
        "${lib.getExe cfg.package} serve --service=svc:iii-console --https=443 http://127.0.0.1:3113"
      ];
    };
  };

  systemd.services.tailscale-reconcile = {
    description = "Reconcile the fabro guest's ephemeral Tailscale registration";
    after = [ "tailscaled.service" ];
    wants = [ "tailscaled.service" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = lib.escapeShellArgs [
        (lib.getExe reconcile)
        "--auth-key-file"
        config.sops.secrets."tailscale-oauth-secret".path
        "--tag"
        "tag:fabro"
        "--tailscale"
        (lib.getExe cfg.package)
      ];
    };
  };

  systemd.timers.tailscale-reconcile = {
    description = "Periodically reconcile the fabro guest's Tailscale registration";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "2min";
      OnUnitInactiveSec = "2min";
      AccuracySec = "30s";
      Unit = "tailscale-reconcile.service";
    };
  };
}
