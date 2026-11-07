const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const expression = `
let
  flake = builtins.getFlake (toString ./.);
  lib = flake.inputs.nixpkgs.lib;
  defaultConfig = (lib.nixosSystem {
    system = "aarch64-linux";
    modules = [ ./configurations/fabro-vm/total-recall.nix ];
  }).config;
  defaults = defaultConfig.fabro.totalRecall;
  guest = flake.nixosConfigurations.fabro-vm.config;
in {
  defaults = {
    enable = defaults.enable;
    iiiHost = defaults.iiiHost;
    iiiPort = defaults.iiiPort;
    streamHost = defaults.streamHost;
    streamPort = defaults.streamPort;
    databaseName = defaults.databaseName;
    databaseConnection = defaults.databaseConnection;
    queueTopic = defaults.queueTopic;
    postProcessingModel = defaults.postProcessingModel;
    postProcessingBaseUrl = defaults.postProcessingBaseUrl;
  };
  defaultUserExists = defaultConfig.users.users ? total-recall;
  guest = {
    enabled = guest.fabro.totalRecall.enable;
    userIsSystem = guest.users.users.total-recall.isSystemUser;
    userGroup = guest.users.users.total-recall.group;
    groupExists = guest.users.groups ? total-recall;
  };
}
`;

function evaluateGuest() {
  const result = spawnSync(
    "nix",
    ["eval", "--impure", "--json", "--expr", expression],
    { encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `Nix guest evaluation failed:\n${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}

test("guest totalRecall options have the designed defaults and are enabled", () => {
  const evaluated = evaluateGuest();

  assert.deepEqual(evaluated.defaults, {
    enable: false,
    iiiHost: "127.0.0.1",
    iiiPort: 49134,
    streamHost: "127.0.0.1",
    streamPort: 3112,
    databaseName: "memory",
    databaseConnection: "memory",
    queueTopic: "harness-events",
    postProcessingModel: "opencode-go/deepseek-v4.1-flash",
    postProcessingBaseUrl: "http://127.0.0.1:4000/v1/",
  });
  assert.equal(evaluated.defaultUserExists, false);
  assert.deepEqual(evaluated.guest, {
    enabled: true,
    userIsSystem: true,
    userGroup: "total-recall",
    groupExists: true,
  });
});

test("guest module declares no service, firewall opening, or mutable-user policy", () => {
  const module = readFileSync("configurations/fabro-vm/total-recall.nix", "utf8");

  assert.doesNotMatch(module, /systemd\.services|networking\.firewall|DynamicUser|users\.mutableUsers/);
});
