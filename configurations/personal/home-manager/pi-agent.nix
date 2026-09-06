{
  programs.pi-agent = {
    enable = true;

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
