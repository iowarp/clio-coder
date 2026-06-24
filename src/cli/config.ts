import { buildCustomizationGraph, type CustomizationEntry } from "./config-inspect.js";
import { printError } from "./shared.js";

const HELP = `clio config inspect [--json]

Print the effective-customization graph: what settings, context files, rules,
skills, prompts, agents, extensions, safety, memory, hooks, and the operator
profile loaded, from where, with what precedence, trust, reload class, and
context cost. Read-only; nothing is created.

This is the "why is Clio behaving this way" surface. Parse the --json form in
scripts instead of the table.
`;

function renderText(cwd: string): string {
	const graph = buildCustomizationGraph(cwd);
	const out: string[] = [`Effective customization for ${cwd}`, ""];

	out.push("Settings (only keys a layer set; everything else is built-in):");
	if (graph.settings.length === 0) out.push("  (none; all built-in defaults)");
	for (const entry of graph.settings) {
		out.push(`  ${entry.key} = ${JSON.stringify(entry.value)}  [${entry.source}]`);
	}
	out.push("");

	const byCategory = new Map<string, CustomizationEntry[]>();
	for (const entry of graph.entries) {
		const list = byCategory.get(entry.category) ?? [];
		list.push(entry);
		byCategory.set(entry.category, list);
	}
	for (const [category, entries] of byCategory) {
		out.push(`${category}:`);
		for (const entry of entries) {
			const cost = entry.contextCostTokens !== undefined ? `, ~${entry.contextCostTokens} tok` : "";
			const hash = entry.hash ? `, #${entry.hash}` : "";
			const precedence = entry.precedence ? `, ${entry.precedence}` : "";
			out.push(`  ${entry.id}  [${entry.scope}${precedence}, reload:${entry.reloadClass}${hash}${cost}]`);
			if (entry.sourcePath) out.push(`    from ${entry.sourcePath}`);
		}
		out.push("");
	}

	if (graph.issues.length > 0) {
		out.push("Issues:");
		for (const issue of graph.issues) out.push(`  - ${issue}`);
		out.push("");
	}
	return `${out.join("\n").trimEnd()}\n`;
}

export function runConfigCommand(args: ReadonlyArray<string> = []): number {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const positional = args.filter((arg) => !arg.startsWith("-"));
	const sub = positional[0] ?? "inspect";
	if (sub !== "inspect") {
		printError(`unknown config subcommand: ${sub}`);
		process.stdout.write(HELP);
		return 2;
	}
	const json = args.includes("--json");
	const cwd = process.cwd();
	if (json) {
		process.stdout.write(`${JSON.stringify(buildCustomizationGraph(cwd), null, 2)}\n`);
		return 0;
	}
	process.stdout.write(renderText(cwd));
	return 0;
}
