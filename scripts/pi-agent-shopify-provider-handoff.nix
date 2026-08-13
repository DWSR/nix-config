{
  managedConfig,
  managedConfigDigest,
  pkgs,
  projectionFactory,
  projectionFactoryDigest,
  reconcilerModule,
}:
let
  source =
    builtins.replaceStrings
      [
        "__PI_AGENT_MANAGED_CONFIG__"
        "__PI_AGENT_MANAGED_CONFIG_DIGEST__"
        "__PI_AGENT_PROJECTION_FACTORY__"
        "__PI_AGENT_PROJECTION_FACTORY_DIGEST__"
        "__PI_AGENT_RECONCILER_MODULE__"
      ]
      [
        (toString managedConfig)
        managedConfigDigest
        "${projectionFactory}/bin/pi-agent-provider-projection"
        projectionFactoryDigest
        (toString reconcilerModule)
      ]
      (builtins.readFile ./pi-agent-shopify-provider-handoff.mjs);
in
pkgs.writeTextFile {
  name = "pi-agent-shopify-provider-handoff";
  destination = "/lib/pi-agent/shopify-provider-handoff.mjs";
  text = source;
  passthru = {
    inherit managedConfigDigest projectionFactoryDigest;
  };
}
