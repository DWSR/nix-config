# LiteLLM proxy on the fabro host: one loopback OpenAI-compatible gateway in
# front of the subscription-backed models (the mac's `programs.litellm`
# launchd agent, minus its Keychain machinery). Uses the upstream nixpkgs
# `services.litellm` module (DynamicUser, state dir, seeded tiktoken cache,
# writable-UI runtime dir).
#
# Model composition is data, not code: `./litellm-catalog.nix` is the single
# source of the served client-callable ids. `model_list` below is the catalog's
# gateway projection (one entry per deployment, named by the provider-agnostic
# logical id), and the forwarding list is the catalog's logical ids whose
# deployments include a provider that requires a client session header. Because
# forwarding is scoped to the whole unified model group, every deployment of a
# group carries the client's x-* headers uniformly; no rule here matches on a
# provider prefix. Adding a provider, model, or weight is a catalog entry,
# never an edit to this module.
#
# The ChatGPT subscription deployment (Codex backend; no API key — OAuth
# device flow) HOLDS proxy startup until a human completes the login flow.
# Provision once on the host mac (running `litellm-chatgpt-login` there) and
# copy the ~/.config/litellm credentials JSON into the VM's /var/lib/litellm
# (state dir persists across switches), then restart litellm.service.
# /v1/chat/completions is bridged to the Responses API upstream.
#
# OpenCode's upstreams require a stable x-opencode-session header. Fabro
# attaches it at its provider level; the group-scoped forwarding list carries
# it upstream for every deployment of a group that needs it.
#
# Authentication: the proxy enforces a master key, supplied as the
# LITELLM_MASTER_KEY env var from the sops-nix `litellm-env` template
# (decrypted from secrets/fabro.fabro.yaml; the same env-var shape the
# mac launchd wrapper used — the config in the store carries no secret).
# Consumers present `Authorization: Bearer <master key>`; in the guest
# that value must also exist in fabro's server vault as LITELLM_API_KEY
# (`fabro secret set`, runs source it there). The template also exports
# OPENCODE_API_KEY for the `os.environ/OPENCODE_API_KEY` provider
# references above (the mac's providerKeys equivalent); like the mac,
# a missing/unset key fails the OpenCode deployments per-request, not
# the proxy itself.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  # The validated model catalog: the sole source of served client-callable
  # ids, the gateway `model_list`, and the group-scoped forwarding list.
  catalog = (import ./litellm-catalog.nix { inherit lib; }).catalog;

  # Failover bound derived from the catalog: one sibling attempt per other
  # deployment of the largest unified group (currently `gpt-6-luna` with two
  # deployments, so 1). Every retry therefore stays inside the requested
  # logical model; adding a third deployment to that group widens the bound to
  # 2 without any other edit. Validation keeps every group non-empty, so the
  # subtraction never underflows below zero in practice.
  maxFallbacks = lib.foldl' (
    acc: logicalModel: lib.max acc (builtins.length logicalModel.deployments - 1)
  ) 0 (builtins.attrValues catalog.logicalModels);

  # The ChatGPT provider credentials: litellm's ChatGPT authenticator
  # (llms.chatgpt.authenticator) resolves CHATGPT_TOKEN_DIR, falling back to
  # `~/.config/litellm/chatgpt`. The DynamicUser unit has no HOME, so both
  # the unit and this login wrapper pin the path inside the state dir; the
  # service reads and refreshes auth.json in place under the same path.
  litellmTokenDir = "${config.services.litellm.stateDir}/chatgpt";

  # Device-flow login for the ChatGPT providers (the mac's
  # `programs.litellm.litellmChatGptLogin` wrapper, pointed at the guest's
  # token dir). Prints a verification URL + code, waits for the human to
  # approve it, then writes auth.json under CHATGPT_TOKEN_DIR. Runs under
  # sudo, so the credentials and token dir are handed to the DynamicUser
  # proxy (numeric owner of the state dir) afterwards.
  litellmChatGptLogin = pkgs.writeShellApplication {
    name = "litellm-chatgpt-login";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      export CHATGPT_TOKEN_DIR=${lib.escapeShellArg litellmTokenDir}

      # Device flow: prints the verification URL + code and waits for the
      # human to approve it, then writes auth.json under CHATGPT_TOKEN_DIR.
      ${
        (pkgs.python3.withPackages (pythonPackages: [ pythonPackages.litellm ])).interpreter
      } -c 'from litellm.llms.chatgpt.authenticator import Authenticator; Authenticator().get_access_token()'

      # Hand the credentials to the DynamicUser proxy (the service reads
      # and refreshes auth.json in place): copy the state dir's numeric
      # owner onto the token dir tree.
      chown -R --reference=${config.services.litellm.stateDir} "${litellmTokenDir}"
    '';
  };

  # ExecStartPost health gate: poll the proxy's own liveness endpoint so
  # the unit only reaches "active (started)" once the HTTP listener is
  # actually answering. Without it systemd counts the process spawn and a
  # hung-but-alive proxy looks started (and fabro would boot against a
  # dead router despite After/Requires ordering). A failing probe fails
  # the start job; the hard Requires=litellm.service then keeps fabro
  # down with it. Budget stays under the default 90s start timeout.
  litellmHealthGate = pkgs.writeShellApplication {
    name = "litellm-health-gate";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.curl
    ];
    text = ''
      attempts=30
      for (( i = 1; i <= attempts; i++ )); do
        if curl -fsS --connect-timeout 2 --max-time 4 -o /dev/null 'http://127.0.0.1:4000/health/liveliness'; then
          exit 0
        fi
        echo "litellm-health-gate: probe $i/$attempts failed, retrying" >&2
        sleep 2
      done
      echo "litellm-health-gate: /health/liveliness never returned 200" >&2
      exit 1
    '';
  };
in
{
  # The nixpkgs module only does spec-setups in ExecStartPre (tiktoken
  # cache seed + UI dir chmod); the health gate lands here as a plain
  # serviceConfig entry since the module exposes no readiness option.
  systemd.services.litellm.serviceConfig.ExecStartPost = lib.getExe litellmHealthGate;

  services.litellm = {
    enable = true;
    host = "127.0.0.1";
    port = 4000;

    # LITELLM_MASTER_KEY from the sops template (see default.nix).
    environmentFile = config.sops.templates."litellm-env".path;

    environment.CHATGPT_TOKEN_DIR = litellmTokenDir;

    # Gateway projections, derived only from the catalog: one `model_list`
    # entry per deployment, named by the provider-agnostic logical id, and one
    # forwarding entry per logical model whose group needs client headers.
    # litellm strips client headers upstream by default; the forwarding list
    # sends the documented x-* allowlist through for those groups only (never
    # Authorization/Content-Type), uniformly for every deployment of the group.
    settings = {
      litellm_settings = {
        model_group_settings.forward_client_headers_to_llm_api = catalog.forwardClientHeaders;
      };

      model_list = catalog.modelList;

      # Router policy: weighted random placement over the healthy deployments
      # of the requested logical group, plus native session affinity. The
      # weights live on the catalog's `model_list` entries; the only other
      # placement input is the router's own availability state. No rpm/tpm (or
      # any other rate) limit is set here, so a new placement is a weighted
      # choice among the deployments that are not cooling down.
      #
      # `optional_pre_call_checks` turns on the router's `session_affinity`
      # check: after a placement it records the selected deployment under
      # (logical model, session identity) in its in-process cache, and later
      # requests for the same pair reuse that deployment until the pin has been
      # idle for `deployment_affinity_ttl_seconds` (six hours). The alternative
      # `deployment_affinity` check stays off. Pins are per-process memory (no
      # Redis): a gateway restart clears every pin, and Fabro restarts with the
      # unit because it hard-requires litellm.service.
      #
      # Failover stays inside the requested group. `num_retries = 0` never
      # repeats an attempt on the same deployment; `enable_weighted_failover`
      # re-picks a healthy sibling by weight; `max_fallbacks` (derived above)
      # bounds the sibling attempts; and `allowed_fails = 0` with a 60-second
      # `cooldown_time` removes a failed deployment from placement and affinity
      # until it recovers. No `fallbacks`, `context_window_fallbacks`, or
      # `model_group_alias` is declared, so a request can never cross into
      # another logical model and a removed provider-scoped id fails as an
      # unknown model.
      router_settings = {
        routing_strategy = "simple-shuffle";
        num_retries = 0;
        max_fallbacks = maxFallbacks;
        enable_weighted_failover = true;
        allowed_fails = 0;
        cooldown_time = 60;
        optional_pre_call_checks = [ "session_affinity" ];
        deployment_affinity_ttl_seconds = 21600;
      };
    };
  };

  # The login wrapper ships with the guest (invoked under sudo over SSH;
  # see the wrapper above).
  environment.systemPackages = [ litellmChatGptLogin ];
}
