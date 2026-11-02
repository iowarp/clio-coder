import { isAbsolute, relative, resolve, sep } from "node:path";
import { readSettings } from "../core/config.js";
import {
	defaultSkillRoots,
	inactiveCopyRemedy,
	inactiveLibraryCopies,
	knownSkillNames,
	loadSkills,
	modelVisibleSkills,
	readLibraryInventory,
	skillAuthoringDiagnostics,
	skillCatalogValidity,
} from "../domains/resources/index.js";
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
	// Compatibility files remain inspectable with --all, but their diagnostics
	// do not describe the default inventory of usable Clio skills.
	const discoveryRoots =
		command === "validate" || args.includes("--all")
			? []
			: defaultSkillRoots()
					.filter((root) => root.source !== "clio-coder" && root.source !== "plugin")
					.map((root) => root.path);
	const diagnostics = list.diagnostics.filter((diagnostic) => {
		const diagnosticPath = diagnostic.path;
		return (
			!diagnosticPath ||
			!discoveryRoots.some((root) => {
				const rel = relative(root, diagnosticPath);
				return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
			})
		);
	});
	if (command === "validate") {
		const knownSkills = new Set([...knownSkillNames(process.cwd()), ...list.items.map((skill) => skill.name)]);
		for (const skill of list.items) diagnostics.push(...skillAuthoringDiagnostics(skill, { knownSkills }));
	}
	const skills = command === "validate" || args.includes("--all") ? list.items : modelVisibleSkills(list.items);
	const valid =
		command === "validate"
			? skillCatalogValidity(list).ok && !diagnostics.some((diag) => diag.type === "error")
			: !diagnostics.some((diag) => diag.type === "error");
	// A damaged, disabled or untrusted package loads no skills, so the rows above
	// cannot mention it; --all promises everything installed, loadable or not.
	const inactive =
		command === "list" && args.includes("--all")
			? inactiveLibraryCopies(
					readLibraryInventory({ cwd: process.cwd(), include: { packages: false, resources: false } }).copies,
				).filter((copy) => copy.kind === "skill" || copy.kind === "plugin")
			: [];
	if (json)
		process.stdout.write(
			`${JSON.stringify(
				{
					...(command === "validate" ? { ok: valid } : {}),
					skills,
					diagnostics,
					...(inactive.length > 0
						? {
								inactivePackages: inactive.map((copy) => ({
									ref: copy.ref,
									scope: copy.scope,
									state: copy.state,
									remedy: inactiveCopyRemedy(copy),
								})),
							}
						: {}),
				},
				null,
				2,
			)}\n`,
		);
	else {
		process.stdout.write(
			formatColumns([
				["name", "scope", "source", "trust", "invoke", "description"],
				...skills.map((skill) => [
					skill.name,
					skill.scope,
					skill.source,
					skill.trusted ? "trusted" : skill.source === "plugin" ? "requires trust" : "import required",
					!skill.trusted ? "inactive" : skill.disableModelInvocation ? "manual" : "model",
					skill.description,
				]),
				...inactive.map((copy) => [copy.name, copy.scope, "plugin", copy.state, "inactive", inactiveCopyRemedy(copy)]),
			]),
		);
		for (const diagnostic of diagnostics) process.stderr.write(`${diagnostic.type}: ${diagnostic.message}\n`);
	}
	return valid ? 0 : 1;
}
