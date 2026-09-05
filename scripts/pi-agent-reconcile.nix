{
  nodejs,
  pi-agent,
  runCommand,
  symlinkJoin,
  writeShellApplication,
}:
let
  module = runCommand "pi-agent-reconcile-module" { } ''
    mkdir -p "$out/lib/pi-agent" "$out/lib/node_modules"
    cp ${./pi-agent-reconcile.mjs} "$out/lib/pi-agent/reconcile.mjs"
    ln -s ${pi-agent}/lib/node_modules/proper-lockfile "$out/lib/node_modules/proper-lockfile"
  '';
  command = writeShellApplication {
    name = "pi-agent-reconcile";
    runtimeInputs = [ nodejs ];
    text = ''
      export NODE_PATH=${pi-agent}/lib/node_modules
      exec node ${module}/lib/pi-agent/reconcile.mjs "$@"
    '';
  };
in
symlinkJoin {
  name = "pi-agent-reconcile";
  paths = [
    command
    module
  ];
}
