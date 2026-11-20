import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clioProjectRoot } from "../core/project-root.js";
import { discoverDeclaredProjectCommands } from "../tools/verify/authoring.js";
import { jsonDocument, writeCliFailure } from "./kit/json-out.js";

function quoted(value: string): string {
	return JSON.stringify(value);
}

export function runPlaybookCommands(argv: ReadonlyArray<string>): number {
	const json = argv.includes("--json");
	const args = argv.filter((arg) => arg !== "--json");
	if (args.length !== 1 || args[0] !== "init") {
		const stray = args.find((arg) => arg.startsWith("-"));
		writeCliFailure({
			path: ["playbook", "commands", ...(args[0] === "init" ? ["init"] : [])],
			slug: stray !== undefined ? "unknown_flag" : "usage",
			message: stray !== undefined ? `unknown flag: ${stray}` : "the only commands verb is init",
			json,
		});
		return 2;
	}
	const destination = join(
		clioProjectRoot(process.cwd(), join("playbooks", "commands.yaml")),
		".clio-coder",
		"playbooks",
		"commands.yaml",
	);
	if (existsSync(destination)) {
		writeCliFailure({
			path: ["playbook", "commands", "init"],
			slug: "io",
			message: `destination already exists: ${destination}`,
			json,
		});
		return 2;
	}
	const entries = discoverDeclaredProjectCommands(process.cwd());
	const lines = [
		"# Draft playbook command registry.",
		"# Every entry was discovered from a project declaration. Uncommenting an entry confirms its exact invocation.",
		"# The builtin build-test and sdlc playbooks run the ids test and commit, so rename an entry to the id a playbook needs.",
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
	process.stdout.write(json ? `${JSON.stringify(jsonDocument({ path: destination }))}\n` : `${destination}\n`);
	return 0;
}
