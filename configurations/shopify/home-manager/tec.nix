_:
let
  # ===========================================================================
  # Declarative tec tools profile pin
  # ===========================================================================
  #
  # tec (the Tecnix profile manager) ships a pin file at
  # ~/.local/state/tec/profiles/base/pinned that tells tec to refuse to
  # auto-activate any profile other than the pinned SHA. We make this file
  # a read-only symlink to a Nix store file managed by home-manager, so
  # `tec tools pin` and `tec tools unpin` both fail (cannot write to a
  # read-only path). The only way to change the active profile is to bump
  # `profileSha` here and re-run `darwin-rebuild switch` followed by a
  # manual `tec tools fetch --sha <new-sha> --activate`.
  #
  # ## Bump workflow (2 steps)
  #
  # 1. Discover the new SHA you want. `tec tools update` interactively
  #    pulls @latest from Windex without changing your active profile
  #    (because the pin still says the old SHA). `tec tools show` reveals
  #    the new SHA.
  #
  # 2. Edit `profileSha` below + run `darwin-rebuild switch`. This
  #    materializes the new pin file. Then run, in your interactive shell:
  #
  #        tec tools fetch --sha <new-sha> --activate
  #
  #    The pin file (now at <new-sha>) and the user-issued activation
  #    target match, so tec proceeds. After this, `tec tools show` reports
  #    active == pin == <new-sha>.
  #
  # ## Why we don't run `tec tools fetch --activate` from a home-manager
  # ## activation script
  #
  # We tried. nix-darwin invokes home-manager activation via:
  #
  #     launchctl asuser <uid> sudo -u <user> --set-home <activation-script>
  #
  # The activation script's checkHomeDirectory passes (HOME is set to the
  # user's home), and `whoami` reports the target user. But tec
  # nevertheless resolves `~/.local/state/tec` to `/var/root/.local/state/tec`
  # when invoked from this context, failing with:
  #
  #     WARN tec::logger::emit: Failed to create logger for command_invocation:
  #          Failed to create_dir_all for path: /var/root/.local/state/tec
  #     × failed to run 'tools' command
  #     ├─▶ failed to realize store path: /nix/store/.../world-profiles
  #     ╰─▶ Realization failed: error: getting status of
  #         '/var/root/.local/state/tec/profiles/base/world-sha/<sha>':
  #         Permission denied
  #
  # The cause is opaque — likely a macOS `sudo --set-home` + Rust passwd
  # lookup interaction, possibly involving REAL UID vs EFFECTIVE UID.
  # `env -i HOME=... USER=... PATH=...` workarounds are uncertain. Rather
  # than chase the contradiction further, we accept the 2-step workflow.
  #
  # See memories/2026-04-30-zsh-startup-profile.md for the broader
  # zsh-startup investigation that introduced this file.
  #
  # ---------------------------------------------------------------------------
  profileSha = "f9da3fdde7ec0e20f6b7e5f0688f49c7ca5a02cb";

  pinFileText = builtins.toJSON {
    sha = profileSha;
    pinned_at = 0; # tec doesn't read this field for any decision; placeholder.
  };
in
{
  # These markers stop the root janitor from creating or pruning Shopify Nix
  # drop-ins under /etc/nix.
  home.file.".local/state/tec/janitor/configure-nix-shopify-dropin.disabled".text = "";
  home.file.".local/state/tec/janitor/prune-old-shopify-nix-dropins.disabled".text = "";

  # Declarative pin file. home.file symlinks the relative path under $HOME
  # to a read-only file in the Nix store containing the JSON pin record.
  # `tec tools pin/unpin` (which write to or delete this path) both fail
  # against a read-only symlink. Only `darwin-rebuild switch` after a
  # `profileSha` bump can change the pin.
  home.file.".local/state/tec/profiles/base/pinned".text = pinFileText;
}
