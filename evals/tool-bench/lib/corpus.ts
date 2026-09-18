/**
 * Seeded scenario corpus for the tool bench.
 *
 * The one scenario table has a tool dimension: CORPORA maps each tool to its
 * template table and builder in corpus-<tool>.ts. Every scenario is a pure
 * function of (tool, seed, split, template), and its id is
 * <tool>.<split>.<template>. The random stream for one scenario is sfc32 keyed
 * by the SHA-256 of the corpus schema, the tool, the split name, the seed, and
 * the template key, so the search and holdout splits draw from disjoint
 * streams and carry disjoint scenario ids. Nothing here reads the clock, the
 * environment, or Math.random.
 *
 * CLI: node --import tsx evals/tool-bench/lib/corpus.ts --seed <int> --split search|holdout
 *        [--tool edit|read|write] [--profile default|full] [--out <dir>]
 * Prints one JSON line per scenario (id, content hash, file bytes) and, with
 * --out, writes each scenario's files under <dir>/<scenario id>/. Without
 * --tool it lists every tool.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BenchTool, DEFAULT_SEED, PROFILES, type Profile, SPLITS, type Split, TOOLS } from "./corpus-core.js";
import { EDIT_TEMPLATES, type EditScenario, generateEditScenario } from "./corpus-edit.js";
import { generateReadScenario, READ_TEMPLATES, type ReadScenario } from "./corpus-read.js";
import { generateWriteScenario, WRITE_TEMPLATES, type WriteScenario } from "./corpus-write.js";

export * from "./corpus-core.js";
export { EDIT_TEMPLATES, type EditCall, type EditScenario } from "./corpus-edit.js";
export { READ_TEMPLATES, type ReadCall, type ReadScenario } from "./corpus-read.js";
export { WRITE_TEMPLATES, type WriteCall, type WriteScenario } from "./corpus-write.js";

export type Scenario = EditScenario | ReadScenario | WriteScenario;

interface ToolCorpus {
	templates: ReadonlyArray<{ key: string; profile: Profile }>;
	generate(seed: number, split: Split, key: string): Scenario;
}

/**
 * The one scenario table, keyed by tool. Both splits and both profiles of
 * every tool come from it. Each default profile keeps one trial of its suite
 * under a minute; the full profiles add the 100 MB cases and overlapping
 * variants.
 */
export const CORPORA: Readonly<Record<BenchTool, ToolCorpus>> = {
	edit: { templates: EDIT_TEMPLATES, generate: generateEditScenario },
	read: { templates: READ_TEMPLATES, generate: generateReadScenario },
	write: { templates: WRITE_TEMPLATES, generate: generateWriteScenario },
};

const SCENARIO_ID = new RegExp(`^(${TOOLS.join("|")})\\.(${SPLITS.join("|")})\\.([a-z0-9-]+)$`, "u");

export function parseScenarioId(id: string): { tool: BenchTool; split: Split; key: string } {
	const match = SCENARIO_ID.exec(id);
	if (match === null) throw new Error(`not a tool-bench scenario id: ${id}`);
	return { tool: match[1] as BenchTool, split: match[2] as Split, key: match[3] as string };
}

export function templatesFor(tool: BenchTool, profile: Profile): Array<{ key: string; profile: Profile }> {
	return CORPORA[tool].templates.filter((template) => profile === "full" || template.profile === "default");
}

export function generateScenario(tool: BenchTool, seed: number, split: Split, key: string): Scenario {
	return CORPORA[tool].generate(seed, split, key);
}

export function generateCorpus(tool: BenchTool, seed: number, split: Split, profile: Profile = "default"): Scenario[] {
	return templatesFor(tool, profile).map((template) => generateScenario(tool, seed, split, template.key));
}

/** Hash over everything a scenario feeds the tool: its files and its call. */
export function scenarioContentHash(scenario: Scenario): string {
	const hash = createHash("sha256");
	for (const entry of scenario.files) {
		hash.update(`${entry.kind}\0${entry.path}\0`);
		if (entry.kind === "file") hash.update(`${entry.mode}\0`).update(entry.bytes);
		else if (entry.kind === "dir") hash.update(`${entry.mode}`);
		else hash.update(entry.target);
		hash.update("\0");
	}
	hash.update(JSON.stringify(scenario.args));
	return hash.digest("hex");
}

/**
 * Writes a scenario's files under root with explicit modes, so umask never
 * leaks in. Directory entries get their mode last, deepest first, so a
 * read-only directory still receives the entries listed inside it.
 */
export function materializeScenario(scenario: Scenario, root: string): void {
	for (const entry of scenario.files) {
		const target = join(root, entry.path);
		if (entry.kind === "dir") {
			mkdirSync(target, { recursive: true, mode: 0o755 });
			continue;
		}
		mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
		chmodSync(dirname(target), 0o755);
		if (entry.kind === "symlink") {
			symlinkSync(entry.target, target);
			continue;
		}
		writeFileSync(target, entry.bytes, { mode: entry.mode });
		chmodSync(target, entry.mode);
	}
	const dirs = scenario.files.filter((entry) => entry.kind === "dir");
	for (const entry of dirs.sort((left, right) => right.path.length - left.path.length)) {
		chmodSync(join(root, entry.path), entry.mode);
	}
}

export function parseCorpusArgs(argv: readonly string[]): {
	seed: number;
	split: Split;
	profile: Profile;
	rest: Map<string, string>;
} {
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i] as string;
		if (!flag.startsWith("--")) throw new Error(`unexpected argument: ${flag}`);
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
		values.set(flag.slice(2), value);
		i += 1;
	}
	const seedText = values.get("seed") ?? String(DEFAULT_SEED);
	if (!/^-?\d+$/u.test(seedText)) throw new Error(`--seed must be an integer: ${seedText}`);
	const split = values.get("split") ?? "search";
	if (!(SPLITS as readonly string[]).includes(split)) throw new Error(`--split must be search or holdout: ${split}`);
	const profile = values.get("profile") ?? "default";
	if (!(PROFILES as readonly string[]).includes(profile))
		throw new Error(`--profile must be default or full: ${profile}`);
	values.delete("seed");
	values.delete("split");
	values.delete("profile");
	return { seed: Number(seedText), split: split as Split, profile: profile as Profile, rest: values };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
	const { seed, split, profile, rest } = parseCorpusArgs(process.argv.slice(2));
	const out = rest.get("out");
	const only = rest.get("tool");
	rest.delete("out");
	rest.delete("tool");
	if (rest.size > 0) throw new Error(`unknown flags: ${[...rest.keys()].join(", ")}`);
	if (only !== undefined && !(TOOLS as readonly string[]).includes(only))
		throw new Error(`--tool must be one of ${TOOLS.join(", ")}: ${only}`);
	for (const tool of only === undefined ? TOOLS : [only as BenchTool]) {
		for (const scenario of generateCorpus(tool, seed, split, profile)) {
			if (out !== undefined) materializeScenario(scenario, join(out, scenario.id));
			const bytes = scenario.files.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.bytes.length : 0), 0);
			process.stdout.write(`${JSON.stringify({ id: scenario.id, contentHash: scenarioContentHash(scenario), bytes })}\n`);
		}
	}
}
