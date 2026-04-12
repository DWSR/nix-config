# Zellij WASM plugins — built from source using fenix Rust toolchain targeting wasm32-wasip1
# TODO: Remove source builds once upstream releases versions compatible with zellij 0.44
{ inputs }:
final: _prev:
let
  fenixPkgs = inputs.fenix.packages.${final.stdenv.hostPlatform.system};
  rustToolchain = fenixPkgs.combine [
    fenixPkgs.stable.cargo
    fenixPkgs.stable.rustc
    fenixPkgs.targets.wasm32-wasip1.stable.rust-std
  ];
  rustPlatform = final.makeRustPlatform {
    cargo = rustToolchain;
    rustc = rustToolchain;
  };

  # Builder for zellij plugins that need to be compiled from source with
  # zellij-tile bumped to 0.44 for ABI compatibility
  mkZellijPlugin =
    {
      pname,
      version,
      owner,
      repo,
      tag ? "v${version}",
      srcHash,
      wasmBinary,
      cargoLockFile,
      cargoPatches,
      description,
    }:
    rustPlatform.buildRustPackage {
      inherit pname;
      version = "${version}-patched";

      src = final.fetchFromGitHub {
        inherit owner repo tag;
        hash = srcHash;
      };

      cargoLock.lockFile = cargoLockFile;
      inherit cargoPatches;

      postPatch = ''
        cp ${cargoLockFile} Cargo.lock
      '';

      buildPhase = ''
        cargo build --release --target wasm32-wasip1
      '';

      doCheck = false;

      installPhase = ''
        mkdir -p $out/share/zellij/plugins
        cp target/wasm32-wasip1/release/${wasmBinary} $out/share/zellij/plugins/${pname}.wasm
      '';

      meta = with final.lib; {
        inherit description;
        homepage = "https://github.com/${owner}/${repo}";
        license = licenses.mit;
      };
    };
in
{
  zellij-autolock = final.stdenv.mkDerivation {
    pname = "zellij-autolock";
    version = "0.2.2";

    src = final.fetchurl {
      url = "https://github.com/fresh2dev/zellij-autolock/releases/download/0.2.2/zellij-autolock.wasm";
      hash = "sha256-aclWB7/ZfgddZ2KkT9vHA6gqPEkJ27vkOVLwIEh7jqQ=";
    };

    dontUnpack = true;
    dontBuild = true;

    installPhase = ''
      mkdir -p $out/share/zellij/plugins
      cp $src $out/share/zellij/plugins/zellij-autolock.wasm
    '';

    meta = with final.lib; {
      description = "Auto-lock Zellij when certain processes open";
      homepage = "https://github.com/fresh2dev/zellij-autolock";
      license = licenses.mit;
    };
  };

  zjstatus = mkZellijPlugin {
    pname = "zjstatus";
    version = "0.22.0";
    owner = "dj95";
    repo = "zjstatus";
    srcHash = "sha256-aWp608krMtk5I+c3GXyuHkb6ugah40cBI0R52fNqMiI=";
    wasmBinary = "zjstatus.wasm";
    cargoLockFile = ./zjstatus-Cargo.lock;
    cargoPatches = [ ./zjstatus-zellij-0.44.patch ];
    description = "Configurable and themeable status bar plugin for Zellij";
  };

  zellij-notepad = mkZellijPlugin {
    pname = "zellij-notepad";
    version = "0.2.1";
    owner = "0xble";
    repo = "zellij-notepad";
    srcHash = "sha256-ZMISRi4NtNygT27m4DOhJg8xv7V1yRcbT4ZAuhHI194=";
    wasmBinary = "notepad.wasm";
    cargoLockFile = ./zellij-notepad-Cargo.lock;
    cargoPatches = [ ./zellij-notepad-zellij-0.44.patch ];
    description = "Floating notepad plugin for Zellij";
  };

  zellij-forgot = mkZellijPlugin {
    pname = "zellij-forgot";
    version = "0.4.2";
    owner = "karimould";
    repo = "zellij-forgot";
    tag = "0.4.2";
    srcHash = "sha256-QS09lC6yyUZA13PHERrdY/phfo1QoHAmRPpQUGL3pP8=";
    wasmBinary = "zellij_forgot.wasm";
    cargoLockFile = ./zellij-forgot-Cargo.lock;
    cargoPatches = [ ./zellij-forgot-zellij-0.44.patch ];
    description = "Zellij plugin to help remember keybindings and commands";
  };

  zellij-attention = mkZellijPlugin {
    pname = "zellij-attention";
    version = "0.3.1";
    owner = "KiryuuLight";
    repo = "zellij-attention";
    srcHash = "sha256-T36mzLbXCUqBeLa5hUX4/gMZ/c41szKAcLrsyXB6TIQ=";
    wasmBinary = "zellij-attention.wasm";
    cargoLockFile = ./zellij-attention-Cargo.lock;
    cargoPatches = [ ./zellij-attention-zellij-0.44.patch ];
    description = "Zellij plugin that adds notification icons to tab names";
  };

  zellij-worktree = mkZellijPlugin {
    pname = "zellij-worktree";
    version = "0.1.0";
    owner = "sharph";
    repo = "zellij-worktree";
    srcHash = "sha256-5efD2F2UMRfYM4st2+mfsmUwqELXtnxAlBqi1vmBNKk=";
    wasmBinary = "zellij-worktree.wasm";
    cargoLockFile = ./zellij-worktree-Cargo.lock;
    cargoPatches = [
      ./zellij-worktree-zellij-0.44.patch
      ./zellij-worktree-trunk-branch.patch
    ];
    description = "Git worktree management plugin for Zellij";
  };
}
