import type { buildCustomizationGraph, CustomizationEntry } from "./config-inspect.js";
import { parseCommandFlags } from "./kit/flags.js";
import { helpRequested } from "./kit/help.js";
import { writeCliFailure } from "./kit/json-out.js";

type CustomizationGraph = ReturnType<typeof buildCustomizationGraph>;

type ConfigLeaf = "get" | "set" | "unset";
const LEAVES: ReadonlySet<string> = new Set<ConfigLeaf>(["get", "set", "unset"]);

/**
 * The help text, from the spec module that `help --json` also loads. Only
 * import() reaches ./specs/config.js, so the build keeps it one file instead of
 * a re-export stub over a shared chunk, and `help --json` loads one file for it.
 */
async function configHelp(leaf?: ConfigLeaf): Promise<string> {
	const specs = await import("./specs/config.js");
	if (leaf === "get") return specs.CONFIG_GET_HELP;
	if (leaf === "set") return specs.CONFIG_SET_HELP;
	if (leaf === "unset") return specs.CONFIG_UNSET_HELP;
	return specs.CONFIG_HELP;
}

function renderText(cwd: string, graph: CustomizationGraph): string {
	const out: string[] = [`Effective customization for ${cwd}`, ""];

	out.push("Settings (only keys a layer set; everything else is built-in):");
	if (graph.settings.length === 0) out.push("  (none; all built-in defaults)");
	// An ignored layer explains a value better than the value does. Left to the
	// trailing Issues block, an untrusted project file read as a setting that
	// silently failed to apply.
	for (const issue of graph.issues) if (issue.startsWith("settings ")) out.push(`  ! ${issue}`);
	for (const entry of graph.settings) {
		out.push(`  ${entry.key} = ${JSON.stringify(entry.value)}  [${entry.source}]`);
		if (entry.note !== undefined) out.push(`    ${entry.note}`);
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
			if ((entry.id === "safety.policy" || entry.id === "safety.limits") && entry.detail !== undefined)
				out.push(`    ${JSON.stringify(entry.detail)}`);
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

/** Flags whose next token is their value, so it is never read as the verb. */
const VALUE_FLAGS = new Set(["--hash", "--scope"]);

function verbIndex(args: ReadonlyArray<string>): number {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] as string;
		if (arg === "--") return -1;
		if (VALUE_FLAGS.has(arg)) {
			i += 1;
			continue;
		}
		if (!arg.startsWith("-")) return i;
	}
	return -1;
}

/**
 * `config` reads its verb from the first positional, so a flag may sit on
 * either side of it: `config --json trust safety` and `config trust safety
 * --json` are one request (I-12). Help never loads an implementation (C1).
 */
export async function runConfigCommand(args: ReadonlyArray<string> = []): Promise<number> {
	const at = verbIndex(args);
	const sub = at === -1 ? "inspect" : (args[at] as string);
	const rest = at === -1 ? [...args] : [...args.slice(0, at), ...args.slice(at + 1)];
	if (sub === "trust") {
		if (helpRequested(rest)) {
			process.stdout.write(await configHelp());
			return 0;
		}
		return (await import("./config-trust.js")).runConfigTrustCommand(rest);
	}
	if (LEAVES.has(sub)) {
		if (helpRequested(rest)) {
			process.stdout.write(await configHelp(sub as ConfigLeaf));
			return 0;
		}
		return (await import("./config-set.js")).runConfigSettingCommand(sub as ConfigLeaf, rest);
	}
	if (helpRequested(args)) {
		process.stdout.write(await configHelp());
		return 0;
	}
	if (sub !== "inspect") {
		writeCliFailure({ path: ["config"], slug: "unknown_command", message: `unknown subcommand: ${sub}`, json: false });
		return 2;
	}
	const parsed = parseCommandFlags(rest, { json: { kind: "boolean" } });
	if (!parsed.ok || parsed.positional.length > 0) {
		const message = parsed.ok ? `unexpected argument: ${parsed.positional[0]}` : parsed.message;
		writeCliFailure({
			path: ["config", "inspect"],
			slug: parsed.ok ? "usage" : parsed.slug,
			message,
			json: rest.includes("--json"),
		});
		return 2;
	}
	const { buildCustomizationGraph } = await import("./config-inspect.js");
	const cwd = process.cwd();
	const graph = buildCustomizationGraph(cwd);
	if (parsed.flags.json === true) {
		process.stdout.write(`${JSON.stringify(graph, null, 2)}\n`);
		return 0;
	}
	process.stdout.write(renderText(cwd, graph));
	return 0;
}
