const scenarioArgument = Deno.args.find((argument) => argument.startsWith("--scenario="));
const scenario = scenarioArgument?.slice("--scenario=".length) ?? "valid";
const separator = Deno.args.indexOf("--");
const commandArgs = separator < 0 ? [] : Deno.args.slice(separator + 1);
const command = commandArgs.join(" ");

if (scenario === "partial" && command === "models --json --offline") {
	await Deno.stderr.write(new TextEncoder().encode("private provider diagnostic token=sk-routing-secret"));
	Deno.exit(19);
}

let payload: unknown;
if (command === "models --json --offline") {
	payload = [
		{
			targetId: "lab",
			runtimeId: "lmstudio",
			modelId: "qwen3.8-27b",
			caps: "CTR----",
			contextWindow: 262_144,
			maxTokens: 32_768,
			reasoning: true,
			state: "loaded",
			baseUrl: "https://operator:secret@example.invalid/v1",
		},
		{
			targetId: "empty-target",
			runtimeId: "openai-compatible",
			modelId: "(no models)",
			caps: "C------",
			contextWindow: 0,
			maxTokens: 0,
			reasoning: false,
			state: "-",
		},
		{ malformed: true },
	];
} else if (command === "targets profile list --json") {
	payload = [
		{
			name: "deep-research",
			target: "lab",
			runtime: "lmstudio",
			model: "qwen3.8-27b",
			thinkingLevel: "high",
			credentialPath: "/home/operator/.clio-coder/credentials.json",
		},
		{ name: "fallback", thinkingLevel: "off" },
	];
} else if (command === "targets profile bindings --json") {
	payload = [
		{
			agentId: "researcher",
			profile: "deep-research",
			target: "lab",
			model: "qwen3.8-27b",
			warning: null,
			diagnostic: "private /home/operator binding detail",
		},
		{ agentId: "critic", profile: "missing-profile", target: null, model: null, warning: "missing profile" },
	];
} else {
	Deno.exit(23);
}

await Deno.stdout.write(new TextEncoder().encode(JSON.stringify(payload)));
