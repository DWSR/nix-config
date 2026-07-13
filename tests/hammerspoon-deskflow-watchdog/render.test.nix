{ pkgs }:
let
  trustedSnapshotHelper =
    pkgs.callPackage ../../home-manager/common/hammerspoon-deskflow-watchdog/process-snapshot.nix
      { };
  render = import ../../home-manager/common/hammerspoon-deskflow-watchdog/render.nix {
    inherit trustedSnapshotHelper;
  };
  renderSource = builtins.readFile ../../home-manager/common/hammerspoon-deskflow-watchdog/render.nix;
  snapshotCommand = "${trustedSnapshotHelper}/bin/deskflow-process-snapshot";
  snapshotLiteral = builtins.toJSON (builtins.unsafeDiscardStringContext snapshotCommand);
  expectedHelperContext = builtins.getContext snapshotCommand;
  unrelatedHelper = pkgs.writeShellScriptBin "unrelated-helper" "exit 0";
  forgedHelperRoot =
    builtins.substring 0 0 trustedSnapshotHelper.outPath
    + "/nix/store/00000000000000000000000000000000-deskflow-process-snapshot-0.1.0";
  coordinatedAliasHelper = trustedSnapshotHelper // {
    outPath = forgedHelperRoot;
    out = trustedSnapshotHelper.out // {
      outPath = forgedHelperRoot;
    };
    all = [ (trustedSnapshotHelper.out // { outPath = forgedHelperRoot; }) ];
  };
  sameNameHelper = pkgs.runCommand trustedSnapshotHelper.name { } ''
    mkdir -p "$out/bin"
    touch "$out/bin/deskflow-process-snapshot"
  '';
  overrideHelper = trustedSnapshotHelper.overrideAttrs (_: {
    postInstall = ''
      touch "$out/reviewer-replacement"
    '';
  });
  multiOutputHelper =
    pkgs.runCommand trustedSnapshotHelper.name
      {
        outputs = [
          "out"
          "extra"
        ];
      }
      ''
        mkdir -p "$out/bin" "$extra/bin"
        touch "$out/bin/deskflow-process-snapshot" "$extra/bin/deskflow-process-snapshot"
      '';
  equivalentCommand =
    builtins.substring 0 0 snapshotCommand + builtins.unsafeDiscardStringContext snapshotCommand;
  contextlessCommand = builtins.unsafeDiscardStringContext snapshotCommand;
  extraContextCommand = snapshotCommand + builtins.substring 0 0 unrelatedHelper.outPath;
  contextualRole = "client" + builtins.substring 0 0 unrelatedHelper.outPath;
  forgedCommand = "${forgedHelperRoot}/bin/deskflow-process-snapshot";
  injectedCommand = forgedCommand + ''
    "; Runtime.start(nil, "server", "/bin/false")
  '';
  sentinel = "-- deskflow-hammerspoon-watchdog:render-v1";
  startCall = "Runtime.start(Model, role, snapshotCommand)";
  runtimeFileReads = [
    "dofile("
    "load("
    "loadfile("
    "require("
  ];

  client = render {
    role = "client";
    inherit snapshotCommand;
  };
  contextualClient = render {
    role = contextualRole;
    inherit snapshotCommand;
  };
  equivalentClient = render {
    role = "client";
    snapshotCommand = equivalentCommand;
  };
  server = render {
    role = "server";
    inherit snapshotCommand;
  };

  normalizeRole =
    builtins.replaceStrings
      [
        ''local role = "client"''
        ''local role = "server"''
      ]
      [
        ''local role = "ROLE"''
        ''local role = "ROLE"''
      ];
  count = needle: text: builtins.length (pkgs.lib.splitString needle text) - 1;
  rejected = value: !(builtins.tryEval value).success;

  clientLua = pkgs.writeText "deskflow-watchdog-client.lua" client;
  serverLua = pkgs.writeText "deskflow-watchdog-server.lua" server;
in
assert client != server;
assert client == equivalentClient;
assert normalizeRole client == normalizeRole server;
assert pkgs.lib.hasPrefix "${sentinel}\ndo\n" client;
assert pkgs.lib.hasSuffix "\nend\n" client;
assert count sentinel client == 1;
assert count startCall client == 1;
assert count ''local role = "client"'' client == 1;
assert count "local snapshotCommand = ${snapshotLiteral}" client == 1;
assert count "builtins.toJSON" renderSource == 2;
assert pkgs.lib.all (needle: count needle client == 0) runtimeFileReads;
assert builtins.getContext client == expectedHelperContext;
assert builtins.length (builtins.attrNames expectedHelperContext) == 1;
assert builtins.unsafeDiscardStringContext contextualRole == "client";
assert builtins.getContext contextualRole == builtins.getContext unrelatedHelper.outPath;
assert contextualClient == client;
assert builtins.getContext contextualClient == expectedHelperContext;
assert builtins.getContext equivalentCommand == expectedHelperContext;
assert builtins.getContext forgedCommand == expectedHelperContext;
assert
  builtins.unsafeDiscardStringContext forgedCommand
  != builtins.unsafeDiscardStringContext snapshotCommand;
assert
  builtins.unsafeDiscardStringContext extraContextCommand
  == builtins.unsafeDiscardStringContext snapshotCommand;
assert builtins.getContext extraContextCommand != expectedHelperContext;
assert rejected (render {
  role = "peer";
  inherit snapshotCommand;
});
assert rejected (render {
  role = "client";
  snapshotCommand = contextlessCommand;
});
assert rejected (render {
  role = "client";
  snapshotCommand = "${coordinatedAliasHelper}/bin/deskflow-process-snapshot";
});
assert rejected (render {
  role = "server";
  snapshotCommand = "${sameNameHelper}/bin/deskflow-process-snapshot";
});
assert rejected (render {
  role = "server";
  snapshotCommand = "${overrideHelper}/bin/deskflow-process-snapshot";
});
assert rejected (render {
  role = "client";
  snapshotCommand = "${unrelatedHelper}/bin/deskflow-process-snapshot";
});
assert rejected (render {
  role = "client";
  snapshotCommand = "${multiOutputHelper.out}/bin/deskflow-process-snapshot";
});
assert rejected (render {
  role = "server";
  snapshotCommand = "${multiOutputHelper.extra}/bin/deskflow-process-snapshot";
});
assert rejected (render {
  role = "client";
  snapshotCommand = extraContextCommand;
});
assert rejected (render {
  role = "server";
  snapshotCommand = forgedCommand;
});
assert rejected (render {
  role = "client";
  snapshotCommand = injectedCommand;
});
pkgs.runCommand "hammerspoon-deskflow-watchdog-render-test"
  {
    nativeBuildInputs = [ pkgs.lua5_4 ];
  }
  ''
    luac -p ${clientLua}
    luac -p ${serverLua}
    lua ${./render.test.lua} \
      ${./fake-hs.lua} \
      ${clientLua} \
      ${serverLua} \
      ${pkgs.lib.escapeShellArg snapshotCommand}
    touch "$out"
  ''
