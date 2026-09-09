import { resolve } from "node:path";
import { readSettings } from "../core/config.js";
import { loadSkills, modelVisibleSkills, skillCatalogValidity } from "../domains/resources/index.js";
import { formatColumns } from "./shared.js";

/** Runtime discovery is a read surface of the library; package mutations live in library.ts. */
export function runSkillsRead(args: ReadonlyArray<string>): number {
	const command = args[0];
	const positional = args.slice(1).filter((arg) => !arg.startsWith("-"));
	const json = args.includes("--json");
	if (
		(command !== "list" && command !== "validate") ||
		args.slice(1).some((arg) => arg.startsWith("-") && arg !== "--json" && arg !== "--all") ||
		positional.length > (command === "list" ? 0 : 1)
	) {
		process.stderr.write("usage: clio-coder library skills [--all] [--json], or library validate <SKILL.md> [--json]\n");
		return 2;
	}
	const list = loadSkills(
		command === "validate" && positional[0]
			? { disableDiscovery: true, explicitSkillPaths: [resolve(positional[0])] }
			: { cwd: process.cwd(), trustProjectCompatRoots: readSettings().integrations.projectResources.trustProjectImports },
	);
	const skills = command === "validate" || args.includes("--all") ? list.items : modelVisibleSkills(list.items);
	const valid =
		command === "validate" ? skillCatalogValidity(list).ok : !list.diagnostics.some((diag) => diag.type === "error");
	if (json)
		process.stdout.write(
			`${JSON.stringify({ ...(command === "validate" ? { ok: valid } : {}), skills, diagnostics: list.diagnostics }, null, 2)}\n`,
		);
	else {
		process.stdout.write(
			formatColumns([
				["name", "scope", "source", "trust", "invoke", "description"],
				...skills.map((skill) => [
					skill.name,
					skill.scope,
					skill.source,
					skill.trusted ? "trusted" : "untrusted",
					skill.disableModelInvocation ? "manual" : "model",
					skill.description,
				]),
			]),
		);
		for (const diagnostic of list.diagnostics) process.stderr.write(`${diagnostic.type}: ${diagnostic.message}\n`);
	}
	return valid ? 0 : 1;
}
