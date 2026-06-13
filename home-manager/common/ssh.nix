_: {
  programs.ssh = {
    enable = true;
    enableDefaultConfig = false;

    extraConfig = ''IdentityAgent "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"'';

    settings."*" = {
      ForwardAgent = false;
      AddKeysToAgent = "no";
      ControlMaster = "auto";
      ControlPath = "~/.ssh/master-%r@%n:%p";
      ControlPersist = "no";
      HashKnownHosts = false;
      UserKnownHostsFile = "~/.ssh/known_hosts";
      ServerAliveInterval = 0;
      ServerAliveCountMax = 3;
      Compression = true;
    };
  };
}
