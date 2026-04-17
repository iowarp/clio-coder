import { initializeClioHome } from "../core/init.js";
import { printHeader, printOk } from "./shared.js";

export function runInstallCommand(): number {
	const report = initializeClioHome();
	printHeader("clio install");
	process.stdout.write(`config dir  ${report.configDir}\n`);
	process.stdout.write(`data dir    ${report.dataDir}\n`);
	process.stdout.write(`cache dir   ${report.cacheDir}\n`);
	if (report.createdPaths.length === 0) {
		printOk("already installed, nothing to do");
	} else {
		printOk(`created ${report.createdPaths.length} paths`);
		for (const p of report.createdPaths) process.stdout.write(`  + ${p}\n`);
	}
	process.stdout.write(
		[
			"",
			"clio installed. Configure a provider before running workers:",
			"  $ clio providers               # shows configured + empty engines",
			"  $ $EDITOR ~/.clio/settings.yaml  # add providers.<engine>.endpoints",
			"For a no-provider smoke test, use `clio run <agent> <task> --faux`.",
			"",
		].join("\n"),
	);
	return 0;
}
