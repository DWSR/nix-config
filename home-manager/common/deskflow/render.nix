# Pure renderer for the declarative Deskflow settings schema.
#
# Signature: `{ lib }: cfg: { settings; serverConfig; trustText; }`, where
#   cfg is the resolved `home.deskflow` options snapshot (see
#   deskflow/default.nix and design.md "Options schema (types)").
# Imported by deskflow/default.nix and the flake renderer checks as
#   `import ./render.nix { inherit lib; }`, then applied to `cfg`.
#
# Scope: task 1.1 fully implements `settings` -- the QSettings IniFormat text
# delivered to `~/Library/Deskflow/Deskflow.conf`. `serverConfig` (the external
# server layout) and `trustText` (the trusted-peer file) are placeholders
# returned as null here; tasks 1.2 and 1.3 implement them. All three keys are
# present so the returned contract shape stays stable for callers.
#
# Value rendering (QSettings IniFormat compatibility): string values are
# double-quoted -- an unquoted comma is parsed by QSettings as a QStringList,
# which would corrupt a comma-separated client/remoteHost. Bools render as
# true/false; ints and floats render bare (read back via toInt/toDouble).
# Section headers are `[group]`; the key/value separator is `=` (no spaces).
# Unset managed values are omitted structurally -- the renderer never emits an
# empty `key=` line.
{ lib }:
cfg:
let
  # Stringify a single value the way QSettings' IniFormat reads it back.
  renderValue =
    v:
    if builtins.isBool v then
      (if v then "true" else "false")
    else if builtins.isInt v then
      toString v
    else if builtins.isFloat v then
      toString v
    else if builtins.isString v then
      "\"" + v + "\""
    else
      throw "deskflow render: cannot render value of unsupported type (${builtins.typeOf v}).";

  # One `key=value` line, or null to omit the key entirely. The section builder
  # filters nulls, so an unset managed value never becomes an empty `key=` line.
  kv = key: value: if value == null then null else "${key}=${renderValue value}";

  # Assemble a `[section]` block from its lines, dropping omitted (null) lines.
  # Returns null when nothing remains so the empty section is filtered out whole.
  mkSection =
    name: lines:
    let
      kept = lib.filter (line: line != null) lines;
    in
    if kept == [ ] then null else "[${name}]\n" + lib.concatStringsSep "\n" kept;

  # log/level is stored as the integer index into this fixed severity order.
  logLevels = [
    "FATAL"
    "ERROR"
    "WARNING"
    "NOTE"
    "INFO"
    "DEBUG"
    "DEBUG1"
    "DEBUG2"
  ];
  logLevelIndex =
    level:
    let
      match = lib.findFirst (entry: entry.value == level) null (
        lib.imap0 (index: value: { inherit index value; }) logLevels
      );
    in
    if match == null then
      throw "deskflow render: unknown log level '${level}' (expected one of ${lib.concatStringsSep ", " logLevels})."
    else
      match.index;

  # core/coreMode: 1 = client, 2 = server. Reached only after roleOk has forced
  # a non-null role, so the else branch is always the server role.
  coreMode = if cfg.role == "client" then 1 else 2;

  coreLines = [
    (kv "coreMode" coreMode)
    (kv "computerName" cfg.computerName) # null -> omitted, Deskflow uses the hostname
    (kv "port" cfg.port)
  ];

  securityLines = [
    (kv "tlsEnabled" cfg.tls.enable)
    (kv "checkPeerFingerprints" cfg.tls.checkFingerprints)
    (kv "certificate" cfg.tls.certificateFile) # null -> omitted, Deskflow self-generates
    (kv "keySize" cfg.tls.keySize)
  ];

  logLines = [
    (kv "level" (logLevelIndex cfg.log.level))
    (kv "toFile" cfg.log.toFile)
    (kv "file" cfg.log.file) # null -> omitted
  ];

  guiLines = [
    (kv "startCoreWithGui" cfg.gui.startCoreWithGui)
    (kv "closeToTray" cfg.gui.closeToTray)
    (kv "autoHide" cfg.gui.autoHide)
  ];

  # client/remoteHost: when unset (""), omit the key and emit a commented
  # placeholder naming the option to set (QSettings ignores `;` lines on read),
  # so the rendered output stays valid (Req 3.3).
  remoteHostLine =
    if cfg.client.remoteHost == "" then
      "; TODO: set home.deskflow.client.remoteHost"
    else
      kv "remoteHost" cfg.client.remoteHost;

  clientLines = [
    remoteHostLine
    (kv "invertXScroll" cfg.client.invertScroll.x)
    (kv "invertYScroll" cfg.client.invertScroll.y)
    (kv "xScrollScale" cfg.client.scrollScale.x)
    (kv "yScrollScale" cfg.client.scrollScale.y)
    (kv "languageSync" cfg.client.languageSync)
  ];

  # server/externalConfigFile is the module-computed delivery path
  # (~/Library/Deskflow/deskflow-server.conf), supplied via
  # cfg.server.externalConfigFile and kept lock-step with the home.file path in
  # deskflow/default.nix. It is computed, not an operator-settable option.
  serverLines = [
    (kv "externalConfig" true)
    (kv "externalConfigFile" cfg.server.externalConfigFile)
  ];

  sectionBlocks = lib.filter (block: block != null) (
    [
      (mkSection "core" coreLines)
      (mkSection "security" securityLines)
      (mkSection "log" logLines)
      (mkSection "gui" guiLines)
    ]
    ++ lib.optional (cfg.role == "client") (mkSection "client" clientLines)
    ++ lib.optional (cfg.role == "server") (mkSection "server" serverLines)
  );

  settings = lib.concatStringsSep "\n\n" sectionBlocks + "\n";

  # Structural validation lives in the renderer (not the options schema) so a
  # malformed snapshot is rejected by `nix eval`/a flake check without a host
  # switch (design.md "Error Handling": `enable && role == null`). An enabled
  # module must select a role.
  roleOk = lib.assertMsg (
    cfg.enable -> cfg.role != null
  ) "home.deskflow.role must be set to \"client\" or \"server\" when home.deskflow.enable is true.";
in
lib.seq roleOk {
  inherit settings;
  # serverConfig and trustText are implemented by tasks 1.2 / 1.3; the keys are
  # present here so the contract shape is stable.
  serverConfig = null;
  trustText = null;
}
