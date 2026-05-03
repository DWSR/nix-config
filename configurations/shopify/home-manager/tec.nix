{
  config,
  lib,
  ...
}:
let
  # ===========================================================================
  # Declarative tec tools profile
  # ===========================================================================
  #
  # tec (the Tecnix profile manager) normally pulls tool-profile updates from
  # Windex on its own — either via the user-janitor LaunchAgent (background
  # auto-updates), via `tec tools update` (manual), or via `tec tools fetch`.
  # We want exactly one source of truth for which profile is active: this nix
  # config.
  #
  # Workflow to bump:
  #   1. Run `tec tools update` interactively to discover the new SHA, OR
  #      get it from anyone else who has updated. `tec tools show` displays
  #      the current SHA.
  #   2. Edit `profileSha` below to the new value.
  #   3. `darwin-rebuild switch`. The activation script will:
  #        a. Remove any existing pin file (so tec can switch profiles freely).
  #        b. Run `tec tools fetch --sha <new-sha> --activate` — downloads the
  #           profile from Windex and atomically switches `current`.
  #        c. home-manager re-materializes the pin file as a read-only symlink
  #           pointing at the new SHA.
  #
  # Why pinning is enforced via a read-only symlink:
  #   home-manager's `home.file` symlinks the pin path to a Nix store file.
  #   The Nix store is read-only, so `tec tools unpin` (which deletes the file)
  #   and `tec tools pin <other-sha>` (which overwrites the file) both fail.
  #   The only way to change the active profile is to bump `profileSha` here
  #   and re-run `darwin-rebuild switch`.
  #
  # Reference: see memories/2026-04-30-zsh-startup-profile.md for the
  # investigation that led here. The companion change in
  # configurations/shopify/home-manager/dev.nix sed-strips the
  # `tec tools shell-hook` line from `tec init zsh` output (saving ~146ms
  # per shell start) since we no longer need the staleness notification.
  #
  # ---------------------------------------------------------------------------
  profileSha = "f9da3fdde7ec0e20f6b7e5f0688f49c7ca5a02cb";

  pinFileText = builtins.toJSON {
    sha = profileSha;
    pinned_at = 0; # tec doesn't read this field for any decision; placeholder.
  };

  pinFileRelativePath = ".local/state/tec/profiles/base/pinned";
  pinFileAbsolutePath = "${config.home.homeDirectory}/${pinFileRelativePath}";
  tecBin = "${config.home.homeDirectory}/.local/state/tec/profiles/base/current/global/bin/tec";
in
{
  # Pre-writeBoundary activation: ensure the pinned SHA is fetched + active
  # BEFORE home-manager symlinks the pin file. This avoids a race where the
  # pin file points at a SHA that the active profile (the `current` symlink)
  # doesn't match.
  home.activation.tecActivateProfile = lib.hm.dag.entryBefore [ "writeBoundary" ] ''
    pinFile="${pinFileAbsolutePath}"
    tecBin="${tecBin}"

    if [[ ! -x "$tecBin" ]]; then
      echo "tec.nix: $tecBin not found; skipping fetch+activate" >&2
    else
      # Remove existing pin (managed by us as a read-only symlink to a
      # stale store path, OR a real file from a prior `tec tools pin` call).
      # tec tools fetch --activate will refuse to switch if pinned to a
      # different SHA.
      if [[ -L "$pinFile" || -f "$pinFile" ]]; then
        $DRY_RUN_CMD rm -f "$pinFile"
      fi

      # Fetch + activate the pinned SHA. Idempotent: if already at this SHA,
      # tec is a no-op. If fetch fails (network, Windex down), continue —
      # home.file will still write the pin pointing at the requested SHA;
      # `tec tools show` may then report a mismatch which the user can
      # resolve by re-running `darwin-rebuild switch` once the network is up.
      $DRY_RUN_CMD "$tecBin" tools fetch --sha "${profileSha}" --activate \
        || echo "tec.nix: tec tools fetch --sha ${profileSha} --activate failed (non-fatal)" >&2
    fi
  '';

  # Declarative pin file. home.file symlinks the relative path under $HOME
  # to a read-only file in the Nix store containing the JSON pin record.
  # `tec tools pin/unpin` cannot modify it. The only mutation path is
  # bumping `profileSha` above + re-running `darwin-rebuild switch`.
  home.file."${pinFileRelativePath}".text = pinFileText;
}
