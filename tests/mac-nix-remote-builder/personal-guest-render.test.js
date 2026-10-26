'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nixEvalJson, repoRoot } = require('./helpers');

const macGuestModulePath = `${repoRoot}/home-manager/common/lima-mac-guest.nix`;

function standaloneMacGuestExpr(extraModule, name = 'mac-builder') {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      pkgs = import flake.inputs.nixpkgs {
        system = builtins.currentSystem;
        overlays = [ flake.overlays.unstable-packages ];
      };
      hm = flake.inputs.home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        modules = [
          ${macGuestModulePath}
          ({ ... }: {
            home.username = "macguest-test";
            home.homeDirectory = "/Users/macguest-test";
            home.stateVersion = "26.05";
          })
          (${extraModule})
        ];
      };
    in
    {
      hasSupervisorAgent = hm.config.launchd.agents ? lima-${name};
      supervisorAgent =
        if hm.config.launchd.agents ? lima-${name} then
          hm.config.launchd.agents.lima-${name}
        else
          null;
      hasForwardAgent = hm.config.launchd.agents ? lima-${name}-forward;
      forwardAgent =
        if hm.config.launchd.agents ? lima-${name}-forward then
          hm.config.launchd.agents.lima-${name}-forward
        else
          null;
      agentNames = builtins.attrNames hm.config.launchd.agents;
      configYaml =
        if (hm.config.virtualisation.limaMacGuest._configYaml or null) != null then
          builtins.readFile hm.config.virtualisation.limaMacGuest._configYaml
        else
          null;
      supervisorText =
        if (hm.config.virtualisation.limaMacGuest._supervisor or null) != null then
          builtins.readFile (hm.config.virtualisation.limaMacGuest._supervisor + "/bin/lima-${name}-supervisor")
        else
          null;
      forwardText =
        if (hm.config.virtualisation.limaMacGuest._forward or null) != null then
          builtins.readFile (hm.config.virtualisation.limaMacGuest._forward + "/bin/lima-${name}-forward")
        else
          null;
      packages = map (p: p.name or "") hm.config.home.packages;
    }
  `;
}

test('disabled configuration registers no launchd agents', () => {
  const rendered = nixEvalJson(standaloneMacGuestExpr(`{ ... }: { }`));

  assert.equal(rendered.hasSupervisorAgent, false);
  assert.equal(rendered.supervisorAgent, null);
  assert.equal(rendered.hasForwardAgent, false);
  assert.equal(rendered.forwardAgent, null);
  assert.equal(rendered.configYaml, null);
  assert.equal(rendered.supervisorText, null);
  assert.equal(rendered.forwardText, null);
});

test('enabled configuration registers both launchd agents', () => {
  const rendered = nixEvalJson(standaloneMacGuestExpr(`{ ... }: { virtualisation.limaMacGuest.enable = true; }`));

  assert.equal(rendered.hasSupervisorAgent, true);
  assert.equal(rendered.supervisorAgent.enable, true);
  const { config: supervisorConfig } = rendered.supervisorAgent;
  assert.equal(supervisorConfig.Label, 'dev.dwsr.lima-mac-builder');
  assert.match(supervisorConfig.ProgramArguments[0], /lima-mac-builder-supervisor$/);
  assert.equal(supervisorConfig.RunAtLoad, true);
  assert.equal(supervisorConfig.KeepAlive.SuccessfulExit, false);
  assert.equal(supervisorConfig.ProcessType, 'Background');
  assert.equal(
    supervisorConfig.EnvironmentVariables.LIMA_HOME,
    '/Users/macguest-test/.local/state/lima',
  );
  assert.equal(supervisorConfig.EnvironmentVariables.HOME, '/Users/macguest-test');
  assert.equal(
    supervisorConfig.StandardOutPath,
    '/Users/macguest-test/Library/Logs/lima-vm/lima-mac-builder.log',
  );
  assert.equal(
    supervisorConfig.StandardErrorPath,
    '/Users/macguest-test/Library/Logs/lima-vm/lima-mac-builder.error.log',
  );

  assert.equal(rendered.hasForwardAgent, true);
  assert.equal(rendered.forwardAgent.enable, true);
  const { config: forwardConfig } = rendered.forwardAgent;
  assert.equal(forwardConfig.Label, 'dev.dwsr.lima-mac-builder-forward');
  assert.match(forwardConfig.ProgramArguments[0], /lima-mac-builder-forward$/);
  assert.equal(forwardConfig.RunAtLoad, true);
  assert.equal(forwardConfig.KeepAlive, true);
  assert.equal(forwardConfig.ProcessType, 'Background');
  assert.equal(
    forwardConfig.EnvironmentVariables.LIMA_HOME,
    '/Users/macguest-test/.local/state/lima',
  );
  assert.equal(forwardConfig.EnvironmentVariables.HOME, '/Users/macguest-test');
  assert.equal(
    forwardConfig.StandardOutPath,
    '/Users/macguest-test/Library/Logs/lima-vm/lima-mac-builder-forward.log',
  );
  assert.equal(
    forwardConfig.StandardErrorPath,
    '/Users/macguest-test/Library/Logs/lima-vm/lima-mac-builder-forward.error.log',
  );

});

test('rendered guest YAML matches the module contract', () => {
  const rendered = nixEvalJson(standaloneMacGuestExpr(`{ ... }: { virtualisation.limaMacGuest.enable = true; }`));

  const yaml = rendered.configYaml;
  assert.ok(yaml, 'expected virtualisation.limaMacGuest._configYaml to render');

  assert.match(yaml, /os: ?Darwin/);
  assert.match(yaml, /vmType: ?['"]?vz['"]?/);
  assert.match(yaml, /location: ?['"]?https:\/\/updates\.cdn-apple\.com\/2026FallFCS\/\.\.\.\/UniversalMac_27\.0\.1_26A434_Restore\.ipsw['"]?/);
  assert.match(yaml, /digest: ?['"]?sha256:2f016638293c3e641b8b25391a76fbc16563b3711915a5551cf8aa0f5598a5c1['"]?/);
  assert.match(yaml, /suppressFirstLoginSetup: ?true/);
  assert.match(yaml, /mounts: ?\[\]/);
  assert.doesNotMatch(yaml, /containerd:/);
});

test('supervisor creates the instance on first run', () => {
  const rendered = nixEvalJson(standaloneMacGuestExpr(`{ ... }: { virtualisation.limaMacGuest.enable = true; }`));

  const wrapper = rendered.supervisorText;
  assert.ok(wrapper, 'expected virtualisation.limaMacGuest._supervisor to render');

  assert.match(
    wrapper,
    /export LIMA_HOME=?['"]?\/Users\/macguest-test\/\.local\/state\/lima['"]?/,
  );
  assert.match(wrapper, /if ! limactl list --json "\$name" >\/dev\/null 2>&1; then/);
  assert.match(wrapper, /limactl --tty=false create --name="\$name" "\$config"/);
  assert.match(wrapper, /exec limactl --tty=false start --foreground "\$name"/);
});

test('forward agent renders the SSH forward command', () => {
  const rendered = nixEvalJson(standaloneMacGuestExpr(`{ ... }: { virtualisation.limaMacGuest.enable = true; }`));

  const forward = rendered.forwardText;
  assert.ok(forward, 'expected virtualisation.limaMacGuest._forward to render');

  assert.match(forward, /ssh -F "\$LIMA_HOME\/mac-builder\/ssh\.config"/);
  assert.match(forward, /ExitOnForwardFailure=yes/);
  assert.match(forward, /-N/);
  assert.match(forward, /-L .*:2222:127\.0\.0\.1:22/);
});

test('personal host enables the guest and keeps the fabro instance', { timeout: 600_000 }, () => {
  const rendered = nixEvalJson(
    `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      hm = flake.darwinConfigurations."Brandons-MacBook-Pro".config.home-manager.users.brandonmcnama;
      macGuestYaml = builtins.readFile hm.virtualisation.limaMacGuest._configYaml;
      limaVmYaml = builtins.readFile hm.virtualisation.limaVM._configYaml;
    in
    {
      macGuestEnable = hm.virtualisation.limaMacGuest.enable;
      macGuestName = hm.virtualisation.limaMacGuest.name;
      macGuestYaml = macGuestYaml;
      hasSupervisorAgent = hm.launchd.agents ? lima-mac-builder;
      hasForwardAgent = hm.launchd.agents ? lima-mac-builder-forward;
      supervisorLabel = (hm.launchd.agents.lima-mac-builder or {}).config.Label or null;
      forwardLabel = (hm.launchd.agents.lima-mac-builder-forward or {}).config.Label or null;
      limaVmEnable = hm.virtualisation.limaVM.enable;
      limaVmHostname = hm.virtualisation.limaVM.hostname;
      limaVmGuestSystem = hm.virtualisation.limaVM.guestSystem;
      limaVmYaml = limaVmYaml;
      hasFabroAgent = hm.launchd.agents ? lima-fabro;
    }
  `,
    { timeout: 600_000 },
  );

  assert.equal(rendered.macGuestEnable, true);
  assert.equal(rendered.macGuestName, 'mac-builder');
  assert.equal(rendered.hasSupervisorAgent, true);
  assert.equal(rendered.hasForwardAgent, true);
  assert.equal(rendered.supervisorLabel, 'dev.dwsr.lima-mac-builder');
  assert.equal(rendered.forwardLabel, 'dev.dwsr.lima-mac-builder-forward');

  const yaml = rendered.macGuestYaml;
  assert.match(yaml, /os: ?Darwin/);
  assert.match(yaml, /vmType: ?['"]?vz['"]?/);
  assert.match(yaml, /suppressFirstLoginSetup: ?true/);
  assert.match(yaml, /mounts: ?\[\]/);
  assert.doesNotMatch(yaml, /containerd:/);

  assert.equal(rendered.limaVmEnable, true);
  assert.equal(rendered.limaVmHostname, 'fabro');
  assert.equal(rendered.limaVmGuestSystem, 'fabro-vm');
  assert.equal(rendered.hasFabroAgent, true);

  const limaVmYaml = rendered.limaVmYaml;
  assert.match(limaVmYaml, /echo ?['"]?fabro['"]? ?>>?\/proc\/sys\/kernel\/hostname/);
  assert.match(limaVmYaml, /usermod -aG podman/);
  assert.match(limaVmYaml, /location: ?['"]?~\/\.local\/state\/fabro['"]?/);
});
