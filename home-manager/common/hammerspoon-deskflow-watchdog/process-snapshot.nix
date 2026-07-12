{
  diffutils,
  lib,
  stdenv,
}:

stdenv.mkDerivation {
  pname = "deskflow-process-snapshot";
  version = "0.1.0";

  src = ./process-snapshot.c;
  testSrc = ../../../tests/hammerspoon-deskflow-watchdog/process-snapshot.test.c;
  dontUnpack = true;
  strictDeps = true;

  buildPhase = ''
    runHook preBuild

    $CC -std=c17 -Wall -Wextra -Werror -O2 "$src" -o deskflow-process-snapshot -lproc

    runHook postBuild
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck

    $CC -std=c17 -Wall -Wextra -Werror -O2 \
      -DPROCESS_SNAPSHOT_SOURCE="\"$src\"" \
      "$testSrc" -o process-snapshot-tests -lproc
    ./process-snapshot-tests

    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/bin"
    install -m755 deskflow-process-snapshot "$out/bin/deskflow-process-snapshot"

    runHook postInstall
  '';

  doInstallCheck = true;
  nativeInstallCheckInputs = [ diffutils ];
  installCheckPhase = ''
    runHook preInstallCheck

    "$out/bin/deskflow-process-snapshot" > first.out
    "$out/bin/deskflow-process-snapshot" > second.out
    test ! -s first.out
    cmp -s first.out second.out
    wc -c first.out second.out

    runHook postInstallCheck
  '';

  meta = {
    description = "Kernel-backed inventory of current-user Deskflow core processes";
    mainProgram = "deskflow-process-snapshot";
    platforms = lib.platforms.darwin;
  };
}
