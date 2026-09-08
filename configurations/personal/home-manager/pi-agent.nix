{
  programs.pi-agent = {
    enable = true;

    agentMemory = {
      restPort = 3111;
      secretReference = "agentmemory-bearer";
    };

    provider = {
      mode = "personal";
      defaultModel = {
        provider = "openai";
        modelId = "gpt-5.6-sol";
      };
    };

    sandbox.defaultState = "audit";
  };
}
