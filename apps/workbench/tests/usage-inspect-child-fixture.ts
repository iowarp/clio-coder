const scenarioArgument = Deno.args.find((argument) => argument.startsWith("--scenario="));
const scenario = scenarioArgument?.slice("--scenario=".length) ?? "valid";
const separator = Deno.args.indexOf("--");
const commandArgs = separator < 0 ? [] : Deno.args.slice(separator + 1);
const expected = ["usage", "report", "--repo", Deno.cwd(), "--days", "30", "--json"];
if (commandArgs.length !== expected.length || commandArgs.some((argument, index) => argument !== expected[index])) {
	Deno.exit(23);
}

if (scenario === "bad-jsonl") {
	await Deno.stdout.write(new TextEncoder().encode('{"schema":"experimental"}\nnot-json\n'));
	Deno.exit(0);
}

if (scenario === "too-many") {
	const encoder = new TextEncoder();
	for (let index = 0; index < 513; index += 1) {
		await Deno.stdout.write(encoder.encode(`${JSON.stringify({ schema: "experimental", index })}\n`));
	}
	Deno.exit(0);
}

const common = {
	schema: "experimental",
	windowDays: 30,
	from: "2026-07-30T13:00:00.000Z",
	to: "2026-08-29T13:00:00.000Z",
};
const rows: unknown[] = scenario === "missing"
	? [
		{ ...common, kind: "fact", fact: "session-store-missing", path: "/home/operator/private/sessions" },
		{ ...common, kind: "fact", fact: "receipt-store-missing", path: "/home/operator/private/receipts" },
		{ ...common, kind: "fact", fact: "audit-tool-calls", value: 99, blocked: 7 },
		{ ...common, kind: "fact", fact: "memory", approved: 12, pending: 4 },
	]
	: [
		{ ...common, kind: "fact", fact: "sessions", value: 3 },
		{ ...common, kind: "fact", fact: "dispatch-runs", value: 2 },
		{ ...common, kind: "fact", fact: "audit-tool-calls", value: 99, blocked: 7 },
		{
			...common,
			kind: "fact",
			fact: "tokens",
			apiCalls: 42,
			input: 8_500_000,
			output: 1_200_000,
			cacheRead: 3_400_000,
			cacheWrite: 22_000,
			reasoningTokens: 800_000,
			totalTokens: 13_922_000,
			costUsd: 4.125,
			turns: 38,
			sideQuestions: 3,
			handoffs: 1,
		},
		{
			...common,
			kind: "fact",
			fact: "model-usage",
			providerId: "lmstudio",
			attributedModelId: "qwen3.8-27b",
			requestedModelIds: ["private-requested-model"],
			responseModelIdObservationCounts: { observed: 1 },
			apiCalls: 42,
			input: 8_500_000,
			output: 1_200_000,
			cacheRead: 3_400_000,
			cacheWrite: 22_000,
			reasoningTokens: 800_000,
			totalTokens: 13_922_000,
			costUsd: 4.125,
		},
		{
			...common,
			kind: "fact",
			fact: "session-cache",
			sessionId: "session-global-secret",
			uncachedPrefillTokens: 123,
			verdictCounts: { hot: 1, partial: 0, cold: 0, small: 0 },
		},
		{ ...common, kind: "fact", fact: "top-tool", tool: "read", count: 17, ok: 16, errors: 1, blocked: 0 },
		{
			...common,
			kind: "fact",
			fact: "bash-shape",
			shape: "curl https://secret.example.invalid --header sk-secret",
			count: 8,
			sessions: 4,
		},
		{ ...common, kind: "fact", fact: "skill-activated", skill: "frontend-design", activations: 5 },
		{ ...common, kind: "fact", fact: "skill-never-activated", skill: "unused-private-skill" },
		{ ...common, kind: "fact", fact: "recipe-used", agentId: "researcher", runs: 4 },
		{
			...common,
			kind: "fact",
			fact: "failure-tag",
			tag: "private-cross-project-failure",
			count: 9,
			latestEvidenceId: "evidence-global-secret",
		},
		{ ...common, kind: "fact", fact: "memory", approved: 12, pending: 4 },
		{
			...common,
			kind: "opportunity",
			opportunity: "workflow-distiller",
			suggestion: "private bash shape /home/operator/project and session ids",
			evidence: "session-global-secret",
		},
		{
			...common,
			kind: "opportunity",
			opportunity: "recipe",
			suggestion: "private repeated task prompt",
			evidence: "run-private-0001",
		},
		{
			...common,
			kind: "opportunity",
			opportunity: "memory",
			suggestion: "global evidence should not cross",
			evidence: "evidence-global-secret",
		},
	];

const encoder = new TextEncoder();
for (const row of rows) await Deno.stdout.write(encoder.encode(`${JSON.stringify(row)}\n`));
