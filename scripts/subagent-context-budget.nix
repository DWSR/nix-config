{ writeShellApplication, nodejs }:
writeShellApplication {
  name = "subagent-context-budget";
  runtimeInputs = [ nodejs ];
  text = ''
    exec node ${./subagent-context-budget.js} "$@"
  '';
}
