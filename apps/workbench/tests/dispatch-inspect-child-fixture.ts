const separator = Deno.args.indexOf("--");
const commandArgs = separator < 0 ? Deno.args : Deno.args.slice(separator + 1);
if (commandArgs.join("\u0000") !== "fleet\u0000status\u0000--json") Deno.exit(73);

console.log(JSON.stringify({
	generatedAt: "2026-08-30T14:01:28.728Z",
	admission: {
		state: "draining",
		requestedByPid: 98765,
		requestedAt: "2026-08-30T14:00:00.000Z",
		expiresAt: "2026-08-30T14:05:00.000Z",
	},
	running: [
		{
			runId: "run-secret-alpha",
			agentId: "researcher",
			node: "ssh-private-node",
			outcomePhase: "running",
			heartbeat: "alive",
			budget: { costUsd: 50 },
		},
		{
			runId: "run-secret-beta",
			agentId: "builder",
			node: "local",
			outcomePhase: "stale",
			heartbeat: "stale",
		},
		{
			runId: "run-secret-gamma",
			agentId: "reviewer",
			node: "local",
			outcomePhase: "running",
			heartbeat: "dead",
		},
	],
	retrying: [{ runId: "retry-secret", rawRequest: "never cross the protocol" }],
	totals: {
		inputTokens: 9_557_544,
		outputTokens: 517_406,
		totalTokens: 15_918_587,
		costUsd: 1.78098108,
		runtimeSeconds: 42_963.751,
	},
}));
