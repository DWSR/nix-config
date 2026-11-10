{ inputs }:
final: _prev:
let
  system = final.stdenv.hostPlatform.system;
  totalRecall = inputs.total-recall.packages.${system};
  harnessEventsPkgs =
    import
      (
        if final.stdenv.hostPlatform.isDarwin then
          inputs.total-recall.inputs.nixpkgsDarwin
        else
          inputs.total-recall.inputs.nixpkgs
      )
      {
        inherit system;
        overlays = final.lib.optional final.stdenv.hostPlatform.isDarwin (
          import inputs.total-recall.inputs.rust-overlay.outPath
        );
      };
  harnessEventsRustPlatform =
    if final.stdenv.hostPlatform.isDarwin then
      let
        rustToolchain = harnessEventsPkgs.rust-bin.stable."1.98.1".minimal;
      in
      harnessEventsPkgs.makeRustPlatform {
        cargo = rustToolchain;
        rustc = rustToolchain;
      }
    else
      harnessEventsPkgs.rustPlatform;
  inherit (harnessEventsPkgs) protobuf;
  harnessEvents = harnessEventsRustPlatform.buildRustPackage {
    pname = "total-recall-harness-events";
    version = "0.1.0";
    src = totalRecall.harness-ingestion.src;
    cargoLock.lockFile = "${inputs.total-recall.outPath}/Cargo.lock";
    cargoBuildFlags = [
      "--package"
      "harness-events-cli"
    ];
    doCheck = false;
    nativeBuildInputs = [ protobuf ];

    meta = {
      description = "Harness event capture CLI from the pinned total-recall source";
      mainProgram = "harness-events";
      platforms = final.lib.platforms.unix;
    };
  };
  # iii uses Elastic License 2.0; allow only this package in its package set.
  iiiPkgs = import inputs.nixpkgs {
    inherit system;
    config.allowUnfreePredicate = package: inputs.nixpkgs.lib.getName package == "iii";
  };

  mkArchivePackage =
    {
      packagePkgs ? final,
      pname,
      version,
      url,
      hash,
      binary,
      packageDescription,
      packageLicense,
    }:
    packagePkgs.stdenv.mkDerivation {
      inherit pname version;
      src = packagePkgs.fetchurl { inherit url hash; };
      dontBuild = true;
      dontUnpack = true;

      nativeBuildInputs = [
        packagePkgs.autoPatchelfHook
        packagePkgs.gnutar
      ];
      buildInputs = [
        packagePkgs.glibc
        packagePkgs.stdenv.cc.cc.lib
      ];

      installPhase = ''
        runHook preInstall
        mkdir -p "$out/bin"
        tar -xzf "$src" -O ${binary} > "$out/bin/${binary}"
        chmod 0555 "$out/bin/${binary}"
        runHook postInstall
      '';

      doInstallCheck = true;
      installCheckPhase = ''
        test -x "$out/bin/${binary}"
        "$out/bin/${binary}" --help >/dev/null
      '';

      meta = {
        description = packageDescription;
        license = packageLicense;
        mainProgram = binary;
        platforms = [ "aarch64-linux" ];
      };
    };

  # iii 0.24.0: sha256-YI8a0WM0jngYpV94ShHi7+KwPYE1MquWokMhHEJ57zA= (aarch64-linux).
  iii = mkArchivePackage {
    packagePkgs = iiiPkgs;
    pname = "iii";
    version = "0.24.0";
    url = "https://github.com/iii-hq/iii/releases/download/iii%2Fv0.24.0/iii-aarch64-unknown-linux-gnu.tar.gz";
    hash = "sha256-YI8a0WM0jngYpV94ShHi7+KwPYE1MquWokMhHEJ57zA=";
    binary = "iii";
    packageDescription = "Pinned iii 0.24.0 runtime for total-recall";
    packageLicense = final.lib.licenses.elastic20;
  };

  # database 0.5.26: sha256-pqdDRmX8qm6RtzyTXVoVfjdvq84HkHaydvkXPQ+EwX8= (aarch64-linux).
  database = mkArchivePackage {
    pname = "database";
    version = "0.5.26";
    url = "https://cdn.iii.cloud/workers/database/0.5.26/database-aarch64-unknown-linux-gnu.tar.gz";
    hash = "sha256-pqdDRmX8qm6RtzyTXVoVfjdvq84HkHaydvkXPQ+EwX8=";
    binary = "database";
    packageDescription = "Pinned iii database registry worker";
    packageLicense = final.lib.licenses.asl20;
  };

  # queue 0.21.26: sha256-OhgcZen7LF2unbxmUDOvZkWyDDPxW41QuRzfl2BN1vk= (aarch64-linux).
  queue = mkArchivePackage {
    pname = "queue";
    version = "0.21.26";
    url = "https://cdn.iii.cloud/workers/queue/0.21.26/queue-aarch64-unknown-linux-gnu.tar.gz";
    hash = "sha256-OhgcZen7LF2unbxmUDOvZkWyDDPxW41QuRzfl2BN1vk=";
    binary = "queue";
    packageDescription = "Pinned iii queue registry worker";
    packageLicense = final.lib.licenses.asl20;
  };

  # cron 0.21.28: sha256-G0253hLdsiOZWR/auRhEHak6X7dsHINCIyaNVY90U3A= (aarch64-linux).
  cron = mkArchivePackage {
    pname = "cron";
    version = "0.21.28";
    url = "https://cdn.iii.cloud/workers/cron/0.21.28/cron-aarch64-unknown-linux-gnu.tar.gz";
    hash = "sha256-G0253hLdsiOZWR/auRhEHak6X7dsHINCIyaNVY90U3A=";
    binary = "cron";
    packageDescription = "Pinned iii cron registry worker";
    packageLicense = final.lib.licenses.asl20;
  };

  upstreamPackages = {
    total-recall-harness-ingestion = totalRecall.harness-ingestion;
    total-recall-harness-event-persistence = totalRecall.harness-event-persistence;
    total-recall-session-post-processing = totalRecall.session-post-processing;
    total-recall-opencode-plugin = totalRecall.opencode-harness-events;
    total-recall-pi-extension = totalRecall.pi-harness-events;
    total-recall-mcp-worker = totalRecall.mcp-worker;
  };
in
{
  total-recall-harness-events = harnessEvents;
  total-recall-iii = iii;
  total-recall-database = database;
  total-recall-queue = queue;
  total-recall-cron = cron;
}
// upstreamPackages
