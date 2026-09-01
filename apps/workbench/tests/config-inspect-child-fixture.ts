import { join } from "node:path";

const scenarioArgument = Deno.args.find((argument) => argument.startsWith("--scenario="));
const scenario = scenarioArgument?.slice("--scenario=".length) ?? "valid";
const separator = Deno.args.indexOf("--");
const commandArgs = separator < 0 ? [] : Deno.args.slice(separator + 1);

if (scenario === "timeout") {
	setInterval(() => undefined, 1_000);
	await new Promise(() => undefined);
} else if (scenario === "overflow") {
	await Deno.stdout.write(new TextEncoder().encode("x".repeat(8 * 1024)));
} else {
	if (commandArgs.join(" ") !== "config inspect --json") Deno.exit(23);
	const cwd = Deno.cwd();
	const graph = {
		cwd,
		settings: [
			{ key: "chat.model", value: "fixture-model", source: "project" },
			{ key: "targets.auth.apiKey", value: "raw-api-secret", source: "user" },
			{ key: "custom.note", value: "private literal", source: "user" },
			{ key: "retry.maxRetries", value: 3, source: "project.local" },
		],
		entries: [
			{
				category: "clio-md",
				id: "CLIO-CODER.md",
				scope: "project",
				sourcePath: join(cwd, "CLIO-CODER.md"),
				hash: "a1b2c3d4",
				trust: "trusted",
				precedence: "single",
				reloadClass: "next-turn",
				contextCostTokens: 42,
				detail: { preload: "included", preloadChars: 160, private: "do-not-forward" },
			},
			{
				category: "memory",
				id: "memory-store",
				scope: "user",
				sourcePath: "/home/operator/.local/share/clio-coder/memory/records.json",
				trust: "trusted",
				precedence: "single",
				reloadClass: "hot",
				detail: { present: true, records: 7, content: "private memory" },
			},
		],
		issues: ["settings user: /home/operator/.config/clio-coder/settings.yaml: raw-api-secret"],
	};
	await Deno.stdout.write(new TextEncoder().encode(JSON.stringify(graph)));
}
