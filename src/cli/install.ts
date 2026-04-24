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
		"      add a local or cloud model endpoint",
		"  $ clio providers",
		"      print endpoint health and capabilities",
		"  $ clio list-models",
		"      list models discovered per endpoint",
		"  $ clio",
		"      start interactive repository chat",
		'  $ clio run --endpoint <id> --model <wireId> "<task>"',
		"      dispatch a one-shot worker",
	];
	if (!process.env.CLIO_HOME) {
		lines.push("Tip: export CLIO_HOME=$HOME/.clio to keep config, data, and cache under one tree.");
	}
	lines.push("");
	process.stdout.write(lines.join("\n"));
	return 0;
}
