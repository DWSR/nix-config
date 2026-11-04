{
  lib,
  pkgs,
  ...
}:
let
  flySkills = pkgs.fetchFromGitHub {
    owner = "superfly";
    repo = "skills";
    rev = "ba182c9ba6ffa5b107d5f7c77e0a2c37eeef89d3";
    hash = "sha256-9LZLKVcQLJIXxFTeAFYyefWejlU2wiYCQLTuGNC9/nA=";
  };
  flySkill = "${flySkills}/plugins/fly/skills/fly";
in
{
  # Share the pinned operations skill and its references between both clients.
  xdg.configFile."opencode/skills/fly".source = flySkill;
  programs.pi.coding-agent.skills = lib.mkAfter [ flySkill ];
}
