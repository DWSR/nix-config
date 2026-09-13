{
  lib,
  buildGoModule,
  scAuthPath ? "/usr/sbin/sc_auth",
  providerPath ? "/usr/lib/ssh-keychain.dylib",
  sshKeygenPath ? "/usr/bin/ssh-keygen",
  ...
}:

buildGoModule {
  pname = "git-mcp-secure-enclave-signer";
  version = "1";
  name = "git-mcp-secure-enclave-signer";
  src = ./git-mcp-secure-enclave-signer;
  vendorHash = null;
  subPackages = [
    "cmd/signer"
    "cmd/worker"
  ];

  env.CGO_ENABLED = "1";
  ldflags = [
    "-extldflags=-Wl,-no_uuid"
    "-X github.com/brandonmcnama/git-mcp-secure-enclave-signer/internal/config.ScAuthPath=${scAuthPath}"
    "-X github.com/brandonmcnama/git-mcp-secure-enclave-signer/internal/config.ProviderPath=${providerPath}"
    "-X github.com/brandonmcnama/git-mcp-secure-enclave-signer/internal/config.SSHKeygenPath=${sshKeygenPath}"
  ];

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    go test ./...
    runHook postCheck
  '';

  postInstall = ''
    install -d "$out/libexec"
    mv "$out/bin/signer" "$out/bin/git-mcp-secure-enclave-signer"
    mv "$out/bin/worker" "$out/libexec/git-mcp-secure-enclave-signer-worker"
  '';

  meta = {
    mainProgram = "git-mcp-secure-enclave-signer";
    platforms = lib.platforms.darwin;
  };
}
