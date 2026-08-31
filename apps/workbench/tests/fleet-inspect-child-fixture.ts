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
	roots: [
		{
			rootId: "fleet-345ea2e6c1ad",
			fleet: "build-review",
			startedAt: "2026-08-31T13:59:00.000Z",
			elapsedMs: 148_728,
			running: true,
			resumedFrom: null,
			plannedSteps: 3,
			recordedSteps: 1,
			steps: [
				{
					stepId: "build",
					runId: "run-alpha",
					agentId: "builder",
					outcome: "running",
					detail: null,
				},
				{
					stepId: "review",
					runId: null,
					agentId: null,
					outcome: "not run",
					detail: null,
				},
				{
					stepId: "apply",
					runId: null,
					agentId: null,
					outcome: "not run",
					detail: null,
				},
			],
			stepsTruncated: false,
		},
	],
	rootsTruncated: false,
	councils: [
		{
			group: "council-mfa2x1-7b3d0e",
			startedAt: "2026-08-31T13:50:00.000Z",
			endedAt: "2026-08-31T13:58:00.000Z",
			running: false,
			roundsPlanned: 2,
			roundsObserved: 2,
			origin: "user",
			approval: "operator",
			members: [
				{
					label: "architect",
					agentId: "researcher",
					target: "local-lmstudio",
					model: "qwen3-coder",
					executionRole: "researcher",
					turns: [
						{ round: 1, runId: "run-council-a1", status: "completed", outcome: "succeeded", terminal: true },
						{ round: 2, runId: "run-council-a2", status: "completed", outcome: "succeeded", terminal: true },
					],
					turnsTruncated: false,
				},
				{
					label: "skeptic",
					agentId: "researcher",
					target: "blade-gateway",
					model: "glm-4.6",
					executionRole: "researcher",
					turns: [
						{ round: 1, runId: "run-council-s1", status: "completed", outcome: "succeeded", terminal: true },
						{ round: 2, runId: "run-council-s2", status: "failed", outcome: "timed_out", terminal: true },
					],
					turnsTruncated: false,
				},
			],
			membersTruncated: false,
			membersRejected: 0,
			synthesis: {
				kind: "judge",
				sealedRunId: "run-council-sealed",
				judge: {
					runId: "run-council-judge",
					agentId: "verifier",
					target: "local-lmstudio",
					model: "qwen3-coder",
					status: "completed",
					outcome: "succeeded",
				},
			},
		},
	],
	councilsTruncated: false,
}));
