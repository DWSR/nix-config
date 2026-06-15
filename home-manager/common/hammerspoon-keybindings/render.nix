# Pure Lua renderer for the declarative Hammerspoon keybinding schema.
#
# Signature: `{ lib }: cfg: string`, where
#   cfg = { keybindings, extraConfig, reloadOnConfigChange }.
# Imported by the syntax gate, the semantic check, and the renderer tests as
# `import ./render.nix { inherit lib; }`, then applied to `cfg`.
#
# Binding validation (duplicate hotkeys, action arity, key/modifier
# allowlists) runs at eval time below (Requirements 3.7-3.9): a malformed set
# `throw`s with a message naming the offending binding/hotkey before any Lua is
# emitted, so `nix eval` of the renderer surfaces failures without a host.
{ lib }:
cfg:
let
  # Turn an arbitrary string into a safe double-quoted Lua string literal.
  # Backslash is escaped FIRST so the escapes emitted for the other
  # characters are not themselves re-escaped.
  escapeLua =
    s:
    "\""
    + builtins.replaceStrings [ "\\" "\"" "\n" "\r" "\t" ] [ "\\\\" "\\\"" "\\n" "\\r" "\\t" ] s
    + "\"";

  # Collapse a (possibly multi-line) description into a single line so it can
  # ride safely inside a `--` Lua comment.
  toCommentLine = builtins.replaceStrings [ "\n" "\r" ] [ " " " " ];

  # Map a binding's single action to the Lua run inside the hotkey callback.
  # Exactly one field is non-null for valid input (enforced by checkBinding).
  renderAction =
    action:
    if action.command != null then
      "hs.execute(${escapeLua action.command}, true)"
    else if action.applescript != null then
      "hs.osascript.applescript(${escapeLua action.applescript})"
    else
      action.lua;

  # Render one binding as a global hotkey bind, optionally preceded by a
  # one-line comment carrying its description.
  renderBinding =
    binding:
    let
      modsTable = "{ ${lib.concatMapStringsSep ", " escapeLua binding.mods} }";
      descComment = lib.optionalString (
        binding.description != ""
      ) "-- ${toCommentLine binding.description}\n";
    in
    "${descComment}hs.hotkey.bind(${modsTable}, ${escapeLua binding.key}, function() ${renderAction binding.action} end)";

  accessibilityComment = ''
    -- Hammerspoon needs a one-time manual macOS Accessibility grant per host:
    -- System Settings > Privacy & Security > Accessibility > enable Hammerspoon.
    -- Until granted, the global keybindings below stay inert (Requirement 2.2).'';

  # Output order (per design Postconditions): disable Sparkle auto-update,
  # prompt for Accessibility, document the manual grant, then extraConfig,
  # then the binds, then the reload watcher when enabled.
  header = [
    "hs.automaticallyCheckForUpdates(false)"
    "hs.accessibilityState(true)"
    accessibilityComment
  ];

  # Watch the live config directory (`hs.configdir`) so a rebuild that swaps
  # the config reloads Hammerspoon with no hardcoded path.
  reloadWatcher = lib.optional cfg.reloadOnConfigChange "hs.pathwatcher.new(hs.configdir, hs.reload):start()";

  # --- Eval-time binding validation (fail-fast `throw`) --------------------
  # Lives in the pure renderer (not the options schema) so `nix eval` of the
  # renderer rejects malformed sets without a host. Feeds both build gates.
  supportedMods = [
    "cmd"
    "ctrl"
    "alt"
    "shift"
  ];

  # Supported `key` allowlist (design "Lua Renderer"): F1-F20, single printable
  # characters, and the named keys below.
  namedKeys = [
    "space"
    "return"
    "tab"
    "escape"
    "delete"
    "up"
    "down"
    "left"
    "right"
  ];
  functionKeys = map (n: "F${toString n}") (lib.range 1 20);

  keySupported =
    key:
    builtins.elem (lib.toUpper key) functionKeys
    || builtins.elem (lib.toLower key) namedKeys
    || builtins.stringLength key == 1;

  # Hotkey identity for duplicate detection (3.7): order-insensitive modifier
  # set plus the lowercased key.
  hotkeyIdentity =
    binding:
    lib.concatStringsSep "+" (lib.sort (a: b: a < b) binding.mods ++ [ (lib.toLower binding.key) ]);

  # Human identifier naming the offending binding in error messages.
  bindingLabel =
    i: binding:
    let
      keyPart = if (binding ? key) && binding.key != "" then binding.key else "<missing key>";
      modsPart = lib.concatStringsSep "+" (binding.mods or [ ]);
      hotkey = if (binding.mods or [ ]) == [ ] then keyPart else "${modsPart}+${keyPart}";
      desc = lib.optionalString ((binding.description or "") != "") " \"${binding.description}\"";
    in
    "binding #${toString (i + 1)} (${hotkey})${desc}";

  # Validate one binding: action arity exactly one (3.8), non-empty key (3.8),
  # supported modifiers and key (3.9). Returns true or `throw`s.
  checkBinding =
    i: binding:
    let
      label = bindingLabel i binding;
      inherit (binding) action;
      present = lib.filter (a: a != null) [
        (action.applescript or null)
        (action.command or null)
        (action.lua or null)
      ];
      nActions = builtins.length present;
      hasKey = (binding ? key) && binding.key != "";
      badMods = lib.filter (m: !(builtins.elem m supportedMods)) (binding.mods or [ ]);
    in
    if nActions == 0 then
      throw "hammerspoon-keybindings: ${label} declares no action; set exactly one of applescript/command/lua."
    else if nActions > 1 then
      throw "hammerspoon-keybindings: ${label} declares ${toString nActions} actions; set exactly one of applescript/command/lua."
    else if !hasKey then
      throw "hammerspoon-keybindings: ${label} is missing its key; every binding must declare a non-empty key."
    else if badMods != [ ] then
      throw "hammerspoon-keybindings: ${label} uses unsupported modifier(s) ${lib.concatStringsSep ", " badMods}; allowed modifiers are cmd, ctrl, alt, shift."
    else if !keySupported binding.key then
      throw "hammerspoon-keybindings: ${label} uses unsupported key '${binding.key}'; allowed keys are F1-F20, single printable characters, and named keys (${lib.concatStringsSep ", " namedKeys})."
    else
      true;

  # First hotkey identity bound by more than one binding (3.7), else null.
  duplicateHotkey =
    let
      go =
        seen: rest:
        if rest == [ ] then
          null
        else
          let
            id = builtins.head rest;
          in
          if builtins.elem id seen then id else go (seen ++ [ id ]) (builtins.tail rest);
    in
    go [ ] (map hotkeyIdentity cfg.keybindings);

  dupCheck =
    if duplicateHotkey != null then
      throw "hammerspoon-keybindings: duplicate hotkey '${duplicateHotkey}' is bound by more than one keybinding; each hotkey (modifier set + key) must be unique."
    else
      true;

  # Force every binding check first, then the duplicate check; any failure
  # `throw`s before the renderer emits Lua.
  validated = lib.all (x: x) (lib.imap0 checkBinding cfg.keybindings ++ [ dupCheck ]);

  sections =
    header
    ++ lib.optional (cfg.extraConfig != "") cfg.extraConfig
    ++ map renderBinding cfg.keybindings
    ++ reloadWatcher;
in
lib.seq validated (lib.concatStringsSep "\n" sections + "\n")
