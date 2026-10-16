# Fabro API bridge: the loopback-only Fabro API exposed to workflow
# sandboxes on the podman bridge, without shipping a Fabro credential into
# any sandbox environment.
#
# The bridge binds the podman bridge gateway (10.88.0.1:32276 — reachable
# from containers as `host.docker.internal:32276`, which the sandbox driver
# already maps via `--add-host host.docker.internal:host-gateway`) and
# authorizes every request by container identity:
#
#   * the source address is resolved to the caller's sandbox container
#     through the podman API, and the container's `petri.run` label names
#     the calling run (container names `petri-<run-id>-<lease>` are the
#     fallback);
#   * the run's workflow slug must be in `allowedWorkflowSlugs` and the run
#     must be `running`;
#   * only four routes are forwarded — a dispatching run may create and
#     start children, list runs, and archive its own earlier successful
#     runs (`POST /api/v1/runs`, `POST /api/v1/runs/{id}/start`,
#     `POST /api/v1/runs/{id}/archive`, `GET /api/v1/runs`); nothing else;
#   * on create the bridge fills in `parent_id` with the calling run, and
#     refuses a conflicting parent, a target repository other than the
#     calling run's repository, or a workflow version that is not one of
#     the ids resolved from `allowedVersionVariables`;
#   * on start only children of the calling run pass, and a child that
#     lands in pre-execution approval is approved transparently before the
#     response is returned, so dispatch workflows never need approval
#     hooks or approve calls;
#   * on archive only previous runs of the calling workflow for the
#     calling run's repository that ended `succeeded` pass.
#
# The Fabro API itself keeps its loopback-only listener; the bridge holds
# the dev token (from the sops `fabro-env` template, like fabro.service)
# and only ever sends it on the loopback upstream call. Denials and
# allowed requests are logged to the journal.
#
# The firewall rule below is the one narrow exception in the guest: TCP
# 32276 from the podman bridge subnet to the bridge address. The service
# binds the bridge gateway rather than 0.0.0.0 — the address only exists
# once the podman network has been used, so the unit restart loop doubles
# as the bind-retry for a cold boot.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.fabro-api-bridge;

  bridgePackage = pkgs.rustPlatform.buildRustPackage {
    pname = "fabro-api-bridge";
    version = "0.1.0";
    src = lib.cleanSource ./api-bridge;
    cargoLock.lockFile = ./api-bridge/Cargo.lock;
    meta = {
      description = "Identity-aware bridge exposing the Fabro API to workflow sandboxes";
      mainProgram = "fabro-api-bridge";
    };
  };

  listenAddress = "10.88.0.1";
  listenPort = 32276;
  sandboxNetwork = "10.88.0.0/16";

  # ExecStartPost health gate (same contract as litellmHealthGate): the unit
  # only reaches "active" once /healthz answers, so "active" means the
  # listener is reachable and not merely that the process spawned.
  bridgeHealthGate = pkgs.writeShellApplication {
    name = "fabro-api-bridge-health-gate";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.curl
    ];
    text = ''
      attempts=15
      for (( i = 1; i <= attempts; i++ )); do
        if curl -fsS --connect-timeout 2 --max-time 4 -o /dev/null "http://${listenAddress}:${toString listenPort}/healthz"; then
          exit 0
        fi
        sleep 1
      done
      echo "fabro-api-bridge-health-gate: /healthz never returned 200" >&2
      exit 1
    '';
  };
in
{
  options.services.fabro-api-bridge = {
    enable = lib.mkEnableOption "the Fabro API bridge for workflow sandboxes";

    allowedWorkflowSlugs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "dispatch" ];
      description = ''
        Workflow slugs whose (running) runs may call the bridged Fabro API
        endpoints. Every other workflow's sandboxes are refused.
      '';
    };

    allowedVersionVariables = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "kiro_spec_workflow_version"
        "oneshot_workflow_version"
      ];
      description = ''
        Server variable names whose values are the only workflow-version
        ids the bridge will accept in a create request.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.fabro-api-bridge = {
      description = "Fabro API bridge for workflow sandboxes (podman bridge)";
      wantedBy = [ "multi-user.target" ];

      # podman.socket keeps the API access alive across activations; the
      # bridge only needs it per-request, but `requires` gives the unit a
      # clean restart when the container engine does.
      after = [ "podman.socket" ];
      requires = [ "podman.socket" ];

      serviceConfig = {
        ExecStart = lib.getExe bridgePackage;
        ExecStartPost = lib.getExe bridgeHealthGate;

        Environment = [
          "BRIDGE_LISTEN=${listenAddress}:${toString listenPort}"
          "FABRO_API_BASE=http://127.0.0.1:32276/api/v1"
          "PODMAN_SOCKET=/run/podman/podman.sock"
          "ALLOWED_WORKFLOW_SLUGS=${lib.concatStringsSep "," cfg.allowedWorkflowSlugs}"
          "ALLOWED_VERSION_VARIABLES=${lib.concatStringsSep "," cfg.allowedVersionVariables}"
        ];

        # FABRO_DEV_TOKEN, the same sops-rendered pair fabro.service loads;
        # systemd reads the file as root, so no harvester of the token sees
        # it in a store path or a world-readable file.
        EnvironmentFile = config.sops.templates."fabro-env".path;

        # Same identity as fabro.service (the state-share user that is in
        # the podman group); the bridge needs the podman socket and nothing
        # else that user owns.
        User = "brandonmcnama";
        SupplementaryGroups = [ "podman" ];

        Restart = "always";
        RestartSec = 2;

        # Mirror fabro.service's hardening; the bridge has no state, so
        # ReadWritePaths is unnecessary.
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

    # The firewall rule the bridge relies on: sandbox containers hold
    # 10.88.0.0/16 addresses on podman0 and one host-local destination
    # (the bridge) for TCP 32276. Everything else from the bridge stays
    # subject to nixos-fw's defaults.
    networking.firewall.extraCommands = ''
      iptables -w -A nixos-fw -p tcp -s ${sandboxNetwork} -d ${listenAddress} --dport ${toString listenPort} -j nixos-fw-accept
    '';
  };
}
