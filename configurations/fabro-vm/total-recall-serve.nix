# Single source of truth for the `tailscale serve` ExecStart list on the
# fabro guest.
#
# `tailscale.nix` renders the tailscale-serve unit from this function, and
# `total-recall.nix` asserts both the enabled and the disabled form from the
# same function (install-total-recall-on-fabro-vm spec, task 9.2;
# requirements 6.4, 9.2, 9.5; design "C4: Tailscale Serve exposure"). Keeping
# the list pure means the disabled variant is verified without instantiating a
# second NixOS configuration, while the equality assertion against the unit
# proves the runtime wiring uses exactly this list.
{
  lib,
  tailscalePackage,
  totalRecallEnable,
  iiiPort ? 49134,
}:
let
  serve =
    service: target: "${lib.getExe tailscalePackage} serve --service=${service} --https=443 ${target}";
  # The existing triples must stay byte-for-byte unchanged and run before the
  # memory entry, so a failure of the new entry leaves them applied (design
  # "C4: Tailscale Serve exposure").
  existing = [
    (serve "svc:fabro" "http://127.0.0.1:32276")
    (serve "svc:litellm" "http://127.0.0.1:4000")
    (serve "svc:opencode" "http://127.0.0.1:4096")
  ];
in
existing
++ lib.optionals totalRecallEnable [
  (serve "svc:total-recall" "http://127.0.0.1:${toString iiiPort}")
]
