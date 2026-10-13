# mcpproxy on the fabro host: the Smart MCP Proxy daemon (the same
# four-tool aggregated gateway the mac's opencode session reaches at
# 127.0.0.1:8080) that would serve a loopback MCP endpoint for the
# fabro server's agent sessions.
#
# STATUS: the service is DISABLED — the unit is defined but has no
# `wantedBy`, so nothing starts it at boot, and no run/agent pointing
# references it (the [run.agent.mcps.mcpproxy] entry in fabro.nix and
# the fabro after/wants coupling were removed). Kept dormant rather
# than deleted so the wiring can be re-enabled without rebuilding the
# starting design. To reactivate: restore `wantedBy =
# [ "multi-user.target" ]` below and the fabro.nix pointing (see the
# comment on `run` there for the exact settings shape).
#
# Posture mirrors litellm.nix: loopback-only listener, no auth token.
# Management endpoints (Web UI, upstream add/remove) are therefore only
# reachable inside the guest (SSH), and the daemon is NOT advertised as
# a Tailscale Service (tailscale.nix serves only fabro + litellm).
#
# The declarative config is a JSON seed (pkgs.formats.json) installed
# into the StateDirectory before every start, and the daemon runs
# pointed at the working copy: mcpproxy persists runtime mutations
# (Web UI / upstream management edits) into that file, so a
# `nixos-rebuild` switch overwrites it and declarative content wins —
# the same lifecycle fabro.nix applies to settings.toml.
#
# NO upstream MCP servers are seeded: the VM's gateway deliberately
# does not mirror the mac host's catalog (agentmemory, github, git-mcp,
# time, …) — the mac's entries lean on that host's keychain secrets and
# agentmemory daemon, and which upstreams a fabro run server should
# expose is a decision to make on the VM itself, not a port. Populate
# the VM's set when needed: either through the Web UI / `mcpproxy
# upstream` CLI over SSH (those entries persist in the working copy
# until the next switch reinstalls the seed) or by adding entries to
# `mcpServers` here with a pinned store-path command from the repo's
# mcp-servers overlay and the explicit `quarantined = false` approval
# that key carries (mcpproxy #937: without it a hand-written entry is
# indistinguishable from one that bypassed the trust-mode admission
# gate).
{
  lib,
  pkgs,
  ...
}:
let
  mcpproxyStateDir = "/var/lib/mcpproxy";

  # The seed config. Only the keys that deviate from mcpproxy's built-in
  # defaults are written (v0.67.0's Config struct largely carries the
  # right zero values); the environment block is the one exception —
  # spelled out to match what mcpproxy itself serialises as its default
  # env-filtering contract for spawned stdio upstreams.
  mcpproxyConfig = (pkgs.formats.json { }).generate "mcpproxy-config.json" {
    listen = "127.0.0.1:8080";
    enable_socket = true;
    data_dir = mcpproxyStateDir;

    # The four-tool surface the mac deployment uses (retrieve_tools +
    # call_tool_read/write/destructive), with the mac's limits. The
    # upstream catalog is intentionally empty — see the header comment
    # (the mac's set is not mirrored; populate the VM's own later).
    mcpServers = [ ];

    tools_limit = 15;
    tool_response_limit = 20000;
    call_tool_timeout = "2m";

    # Code execution is the opt-in JS orchestration tool; the mac keeps
    # it off, so the gateway stays the four-tool surface.
    enable_code_execution = false;

    environment = {
      inherit_system_safe = true;
      allowed_system_vars = [
        "PATH"
        "HOME"
        "TMPDIR"
        "TEMP"
        "TMP"
        "SHELL"
        "TERM"
        "LANG"
        "USER"
        "USERNAME"
        "XDG_CONFIG_HOME"
        "XDG_DATA_HOME"
        "XDG_CACHE_HOME"
        "XDG_RUNTIME_DIR"
        "LC_ALL"
        "LC_CTYPE"
        "LC_NUMERIC"
        "LC_TIME"
        "LC_COLLATE"
        "LC_MONETARY"
        "LC_MESSAGES"
        "LC_PAPER"
        "LC_NAME"
        "LC_ADDRESS"
        "LC_TELEPHONE"
        "LC_MEASUREMENT"
        "LC_IDENTIFICATION"
      ];
      custom_vars = { };
      enhance_path = false;
    };
  };

  # ExecStartPost health gate (same contract as fabro.nix's
  # fabroHealthGate and litellm.nix's litellmHealthGate): poll the
  # unauthenticated /healthz liveness endpoint so "active" means the
  # loopback HTTP listener answers, not just that the daemon spawned.
  mcpproxyHealthGate = pkgs.writeShellApplication {
    name = "mcpproxy-health-gate";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.curl
    ];
    text = ''
      attempts=30
      for (( i = 1; i <= attempts; i++ )); do
        if curl -fsS --connect-timeout 2 --max-time 4 -o /dev/null 'http://127.0.0.1:8080/healthz'; then
          exit 0
        fi
        echo "mcpproxy-health-gate: probe $i/$attempts failed, retrying" >&2
        sleep 2
      done
      echo "mcpproxy-health-gate: /healthz never returned 200" >&2
      exit 1
    '';
  };
in
{
  systemd.services.mcpproxy = {
    description = "mcpproxy MCP gateway (loopback four-tool surface for fabro agents)";

    # Deliberately DISABLED (see the header comment): the missing
    # `wantedBy` leaves the unit defined but not enabled, so nothing
    # starts it at boot or via dependencies. Reactivating the
    # integration is `wantedBy = [ "multi-user.target" ]` plus the
    # fabro.nix pointing comment's settings entry.
    after = [ "network.target" ];
    # Restart on switch when the seed config's store path changes.
    restartTriggers = [ mcpproxyConfig ];

    environment.HOME = mcpproxyStateDir;

    serviceConfig = {
      # Overwrite the working config copy with the declarative seed
      # before every start (runtime edits win until the next start —
      # see the header comment).
      ExecStartPre = "${pkgs.coreutils}/bin/install -m 0600 -T ${mcpproxyConfig} ${mcpproxyStateDir}/mcp_config.json";
      ExecStart = "${lib.getExe pkgs.mcpproxy-go} serve --config ${mcpproxyStateDir}/mcp_config.json --data-dir ${mcpproxyStateDir}";
      ExecStartPost = lib.getExe mcpproxyHealthGate;
      StateDirectory = "mcpproxy";
      DynamicUser = true;
      Restart = "on-failure";
      RestartSec = 5;
      NoNewPrivileges = true;
      PrivateTmp = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      ProtectKernelLogs = true;
      ProtectKernelModules = true;
      ProtectKernelTunables = true;
      RestrictAddressFamilies = [
        "AF_UNIX"
        "AF_INET"
        "AF_INET6"
      ];
    };
  };

  # The CLI (mcpproxy status / upstream / doctor, …) reaches the
  # daemon's REST/socket endpoints; installing it makes guest-side
  # operator maintenance over SSH work without nix-store spelunking.
  environment.systemPackages = [ pkgs.mcpproxy-go ];
}
