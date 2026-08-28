# Pure renderer for the declarative Deskflow settings schema.
#
# Signature: `{ lib }: cfg: { settings; serverConfig; trustText; }`, where
#   cfg is the resolved `home.deskflow` options snapshot (see
#   deskflow/default.nix and design.md "Options schema (types)").
# Imported by deskflow/default.nix and the flake renderer checks as
#   `import ./render.nix { inherit lib; }`, then applied to `cfg`.
#
# Scope: renders all three outputs -- `settings` (the QSettings IniFormat text
# delivered to `~/Library/Deskflow/Deskflow.conf`), `serverConfig` (the external
# server layout, non-null only for the server role), and `trustText` (the
# trusted-peer file content, non-null only when fingerprints are provided).
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
    (kv "enableUpdateCheck" cfg.gui.enableUpdateCheck)
    (kv "closeReminder" cfg.gui.closeReminder)
    (kv "showGenericClientFailureDialog" cfg.gui.showGenericClientFailureDialog)
    (kv "shownFirstConnectedMessage" cfg.gui.shownFirstConnectedMessage)
    (kv "shownServerFirstStartMessage" cfg.gui.shownServerFirstStartMessage)
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

  # Trusted-peer fingerprints (Req 8.3-8.5). Each entry is normalized -- colons
  # stripped, lowercased -- then a 64-hex value renders `v2:sha256:<hex>` and a
  # 40-hex value renders `v2:sha1:<hex>`, one line per peer. Fingerprints are
  # public hashes (no secret material). The renderer builds only the trust-file
  # CONTENT; deskflow/default.nix (task 2.2) picks trusted-servers vs
  # trusted-clients by role.
  hexDigits = lib.stringToCharacters "0123456789abcdef";
  normalizeFingerprint = fp: builtins.replaceStrings [ ":" ] [ "" ] (lib.toLower fp);
  renderFingerprint =
    fp:
    let
      norm = normalizeFingerprint fp;
      algo = if builtins.stringLength norm == 64 then "sha256" else "sha1";
    in
    "v2:${algo}:${norm}";

  # A normalized entry must be exactly 64 hex (sha256) or 40 hex (sha1) chars,
  # where hex is [0-9a-f] after lowercasing (Req 8.4). Collect the offending
  # ORIGINAL entries so the abort names what the operator typed; the message is
  # forced only when the list is non-empty, so `builtins.head` is safe.
  invalidFingerprints = lib.filter (
    fp:
    let
      norm = normalizeFingerprint fp;
      len = builtins.stringLength norm;
    in
    !(
      (len == 64 || len == 40) && lib.all (ch: builtins.elem ch hexDigits) (lib.stringToCharacters norm)
    )
  ) cfg.tls.trustedFingerprints;
  fingerprintsOk = lib.assertMsg (invalidFingerprints == [ ]) (
    let
      first = builtins.head invalidFingerprints;
    in
    "home.deskflow.tls.trustedFingerprints entry \"${first}\" is not a valid SHA-256 (64 hex) or SHA-1 (40 hex) fingerprint."
  );

  # Postcondition: trustText is non-null iff trustedFingerprints != []. An empty
  # list leaves the trust file unmanaged (Req 8.5); a non-empty list is gated by
  # the validity assert (forced via lib.seq, mirroring serverConfig).
  trustText =
    if cfg.tls.trustedFingerprints == [ ] then
      null
    else
      lib.seq fingerprintsOk (
        lib.concatStringsSep "\n" (map renderFingerprint cfg.tls.trustedFingerprints) + "\n"
      );

  # Structural validation lives in the renderer (not the options schema) so a
  # malformed snapshot is rejected by `nix eval`/a flake check without a host
  # switch (design.md "Error Handling": `enable && role == null`). An enabled
  # module must select a role.
  roleOk = lib.assertMsg (
    cfg.enable -> cfg.role != null
  ) "home.deskflow.role must be set to \"client\" or \"server\" when home.deskflow.enable is true.";
in
lib.seq roleOk {
  inherit settings serverConfig trustText;
}
