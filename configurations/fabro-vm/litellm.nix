# LiteLLM proxy on the fabro host: one loopback OpenAI-compatible gateway in
# front of the subscription-backed models (the mac's `programs.litellm`
# launchd agent, minus its Keychain machinery). Uses the upstream nixpkgs
# `services.litellm` module (DynamicUser, state dir, seeded tiktoken cache,
# writable-UI runtime dir).
#
#   chatgpt/<model>      ChatGPT subscription (Codex backend; no API key —
#                        OAuth device flow). The proxy HELD its startup per
#                        chatgpt/ deployment until a human completes the
#                        login flow. Provision once on the host mac (running
#                        `litellm-chatgpt-login` there) and copy the
#                        ~/.config/litellm credentials JSON into the VM's
#                        /var/lib/litellm (state dir persists across
#                        switches), then restart litellm.service.
#                        /v1/chat/completions is bridged to the Responses
#                        API upstream.
#   opencode-go/<model>  OpenCode Go subscription; one API key also steers
#                        the Zen balance fallback. gpt/grok model ids go to
#                        {api_base}/responses, the GLM/Kimi/DeepSeek/MiMo
#                        ids to /chat/completions.
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
# a missing/unset key fails the opencode-* deployments per-request, not
# the proxy itself.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  # The `chatgpt/*` provider credentials: litellm's chatgpt authenticator
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
in
{
  services.litellm = {
    enable = true;
    host = "127.0.0.1";
    port = 4000;

    # LITELLM_MASTER_KEY from the sops template (see default.nix).
    environmentFile = config.sops.templates."litellm-env".path;

    environment.CHATGPT_TOKEN_DIR = litellmTokenDir;

    settings =
      let
        # litellm 1.86's per-provider param allowlists predate the model ids
        # served here (gpt-6*, glm, longcat), so `reasoning_effort` — both a
        # consumer's request value and each deployment's pinned default —
        # fails the proxy's UnsupportedParamsError gate before reaching
        # upstream. Merging this in re-permits the param per deployment; the
        # chat→responses bridge then maps it to `reasoning.effort` for the
        # Codex/OpenCode-Go upstreams.
        reasoningEffortAllowed = {
          allowed_openai_params = [ "reasoning_effort" ];
        };
      in
      {
        model_list =
          # OpenAI subscription (ChatGPT Work/Codex backend, chatgpt/ OAuth
          # device flow). Reasoning effort is pinned per deployment so the
          # effort travels with the model id; duplicated
          # litellm_params.model entries are fine because model names are
          # distinct (same named upstream model + different default params
          # load-balances instead of pinning).
          [
            {
              model_name = "chatgpt/gpt-6-luna";
              model_info.mode = "responses";
              litellm_params = {
                model = "chatgpt/gpt-6-luna";
                reasoning_effort = "xhigh";
              }
              // reasoningEffortAllowed;
            }
            {
              model_name = "chatgpt/gpt-6-luna-none";
              model_info.mode = "responses";
              litellm_params = {
                model = "chatgpt/gpt-6-luna";
                reasoning_effort = "none";
              }
              // reasoningEffortAllowed;
            }
            {
              model_name = "chatgpt/gpt-6-astra";
              model_info.mode = "responses";
              litellm_params = {
                model = "chatgpt/gpt-6-astra";
                reasoning_effort = "xhigh";
              }
              // reasoningEffortAllowed;
            }
            {
              model_name = "chatgpt/gpt-6.1-sol";
              model_info.mode = "responses";
              litellm_params = {
                model = "chatgpt/gpt-6.1-sol";
                reasoning_effort = "xhigh";
              }
              // reasoningEffortAllowed;
            }
          ]
          # OpenCode Go Responses-API wire models.
          ++ (map (m: {
            model_name = "opencode-go/${m}";
            model_info.mode = "responses";
            litellm_params = {
              model = "openai/${m}";
              api_base = "https://opencode.ai/zen/go/v1";
              api_key = "os.environ/OPENCODE_API_KEY";
            }
            // reasoningEffortAllowed;
          }) [ "gpt-6-luna" ])
          # OpenCode Go chat/completions wire models.
          ++ (map
            (m: {
              model_name = "opencode-go/${m}";
              model_info.mode = "chat";
              litellm_params = {
                model = "openai/${m}";
                api_base = "https://opencode.ai/zen/go/v1";
                api_key = "os.environ/OPENCODE_API_KEY";
              }
              // reasoningEffortAllowed;
            })
            [
              "glm-5.3-flash"
              "longcat-2.5-preview-free"
            ]
          )
          # Big Pickle is not part of the Go catalog (opencode.ai/docs/go):
          # the stealth model serves on the Zen balance endpoint, which the
          # OpenCode API key reaches unchanged (usage draws from the balance
          # behind the Go subscription).
          ++ [
            {
              model_name = "opencode-zen/big-pickle";
              model_info.mode = "chat";
              litellm_params = {
                model = "openai/big-pickle";
                api_base = "https://opencode.ai/zen/v1";
                api_key = "os.environ/OPENCODE_API_KEY";
              }
              // reasoningEffortAllowed;
            }
          ];
      };
  };

  # The login wrapper ships with the guest (invoked under sudo over SSH;
  # see the wrapper above).
  environment.systemPackages = [ litellmChatGptLogin ];
}
