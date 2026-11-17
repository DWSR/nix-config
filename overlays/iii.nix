_: final: _prev:
let
  system = final.stdenv.hostPlatform.system;
  supportedSystems = [
    "aarch64-linux"
    "aarch64-darwin"
  ];
  requireSupported =
    value:
    if builtins.elem system supportedSystems then value else throw "Unsupported iii system: ${system}";

  # iii 0.26.0 release assets (research.md § Engine release facts). The
  # tag-pinned URL and the recorded SHA-256 make each fetch immutable; the
  # engine is the upstream archive, never an installer or a local binary.
  iiiVersion = "0.26.0";
  iiiRevision = "iii/v${iiiVersion}";
  engineSources = {
    "aarch64-linux" = {
      url = "https://github.com/iii-hq/iii/releases/download/${iiiRevision}/iii-aarch64-unknown-linux-gnu.tar.gz";
      hash = "sha256-4u5E0es48OM30+d7O4YB2ib/G9k0zIpMhJubz0FKtAs=";
    };
    "aarch64-darwin" = {
      url = "https://github.com/iii-hq/iii/releases/download/${iiiRevision}/iii-aarch64-apple-darwin.tar.gz";
      hash = "sha256-JzApagiuWEN1ey55E61ltigpAcmLlR28IwGODrQl4oU=";
    };
  };

  iii = requireSupported (
    final.stdenvNoCC.mkDerivation {
      pname = "iii";
      version = iiiVersion;
      src = final.fetchurl { inherit (engineSources.${system}) url hash; };
      dontUnpack = true;
      # The archives are single-executable tarballs; the ELF interpreter and
      # RPATH are the only Linux fixups, so never rewrite the pinned bytes.
      dontStrip = true;
      dontFixup = final.stdenv.hostPlatform.isDarwin;

      nativeBuildInputs = final.lib.optionals final.stdenv.hostPlatform.isLinux [
        final.autoPatchelfHook
      ];
      buildInputs = final.lib.optionals final.stdenv.hostPlatform.isLinux [
        final.glibc
        final.stdenv.cc.cc.lib
      ];

      installPhase = ''
        runHook preInstall
        mkdir -p "$out/bin"
        tar -xzf "$src" -C "$out/bin"
        chmod 0555 "$out/bin/iii"
        runHook postInstall
      '';

      passthru = {
        sourceRevision = iiiRevision;
      };

      meta = {
        description = "Pinned iii persistence engine";
        homepage = "https://github.com/iii-hq/iii";
        mainProgram = "iii";
        platforms = supportedSystems;
      };
    }
  );
in
{
  inherit iii;
}
