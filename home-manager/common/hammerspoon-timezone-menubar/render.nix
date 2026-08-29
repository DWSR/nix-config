timezones:
let
  renderTimezone =
    timezone:
    "{ label = ${builtins.toJSON timezone.label}, timeZone = ${builtins.toJSON timezone.timeZone} },";
in
''
  -- hammerspoon-timezone-menubar: compact world clocks
  do
    local configuredTimezones = {
  ${builtins.concatStringsSep "\n" (map renderTimezone timezones)}
    }

  ${builtins.readFile ./timezone-menubar.lua}
  end
''
