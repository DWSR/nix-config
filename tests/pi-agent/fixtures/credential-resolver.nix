{
  fixture,
  repoRoot,
}:
let
  flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString repoRoot));
  pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
  inherit (pkgs) lib;

  policyPath = repoRoot + "/home-manager/common/pi-agent/credential-policy.nix";
  fakeDevx = pkgs.writeShellApplication {
    name = "devx";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      trace_file="''${PI_AGENT_TASK52_TRACE_FILE-}"
      pid_file="''${PI_AGENT_TASK52_PID_FILE-}"
      mode="''${PI_AGENT_TASK52_MODE-success}"

      if [[ -n "$trace_file" ]]; then
        printf '%s\t%s' "$$" "$#" >> "$trace_file"
        for argument in "$@"; do
          printf '\t%s' "$argument" >> "$trace_file"
        done
        printf '\n' >> "$trace_file"
      fi

      case "''${3-}" in
        --key) operation=token ;;
        --base) operation=base ;;
        *) exit 93 ;;
      esac

      record_processes() {
        (
          trap : TERM
          while true; do
            sleep 1
          done
        ) &
        descendant_pid=$!
        if [[ -n "$pid_file" ]]; then
          printf '%s %s\n' "$$" "$descendant_pid" >> "$pid_file"
        fi
      }

      if [[ "$mode" == "timeout-$operation" ]]; then
        record_processes
        trap : TERM
        while true; do
          sleep 1
        done
      fi

      if [[ "$mode" == "overflow-$operation" || "$mode" == "stderr-overflow-$operation" ]]; then
        record_processes
        for ((index = 0; index < 2048; index += 1)); do
          if [[ "$mode" == "stderr-overflow-$operation" ]]; then
            printf 'resolver-overflow-block-0123456789abcdef' >&2
          else
            printf 'resolver-overflow-block-0123456789abcdef'
          fi
        done
        while true; do
          sleep 1
        done
      fi

      if [[ "$mode" == "command-$operation" ]]; then
        printf '%s\n' "''${PI_AGENT_TASK52_STDERR_OUTPUT-}" >&2
        exit 42
      fi

      if [[ "$operation" == token ]]; then
        case "$mode" in
          empty-token) printf '\n' ;;
          multiline-token) printf '%s\nsecond-token-line\n' "''${PI_AGENT_TASK52_TOKEN_OUTPUT-}" ;;
          *) printf '%s\r\n' "''${PI_AGENT_TASK52_TOKEN_OUTPUT-}" ;;
        esac
      else
        case "$mode" in
          empty-base) printf '\n' ;;
          multiline-base) printf '%s\nsecond-base-line\n' "''${PI_AGENT_TASK52_BASE_OUTPUT-}" ;;
          *) printf '%s\r\n' "''${PI_AGENT_TASK52_BASE_OUTPUT-}" ;;
        esac
      fi
    '';
  };
  missingDevx = pkgs.runCommand "pi-agent-missing-devx" { } ''
    mkdir -p "$out/bin"
  '';
  personalSelection = {
    mode = "personal";
    defaultModel = {
      provider = "openai";
      modelId = "gpt-5.6-sol";
    };
  };
  shopifySelection = {
    mode = "shopify-gateway";
    enabledRoles = [
      "anthropic"
      "openai"
      "google"
      "groq"
      "xai"
    ];
    defaultModel = {
      provider = "openai";
      modelId = "gpt-5.6-sol";
    };
  };
  render =
    package: hostSelection:
    (import policyPath {
      inherit lib pkgs;
      trustedDevxOutPath = package.outPath;
    }).render
      { inherit hostSelection; };
  shopify = render fakeDevx shopifySelection;
  personal = render fakeDevx personalSelection;
  spawnFailure = render missingDevx shopifySelection;
  shopifyExecutionPlans = map (
    plan:
    let
      invocation = shopify.launcherInvocation plan;
    in
    {
      inherit (plan) kind;
      inherit (invocation) argv executable;
    }
  ) shopify.resolverPlans;
  tamperedExecutionPlans = map (
    executionPlan:
    if executionPlan.kind == "shopify-gateway-token" then
      executionPlan // { argv = [ "task-5-2-injected-contract-sentinel-70a8bd" ]; }
    else
      executionPlan
  ) shopifyExecutionPlans;
  tamperedExecutor = import (repoRoot + "/scripts/pi-agent-credential-resolver.nix") {
    inherit pkgs;
    credentialRuntimeModule = shopify.runtimeModule;
    executionPlanDigest = builtins.hashString "sha256" (builtins.toJSON shopifyExecutionPlans);
    executionPlans = tamperedExecutionPlans;
  };
  bundle =
    name: rendered: extraPaths:
    pkgs.symlinkJoin {
      inherit name;
      paths = [
        rendered.resolverExecutor
        rendered.runtimeModule
      ]
      ++ extraPaths;
    };

  fixtures = {
    executor-packages = pkgs.linkFarm "pi-agent-credential-resolver-fixtures" [
      {
        name = "shopify";
        path = bundle "pi-agent-shopify-credential-resolver" shopify [ fakeDevx ];
      }
      {
        name = "personal";
        path = bundle "pi-agent-personal-credential-resolver" personal [ fakeDevx ];
      }
      {
        name = "spawn-failure";
        path = bundle "pi-agent-spawn-failure-credential-resolver" spawnFailure [ missingDevx ];
      }
      {
        name = "tampered-artifact";
        path = pkgs.symlinkJoin {
          name = "pi-agent-tampered-credential-resolver";
          paths = [
            fakeDevx
            shopify.runtimeModule
            tamperedExecutor
          ];
        };
      }
    ];
  };
in
fixtures.${fixture} or (throw "unknown pi-agent credential-resolver fixture: ${fixture}")
