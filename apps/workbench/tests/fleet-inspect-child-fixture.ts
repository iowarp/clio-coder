const separator = Deno.args.indexOf("--");
const commandArgs = separator < 0 ? Deno.args : Deno.args.slice(separator + 1);
if (commandArgs.join("\u0000") !== "fleet\u0000inspect\u0000--json") {
	Deno.exit(73);
}

console.log(JSON.stringify({
	version: 1,
	generatedAt: "2026-08-31T14:01:28.728Z",
	runs: [
		{
			runId: "run-alpha",
			agentId: "builder",
			model: "qwen3-coder",
			target: "local-lmstudio",
			node: "local",
			phase: "running",
			startedAt: "2026-08-31T14:00:00.000Z",
			elapsedMs: 88_728,
			task: "Inspect the durable event boundary",
			journal: "available",
			events: [
				{
					at: "2026-08-31T14:00:01.000Z",
					label: "run opened (builder)",
					detail: null,
				},
				{
					at: "2026-08-31T14:00:02.000Z",
					label: "tool started",
					detail: "read project files",
				},
			],
			eventsTruncated: false,
			evidence: {
				state: "pending",
				summary: "Receipt pending; this run has not finalized.",
			},
			outcome: null,
			outcomeDetail: null,
			terminal: false,
		},
	],
	truncated: false,
}));
