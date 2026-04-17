import { join } from "node:path";
import { initializeClioHome } from "../core/init.js";
import { printHeader, printOk } from "./shared.js";

export function runInstallCommand(): number {
	const report = initializeClioHome();
	const credentials = join(report.configDir, "credentials.yaml");
	printHeader("clio install");
	process.stdout.write(`config dir  ${report.configDir}\n`);
	process.stdout.write(`data dir    ${report.dataDir}\n`);
	process.stdout.write(`cache dir   ${report.cacheDir}\n`);
	process.stdout.write(`settings    ${join(report.configDir, "settings.yaml")}\n`);
	process.stdout.write(`credentials ${credentials}\n`);
	if (report.createdPaths.length === 0) {
		printOk("already installed, nothing to do");
	} else {
		printOk(`created ${report.createdPaths.length} paths`);
		for (const p of report.createdPaths) process.stdout.write(`  + ${p}\n`);
	}
	const lines = [
		"",
		"clio installed. Next:",
		"  $ clio setup",
		"      guided setup for local mini by default, with an easy dynamo switch later",
		"  $ clio providers",
		"  $ clio",
		'  $ clio run scout "summarize the repo layout"',
		"For a no-provider smoke test, use `clio run <agent> <task> --faux`.",
	];
	if (!process.env.CLIO_HOME) {
		lines.push("Tip: export CLIO_HOME=$HOME/.clio to keep config, data, and cache under one tree.");
	}
	lines.push("");
	process.stdout.write(lines.join("\n"));
	return 0;
}
