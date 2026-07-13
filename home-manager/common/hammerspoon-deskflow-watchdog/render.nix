{ trustedSnapshotHelper }:
{
  role,
  snapshotCommand,
}:
let
  validatedRole =
    if builtins.isString role && role == "client" then
      "client"
    else if builtins.isString role && role == "server" then
      "server"
    else
      throw "hammerspoon-deskflow-watchdog render: role must be \"client\" or \"server\".";

  expectedCommand = "${trustedSnapshotHelper}/bin/deskflow-process-snapshot";
  snapshotCommandContext =
    if builtins.isString snapshotCommand then builtins.getContext snapshotCommand else { };
  snapshotCommandOk =
    if
      builtins.isString snapshotCommand
      &&
        builtins.unsafeDiscardStringContext snapshotCommand
        == builtins.unsafeDiscardStringContext expectedCommand
      && snapshotCommandContext == builtins.getContext expectedCommand
    then
      true
    else
      throw "hammerspoon-deskflow-watchdog render: snapshotCommand must exactly match the trusted snapshot helper executable.";

  indent = source: "    " + builtins.replaceStrings [ "\n" ] [ "\n    " ] source;
  model = indent (builtins.readFile ./model.lua);
  runtime = indent (builtins.readFile ./runtime.lua);
in
builtins.seq snapshotCommandOk ''
  -- deskflow-hammerspoon-watchdog:render-v1
  do
    local role = ${builtins.toJSON validatedRole}
    local snapshotCommand = ${builtins.toJSON snapshotCommand}
    local Model = (function()
  ${model}end)()
    local Runtime = (function()
  ${runtime}end)()
    Runtime.start(Model, role, snapshotCommand)
  end
''
