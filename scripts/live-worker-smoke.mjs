#!/usr/bin/env node

import { spawn } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

const EXPECTED_PROFILES = [
	{ name: "codex-mini", require: [] },
	{ name: "claude-opus", require: ["tools"] },
	{ name: "copilot-sonnet", require: ["tools"] },
	{ name: "gemini-flash", require: ["tools"] },
];

if (process.env.CLIO_LIVE_WORKER_SMOKE !== "1") {
	console.log("Live worker smoke is opt-in and was not run.");
	console.log("Build first, then run with: CLIO_LIVE_WORKER_SMOKE=1 npm run smoke:workers:live");
	console.log("Optional: CLIO_SMOKE_WORKER_PROFILE=codex-mini to run one profile.");
	process.exit(0);
}

if (!process.stdin.isTTY) {
	console.error("Live worker smoke requires an interactive TTY.");
	process.exit(2);
}

const selected = process.env.CLIO_SMOKE_WORKER_PROFILE
	? EXPECTED_PROFILES.filter((profile) => profile.name === process.env.CLIO_SMOKE_WORKER_PROFILE)
	: EXPECTED_PROFILES;

if (selected.length === 0) {
	console.error(`Unknown CLIO_SMOKE_WORKER_PROFILE=${process.env.CLIO_SMOKE_WORKER_PROFILE}`);
	process.exit(2);
}

const rl = createInterface({ input, output });
try {
	console.log("This will invoke configured live CLIs and may consume provider quota.");
	console.log(`Profiles: ${selected.map((profile) => profile.name).join(", ")}`);
	const confirm = (await rl.question("Run live smoke now? Type yes to continue: ")).trim().toLowerCase();
	if (confirm !== "yes") {
		console.log("Cancelled.");
		process.exit(0);
	}

	for (const profile of selected) {
		const args = [
			"dist/cli/index.js",
			"run",
			"--worker-profile",
			profile.name,
			"--agent",
			"scout",
			"--json",
			...profile.require.flatMap((capability) => ["--require", capability]),
			`Live smoke for ${profile.name}: reply with exactly one short sentence confirming the worker profile name.`,
		];
		console.log(`\n== ${profile.name} ==`);
		const code = await run(process.execPath, args);
		if (code !== 0) {
			console.error(`profile ${profile.name} failed with exit code ${code}`);
			process.exit(code ?? 1);
		}
	}
	console.log("\nLive worker smoke completed.");
} finally {
	rl.close();
}

function run(command, args) {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: "inherit" });
		child.on("close", (code) => resolve(code));
		child.on("error", (error) => {
			console.error(error.message);
			resolve(1);
		});
	});
}
