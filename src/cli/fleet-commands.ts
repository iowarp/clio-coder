import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverDeclaredProjectCommands } from "../tools/verify/authoring.js";

function quoted(value: string): string {
	return JSON.stringify(value);
}

export function runFleetCommands(args: ReadonlyArray<string>): number {
	if (args.length !== 1 || args[0] !== "init") {
		process.stderr.write("clio-coder fleet: commands: usage: clio-coder fleet commands init\n");
		return 2;
	}
	const destination = join(process.cwd(), ".clio-coder", "fleets", "commands.yaml");
	if (existsSync(destination)) {
		process.stderr.write(`clio-coder fleet: commands init: destination already exists: ${destination}\n`);
		return 2;
	}
	const entries = discoverDeclaredProjectCommands(process.cwd());
	const lines = [
		"# Draft fleet command registry.",
		"# Every entry was discovered from a project declaration. Uncommenting an entry confirms its exact invocation.",
		"# version: 1",
		"# commands:",
	];
	for (const entry of entries) {
		lines.push(
			`#   ${entry.id}:`,
			`#     argv: [${entry.command.map(quoted).join(", ")}]`,
			`#     description: ${quoted(`Discovered from ${entry.provenance.path}: ${entry.provenance.detail}`)}`,
		);
	}
	mkdirSync(dirname(destination), { recursive: true });
	writeFileSync(destination, `${lines.join("\n")}\n`, { flag: "wx" });
	process.stdout.write(`${destination}\n`);
	return 0;
}
