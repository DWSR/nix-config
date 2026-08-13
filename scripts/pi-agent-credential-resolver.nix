{
  executionPlanDigest,
  credentialRuntimeModule,
  executionPlans,
  pkgs,
}:
let
  source =
    builtins.replaceStrings
      [
        "__PI_AGENT_CREDENTIAL_POLICY_MODULE__"
        "PI_AGENT_EXECUTION_PLAN_VALUES_PLACEHOLDER"
        "__PI_AGENT_EXECUTION_PLAN_DIGEST__"
      ]
      [
        "${credentialRuntimeModule}/lib/pi-agent/credential-policy.mjs"
        (builtins.toJSON executionPlans)
        executionPlanDigest
      ]
      (builtins.readFile ./pi-agent-credential-resolver.mjs);
in
pkgs.writeTextFile {
  name = "pi-agent-credential-resolver";
  destination = "/lib/pi-agent/credential-resolver.mjs";
  text = source;
}
