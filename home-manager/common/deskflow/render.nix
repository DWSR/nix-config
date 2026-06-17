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

  # serverConfig: the external screen-layout file in Deskflow's textual
  # server-config grammar (classic Synergy format) -- `section: <name>` blocks
  # each terminated by `end`. Screens render before aliases and links so every
  # screen name is defined before a link/alias references it (design.md
  # "Server layout text"). Non-null only for the server role.
  serverScreenNames = map (screen: screen.name) cfg.server.screens;

  # Per-screen option lines (indented two tabs), emitted only when set: the
  # half-duplex toggles and modifier remaps from the screen submodule. `or`
  # keeps the renderer total for a screen carrying only a name (e.g. fixtures).
  screenOptionLines =
    screen:
    let
      halfDuplex = screen.halfDuplex or { };
    in
    (lib.optional (halfDuplex.CapsLock or false) "\t\thalfDuplexCapsLock = true")
    ++ (lib.optional (halfDuplex.NumLock or false) "\t\thalfDuplexNumLock = true")
    ++ (lib.optional (halfDuplex.ScrollLock or false) "\t\thalfDuplexScrollLock = true")
    ++ (lib.mapAttrsToList (from: to: "\t\t${from} = ${to}") (screen.modifierRemap or { }));

  # `section: screens` -- each screen as an indented `name:` line plus its
  # option lines. Always present (the server role requires at least one screen).
  screensSection = [
    "section: screens"
  ]
  ++ lib.concatMap (screen: [ "\t${screen.name}:" ] ++ screenOptionLines screen) cfg.server.screens
  ++ [ "end" ];

  # `section: aliases` -- maps a defined screen (the key) to its alternate
  # names; emitted only when at least one alias is declared. The alias values
  # are new alternate names, not screens, so they are not validated as screens.
  aliasesSection = lib.optionals (cfg.server.aliases != { }) (
    [ "section: aliases" ]
    ++ lib.concatLists (
      lib.mapAttrsToList (
        screen: aliases: [ "\t${screen}:" ] ++ map (alias: "\t\t${alias}") aliases
      ) cfg.server.aliases
    )
    ++ [ "end" ]
  );

  # `section: links` -- adjacency edges grouped by source screen, ordered by
  # screen declaration order for deterministic output. Each edge renders as
  # `<direction>[(range)] = <to>[(range)]`; ranges are optional `(a,b)` spans.
  renderRange = range: if range == null then "" else "(${range})";
  linkLine =
    link: "\t\t${link.direction}${renderRange link.fromRange} = ${link.to}${renderRange link.toRange}";
  linksSection = [
    "section: links"
  ]
  ++ lib.concatMap (
    screenName:
    let
      outbound = lib.filter (link: link.from == screenName) cfg.server.links;
    in
    lib.optionals (outbound != [ ]) ([ "\t${screenName}:" ] ++ map linkLine outbound)
  ) serverScreenNames
  ++ [ "end" ];

  # `section: options` -- global server options as `name = value` lines;
  # emitted only when at least one option is declared.
  optionsSection = lib.optionals (cfg.server.options != { }) (
    [ "section: options" ]
    ++ lib.mapAttrsToList (key: value: "\t${key} = ${value}") cfg.server.options
    ++ [ "end" ]
  );

  serverLayout =
    lib.concatStringsSep "\n" (screensSection ++ aliasesSection ++ linksSection ++ optionsSection)
    + "\n";

  # A server role must define at least one screen (design.md "Error Handling",
  # Req 4.4). Names the layout option so the abort message is actionable.
  screensOk =
    lib.assertMsg (cfg.server.screens != [ ])
      "home.deskflow.server.screens must define at least one screen when home.deskflow.role is \"server\".";

  # Every link endpoint and alias key must name a defined screen (Req 4.5). The
  # message is forced only when refsOk fails (danglingRefs non-empty), so
  # `builtins.head` is safe.
  screenRefs =
    lib.concatMap (link: [
      {
        source = "links";
        name = link.from;
      }
      {
        source = "links";
        name = link.to;
      }
    ]) cfg.server.links
    ++ map (screen: {
      source = "aliases";
      name = screen;
    }) (builtins.attrNames cfg.server.aliases);
  danglingRefs = lib.filter (ref: !(builtins.elem ref.name serverScreenNames)) screenRefs;
  refsOk = lib.assertMsg (danglingRefs == [ ]) (
    let
      first = builtins.head danglingRefs;
    in
    "home.deskflow.server.${first.source} references undefined screen \"${first.name}\"; define it in home.deskflow.server.screens or correct the reference."
  );

  # Postcondition: serverConfig is non-null iff role == "server". The asserts
  # gate the rendered text (screens first so an empty-screens server names the
  # layout option rather than a dangling reference).
  serverConfig =
    if cfg.role != "server" then null else lib.seq screensOk (lib.seq refsOk serverLayout);

  # Structural validation lives in the renderer (not the options schema) so a
  # malformed snapshot is rejected by `nix eval`/a flake check without a host
  # switch (design.md "Error Handling": `enable && role == null`). An enabled
  # module must select a role.
  roleOk = lib.assertMsg (
    cfg.enable -> cfg.role != null
  ) "home.deskflow.role must be set to \"client\" or \"server\" when home.deskflow.enable is true.";
in
lib.seq roleOk {
  inherit settings serverConfig;
  # trustText is implemented by task 1.3; the key is present here so the
  # contract shape stays stable for callers.
  trustText = null;
}
