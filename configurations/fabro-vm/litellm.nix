# LiteLLM proxy on the fabro host: one loopback OpenAI-compatible gateway in
# front of the subscription-backed models (the mac's `programs.litellm`
# launchd agent, minus its Keychain machinery). Uses the upstream nixpkgs
# `services.litellm` module (DynamicUser, state dir, seeded tiktoken cache,
# writable-UI runtime dir).
#
# The served model list and the header-forwarding list are generated from
# `./litellm-catalog.nix`, the single source of the served logical ids: every
# deployment in the catalog becomes one `model_list` entry under a
# provider-free `model_name`, with an explicit deployment id and weight.
#
# Forwarding is group-scoped: a logical model is listed when any of its
# deployments' provider requires a client session header, and the same
# forwarding then applies to every sibling, so a unified group forwards the
# same headers to its ChatGPT deployment. LiteLLM strips `Authorization` and
# its special auth headers, then forwards only the documented allowlist —
# `x-*` except `x-stainless-*`, plus `anthropic-beta` (content-type and
# credentials stay behind). The OpenCode Go / Zen upstreams consume the
# forwarded `x-opencode-session` id, which fabro attaches at its provider
# level (`llm.providers.litellm.default_headers` in fabro.nix).
#
# ChatGPT deployments use the ChatGPT subscription (Codex backend; no API
# key — OAuth device flow). The proxy HELD its startup per ChatGPT
# deployment until a human completes the login flow. Provision once on the
# host mac (running `litellm-chatgpt-login` there) and copy the
# ~/.config/litellm credentials JSON into the VM's /var/lib/litellm (state
# dir persists across switches), then restart litellm.service.
# /v1/chat/completions is bridged to the Responses API upstream.
#
# Authentication: the proxy enforces a master key, supplied as the
# LITELLM_MASTER_KEY env var from the sops-nix `litellm-env` template
# (decrypted from secrets/fabro.fabro.yaml; the same env-var shape the
# mac launchd wrapper used — the config in the store carries no secret).
# Consumers present `Authorization: Bearer <master key>`; in the guest
# that value must also exist in fabro's server vault as LITELLM_API_KEY
# (`fabro secret set`, runs source it there). The template also exports
# OPENCODE_API_KEY for the `os.environ/OPENCODE_API_KEY` references in the
# catalog (the mac's providerKeys equivalent); like the mac, a missing/unset
# key fails the affected deployments per-request, not the proxy itself.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  # The served model ids and the header-forwarding list: the catalog is the
  # single source (one deployment per gateway entry).
  inherit (import ./litellm-catalog.nix { inherit lib; }) catalog;

  # The ChatGPT provider credentials: litellm's chatgpt authenticator
  # (llms/chatgpt/authenticator) resolves CHATGPT_TOKEN_DIR, falling back to
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

    environment = {
      CHATGPT_TOKEN_DIR = litellmTokenDir;

      # A DynamicUser unit gets no $HOME from systemd. litellm 1.86's
      # proxy_server imports prisma eagerly, and prisma's DefaultConfig
      # evaluates Path.home() at import time, so startup aborts without
      # one. The state dir is already WorkingDirectory, exists via
      # StateDirectory, and is untouched by ProtectHome.
      HOME = config.services.litellm.stateDir;
    };

    settings = {
      # Header forwarding: litellm strips client headers upstream by
      # default. Enabling forward_client_headers_to_llm_api per model group
      # sends the documented allowlist through for those groups only
      # (litellm/proxy/litellm_pre_call_utils.py's _get_forwardable_headers:
      # x-* except x-stainless-*, plus anthropic-beta, never Authorization
      # or content-type). The catalog lists a logical model when any of its
      # deployments' provider requires the client session header, so every
      # sibling — including the ChatGPT sibling of a unified group — gets the
      # same forwarding. OpenCode's Go/Zen gateways need the client's stable
      # x-opencode-session id on the upstream call — fabro attaches it
      # (llm.providers.litellm.default_headers in fabro.nix) and this is
      # what carries it the rest of the way.
      litellm_settings = {
        model_group_settings.forward_client_headers_to_llm_api = catalog.forwardClientHeaders;
      };

      # One entry per catalog deployment: a provider-free `model_name`, an
      # explicit `model_info.id` naming the deployment, and an explicit
      # `weight` for placement.
      model_list = catalog.modelList;

      # Placement: weighted `simple-shuffle` across the healthy deployments
      # of a logical model, so a new conversation is placed by weight and
      # deployment availability alone. `session_affinity` turns on the
      # router's pin, keyed by logical model and session identity (the
      # header or body key the session bridge resolves); the six-hour TTL is
      # an idle expiry refreshed by every routed request. Pins live in the
      # router's in-process cache, so a gateway restart — which also
      # restarts Fabro via its hard Requires — clears them and the next
      # request is a fresh placement. No `deployment_affinity`, `rpm`, or
      # `tpm` is declared: caller keys and request rates do not influence
      # placement.
      router_settings = {
        routing_strategy = "simple-shuffle";
        optional_pre_call_checks = [ "session_affinity" ];
        deployment_affinity_ttl_seconds = 21600;
      };
    };
  };

  # The login wrapper ships with the guest (invoked under sudo over SSH;
  # see the wrapper above).
  environment.systemPackages = [ litellmChatGptLogin ];
}
