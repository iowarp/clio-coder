import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { packageManager } from "./package-manager.js";

/**
 * One value the repository itself declares: the package manager its lockfile
 * selects, the runner its test script invokes, its formatter, TypeScript
 * strictness and Node engine. A handbook rule asserting another value is
 * contradicted by the tree and never adopted.
 */
export interface TreeFact {
	key: TreeFactKey;
	value: string;
	/** Where the value was read, for the ledger and the adoption conflict report. */
	source: string;
}

export type TreeFactKey = "package-manager" | "test-runner" | "formatter" | "ts-strict" | "node-engine" | "scripts";

const LOCKFILES: ReadonlyArray<readonly [string, string]> = [
	["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"],
	["bun.lock", "bun"],
	["bun.lockb", "bun"],
	["package-lock.json", "npm"],
];

function readJson(path: string): Record<string, unknown> | null {
	try {
		if (!statSync(path).isFile() || statSync(path).size > 1024 * 1024) return null;
		// tsconfig and biome files allow comments and trailing commas.
		const text = readFileSync(path, "utf8")
			.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_match, string?: string) => string ?? "")
			.replace(/,(\s*[}\]])/g, "$1");
		const parsed: unknown = JSON.parse(text);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

const RUNNER_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[/\bvitest\b/, "vitest"],
	[/\bjest\b/, "jest"],
	[/\bmocha\b/, "mocha"],
	[/\b(?:node|tsx)\b[^&|;]*\s--test\b/, "node:test"],
	[/\bpytest\b/, "pytest"],
	[/\bcargo test\b/, "cargo test"],
	[/\bgo test\b/, "go test"],
];

function runnerOf(command: string): string | undefined {
	return RUNNER_PATTERNS.find(([pattern]) => pattern.test(command))?.[1];
}

/** The deterministic facts of the tree at `cwd`; `ciCommands` are the CI run lines already inventoried. */
export function treeFacts(cwd: string, ciCommands: ReadonlyArray<string> = []): TreeFact[] {
	const facts: TreeFact[] = [];
	const manifest = readJson(join(cwd, "package.json"));
	const lockfile = LOCKFILES.find(([file]) => existsSync(join(cwd, file)));
	if (manifest !== null || lockfile !== undefined) {
		const declared = typeof manifest?.packageManager === "string";
		facts.push({
			key: "package-manager",
			value: packageManager(cwd),
			source: declared ? "package.json packageManager" : (lockfile?.[0] ?? "package.json"),
		});
	}
	const scripts =
		manifest?.scripts !== null && typeof manifest?.scripts === "object" && !Array.isArray(manifest?.scripts)
			? Object.fromEntries(
					Object.entries(manifest.scripts as Record<string, unknown>).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				)
			: {};
	const testCommands = [
		...Object.entries(scripts)
			.filter(([name]) => name === "test" || name.startsWith("test:"))
			.map(([name, command]) => ({ command, source: `package.json scripts.${name}` })),
		...ciCommands.map((command) => ({ command, source: "CI" })),
	];
	const runners = new Map<string, string>();
	for (const { command, source } of testCommands) {
		const runner = runnerOf(command);
		if (runner !== undefined && !runners.has(runner)) runners.set(runner, source);
	}
	// Two runners in one tree leave no single value a rule could contradict.
	if (runners.size === 1) {
		const [value, source] = [...runners][0] ?? ["", ""];
		facts.push({ key: "test-runner", value, source });
	}
	const biome = ["biome.json", "biome.jsonc"].find((file) => existsSync(join(cwd, file)));
	const prettier =
		[".prettierrc", ".prettierrc.json", ".prettierrc.js", ".prettierrc.yaml", "prettier.config.js"].find((file) =>
			existsSync(join(cwd, file)),
		) ?? (manifest?.prettier !== undefined ? "package.json prettier" : undefined);
	if (biome !== undefined && prettier === undefined) facts.push({ key: "formatter", value: "biome", source: biome });
	if (prettier !== undefined && biome === undefined)
		facts.push({ key: "formatter", value: "prettier", source: prettier });
	const compilerOptions = readJson(join(cwd, "tsconfig.json"))?.compilerOptions;
	if (compilerOptions !== null && typeof compilerOptions === "object") {
		const strict = (compilerOptions as Record<string, unknown>).strict;
		if (typeof strict === "boolean") facts.push({ key: "ts-strict", value: String(strict), source: "tsconfig.json" });
	}
	const engines = manifest?.engines;
	if (engines !== null && typeof engines === "object") {
		const node = (engines as Record<string, unknown>).node;
		if (typeof node === "string") facts.push({ key: "node-engine", value: node, source: "package.json engines.node" });
	}
	if (Object.keys(scripts).length > 0)
		facts.push({ key: "scripts", value: Object.keys(scripts).join(", "), source: "package.json scripts" });
	return facts;
}

const VERB = String.raw`\b(?:always\s+|must\s+|should\s+|prefer\s+|use\s+|run\s+)*(?:use|prefer|run|format with|formatted with)\s+`;

const NEGATION_RE =
	/\b(?:not|never|no longer|avoid|instead of|rather than)\b|\b(?:don|doesn|isn|aren|shouldn|mustn)['’]?t\b/;

/**
 * The first of `values` a rule asserts in a clause that does not negate it: "Do
 * not use npm; use pnpm" asserts pnpm, and "Never use yarn" asserts nothing.
 */
function assertedValue(normalized: string, values: string): string | undefined {
	for (const match of normalized.matchAll(new RegExp(`${VERB}(${values})\\b`, "g"))) {
		const clause =
			normalized
				.slice(0, match.index)
				.split(/[;,:.!?]\s/)
				.at(-1) ?? "";
		if (!NEGATION_RE.test(clause)) return match[1];
	}
	return undefined;
}

/** The tree-fact values a rule asserts, for the keys the table can check. */
export function factClaims(text: string): Array<{ key: TreeFactKey; value: string }> {
	const normalized = text.toLowerCase().replace(/`/g, "");
	const claims: Array<{ key: TreeFactKey; value: string }> = [];
	const manager = assertedValue(normalized, "pnpm|npm|yarn|bun");
	if (manager) claims.push({ key: "package-manager", value: manager });
	const runner = assertedValue(normalized, "node:test|vitest|jest|mocha|pytest|cargo test|go test");
	if (runner) claims.push({ key: "test-runner", value: runner });
	const formatter = assertedValue(normalized, "prettier|biome");
	if (formatter) claims.push({ key: "formatter", value: formatter });
	if (/\bstrict(?:\s+mode)?\s+(?:is\s+)?(?:off|disabled)\b|\bstrict"?\s*:\s*false\b|\bnot\s+strict\b/.test(normalized))
		claims.push({ key: "ts-strict", value: "false" });
	else if (/\bstrict(?:\s+mode)?\s+(?:is\s+)?(?:on|enabled)\b|\bstrict"?\s*:\s*true\b/.test(normalized))
		claims.push({ key: "ts-strict", value: "true" });
	const node = /\bnode(?:\.js)?\s*(?:v|>=\s*|version\s+)?(\d{1,2})(?:\.\d+)*\b/.exec(normalized)?.[1];
	if (node) claims.push({ key: "node-engine", value: node });
	return claims;
}

/** Whether a claimed value disagrees with a fact of the same key. */
function claimContradicts(claim: { key: TreeFactKey; value: string }, fact: TreeFact): boolean {
	if (claim.key !== fact.key) return false;
	if (claim.key === "node-engine") {
		// A rule naming a Node major below the engine's minimum states a version the tree refuses.
		const minimum = Number(/\d+/.exec(fact.value)?.[0] ?? Number.NaN);
		return Number.isFinite(minimum) && Number(claim.value) < minimum;
	}
	return claim.value !== fact.value;
}

/** The first tree fact a rule contradicts. */
export function contradictingFact(text: string, facts: ReadonlyArray<TreeFact>): TreeFact | undefined {
	for (const claim of factClaims(text)) {
		const fact = facts.find((candidate) => claimContradicts(claim, candidate));
		if (fact) return fact;
	}
	return undefined;
}
