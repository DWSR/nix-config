# Tailscale on the fabro host: the guest joins the tailnet as a persistent
# tagged node and advertises the four application services as Tailscale
# Services (`svc:fabro`, `svc:litellm`, `svc:opencode`, and `svc:iii`,
# defined in the admin console).
#
# Node registration uses the OAuth client credentials from the 1Password
# item `Fabro Host Tailscale Credentials`
# (op://Infrastructure/Fabro Host Tailscale Credentials). Per
# tailscale.com/kb/1215 ("Register new nodes using OAuth credentials") the
# client secret doubles as the auth key (`tskey-client-…`), and nodes
# registered this way are tag-owned, so:
#   * ephemeral (the OAuth-parameter default) is overridden to false — an
#     ephemeral node would vanish between reboots;
#   * preauthorized=true skips manual device approval;
#   * extraUpFlags passes `--advertise-tags=tag:fabro`, the tag granted to
#     this OAuth client.
# The tailscaled-autoconnect unit (created by nixpkgs' module whenever
# authKeyFile is set) drives registration: it re-runs `tailscale up` with
# the stored key only while the backend is logged out, so rotating the
# 1Password secret affects future registrations, not the live bond of an
# already-registered node.
#
# The four services are advertised by the tailscale-serve oneshot, which
# runs once tailscaled-autoconnect completes (Type=notify means that unit
# returns only when the backend reaches Running). Each `tailscale serve
# --service` invocation sets the web handler (TLS terminated by tailscaled
# under the service's tailnet DNS name) and marks this node as a service
# host for the console-defined service. Every invocation is idempotent
# (same handler → same config; advertise-prefs is a no-op if already
# listed), so re-applying on every boot is the convergence mechanism. The
# engine handler is appended last, so a failing `svc:iii` invocation still
# leaves the three existing handlers applied, and the unit deliberately
# does not require iii.service: registration is the gate, so the engine
# stays loopback-only until the tailnet is up.
{
  config,
  lib,
  ...
}:
let
  cfg = config.services.tailscale;
in
{
  services.tailscale = {
    enable = true;

    # The `tskey-client-…` OAuth secret from the 1Password item (the client
    # ID is embedded in the secret; see secrets/README.md, fabro store).
    # sops-nix lands it at /run/secrets before normal units start.
    authKeyFile = config.sops.secrets."tailscale-oauth-secret".path;

    authKeyParameters = {
      # OAuth credential registration defaults to ephemeral nodes; this is
      # a persistent host.
      ephemeral = false;

      # Skip manual device approval in the admin console.
      preauthorized = true;
    };

    # Nodes registered with OAuth credentials are tag-owned: the node must
    # join with a tag the OAuth client is authorized to grant.
    extraUpFlags = [ "--advertise-tags=tag:fabro" ];

    openFirewall = true;
  };

  systemd.services.tailscale-serve = {
    description = "Advertise the fabro, litellm, opencode, and iii Tailscale Services";
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
      # Tailnet-facing ports: all four admin-console resource definitions
      # use tcp:443, so the services are reachable at
      # https://fabro.tuxedo-musical.ts.net/,
      # https://litellm.tuxedo-musical.ts.net/,
      # https://opencode.tuxedo-musical.ts.net/, and
      # https://iii.tuxedo-musical.ts.net/ (no port suffix; TLS is
      # terminated by tailscaled under each service name). Tailnet clients
      # reach the engine over WebSocket at wss://iii.tuxedo-musical.ts.net/.
      # The loopback targets are the listeners from fabro.nix
      # (127.0.0.1:32276, API + web UI), litellm.nix (127.0.0.1:4000),
      # opencode.nix (127.0.0.1:4096), and iii.nix (the loopback-only
      # engine). The `svc:iii` entry is last and adds no other exposure
      # path: while the Service is absent or not granted to tag:fabro the
      # invocation fails, journals its error, and the engine stays
      # loopback-only.
      ExecStart = [
        "${lib.getExe cfg.package} serve --service=svc:fabro --https=443 http://127.0.0.1:32276"
        "${lib.getExe cfg.package} serve --service=svc:litellm --https=443 http://127.0.0.1:4000"
        "${lib.getExe cfg.package} serve --service=svc:opencode --https=443 http://127.0.0.1:4096"
        "${lib.getExe cfg.package} serve --service=svc:iii --https=443 http://127.0.0.1:49134"
      ];
    };
  };
}
