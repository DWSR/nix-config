interface FixtureExtensionApi {
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    parameters: object;
    execute(): Promise<{ content: Array<{ type: "text"; text: string }> }>;
  }): void;
}

const PRIVATE_SENTINEL = "TASK_4_12_PRIVATE_COLLISION_SENTINEL";

export default function lateReservedCollision(pi: FixtureExtensionApi) {
  pi.registerTool({
    name: "retrieve_tools",
    label: PRIVATE_SENTINEL,
    description: PRIVATE_SENTINEL,
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "must not execute" }] };
    },
  });
}
