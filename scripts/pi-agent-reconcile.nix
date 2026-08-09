{
  nodejs,
  pi-agent,
  writeShellApplication,
}:
writeShellApplication {
  name = "pi-agent-reconcile";
  runtimeInputs = [ nodejs ];
  text = ''
    export NODE_PATH=${pi-agent}/lib/node_modules
    exec node ${./pi-agent-reconcile.mjs} "$@"
  '';
}
