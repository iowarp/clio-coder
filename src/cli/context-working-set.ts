import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { assertSafeId } from "../core/safe-id.js";
import { clioStatePath } from "../core/xdg.js";
import { DEFAULT_WORKING_SET_SETTINGS } from "../domains/context/working-set/defaults.js";
import { foldWorkingSet } from "../domains/context/working-set/fold.js";
import { buildPathIndex } from "../domains/context/working-set/path-index.js";
import { resolveWorkingSetPolicy } from "../domains/context/working-set/policies/index.js";
import { makeOraclePolicy, makeRandomPolicy, nonePolicy } from "../domains/context/working-set/replay/controls.js";
import { loadReplayTraces, type ReplayInputFormat } from "../domains/context/working-set/replay/load-claude-code.js";
import type { ReplayLoadCascade } from "../domains/context/working-set/replay/load-clio.js";
import { aggregateReplayMetrics, type ReplayMeasurement } from "../domains/context/working-set/replay/metrics.js";
import { buildReferenceGraph, type ReferenceGraph } from "../domains/context/working-set/replay/reference-graph.js";
import {
	type ReplayPolicyResult,
	type ReplayReportInput,
	renderReplayJson,
	renderReplayMarkdown,
} from "../domains/context/working-set/replay/report.js";
import { replayTrace } from "../domains/context/working-set/replay/runner.js";
import type { Trace } from "../domains/context/working-set/replay/trace.js";
import { parseSessionEntries } from "../domains/session/archive-readers.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";

const REPLAY_HELP = `Usage:
  clio-coder context replay --sessions <path>... [options]

Options:
  --policies <ids>    comma-separated none,random,age-horizon,structural-v1,oracle
  --budgets <tokens>  comma-separated budgets (default: 16000,32000,64000)
  --format <format>    clio, claude-code, or auto (default: auto)
  --threshold <ratio> pressure threshold (default: 0.8)
  --target <ratio>    post-eviction pressure target (default: 0.6)
  --seed <integer>    deterministic random-policy seed (default: 0)
  --no-filter         include every readable transcript
  --json <path>       write the stable JSON report
  --md <path>         write Markdown instead of printing it
`;

const WORKING_SET_HELP = `Usage:
  clio-coder context working-set --session <id|path>

Print the durable working-set fold and path-index summary for one Clio session.
`;

const POLICY_IDS = ["none", "random", "age-horizon", "structural-v1", "oracle"] as const;
type ReplayPolicyId = (typeof POLICY_IDS)[number];

class CliUsageError extends Error {}

interface ReplayArgs {
	sessions: string[];
	policies: ReplayPolicyId[];
	budgets: number[];
	threshold: number;
	target: number;
	seed: number;
	format: ReplayInputFormat;
	noFilter: boolean;
	jsonPath?: string;
	markdownPath?: string;
}

function commaValues(value: string, flag: string): string[] {
	const values = value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (values.length === 0) throw new CliUsageError(`${flag} requires at least one value`);
	return [...new Set(values)];
}

function numberValue(value: string, flag: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new CliUsageError(`${flag} requires a finite number`);
	return parsed;
}

function requiredValue(args: ReadonlyArray<string>, index: number, flag: string): string {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--")) throw new CliUsageError(`${flag} requires a value`);
	return value;
}

function policyResolves(id: ReplayPolicyId): boolean {
	if (id === "none" || id === "random" || id === "oracle") return true;
	try {
		resolveWorkingSetPolicy(id);
		return true;
	} catch {
		return false;
	}
}

function defaultPolicies(): ReplayPolicyId[] {
	return POLICY_IDS.filter(policyResolves);
}

function parseReplayArgs(args: ReadonlyArray<string>): ReplayArgs {
	const parsed: ReplayArgs = {
		sessions: [],
		policies: defaultPolicies(),
		budgets: [16_000, 32_000, 64_000],
		threshold: 0.8,
		target: 0.6,
		seed: 0,
		format: "auto",
		noFilter: false,
	};
	let policiesExplicit = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--no-filter") {
			parsed.noFilter = true;
			continue;
		}
		if (arg === "--sessions") {
			let consumed = 0;
			while (index + 1 < args.length && !args[index + 1]?.startsWith("--")) {
				parsed.sessions.push(args[index + 1] as string);
				index += 1;
				consumed += 1;
			}
			if (consumed === 0) throw new CliUsageError("--sessions requires at least one path");
			continue;
		}
		if (
			arg === "--policies" ||
			arg === "--budgets" ||
			arg === "--format" ||
			arg === "--threshold" ||
			arg === "--target" ||
			arg === "--seed"
		) {
			const value = requiredValue(args, index, arg);
			index += 1;
			if (arg === "--policies") {
				const values = commaValues(value, arg);
				const unknown = values.filter((entry) => !(POLICY_IDS as ReadonlyArray<string>).includes(entry));
				if (unknown.length > 0) throw new CliUsageError(`unknown replay policy: ${unknown.join(", ")}`);
				parsed.policies = values as ReplayPolicyId[];
				policiesExplicit = true;
			} else if (arg === "--budgets") {
				parsed.budgets = commaValues(value, arg).map((entry) => {
					const budget = numberValue(entry, arg);
					if (!Number.isInteger(budget) || budget <= 0) {
						throw new CliUsageError("--budgets values must be positive integers");
					}
					return budget;
				});
			} else if (arg === "--format") {
				if (value !== "clio" && value !== "claude-code" && value !== "auto") {
					throw new CliUsageError("--format must be clio, claude-code, or auto");
				}
				parsed.format = value;
			} else if (arg === "--threshold") {
				parsed.threshold = numberValue(value, arg);
				if (parsed.threshold <= 0 || parsed.threshold > 1) {
					throw new CliUsageError("--threshold must be greater than 0 and at most 1");
				}
			} else if (arg === "--target") {
				parsed.target = numberValue(value, arg);
				if (parsed.target <= 0 || parsed.target >= 1) {
					throw new CliUsageError("--target must be greater than 0 and less than 1");
				}
			} else {
				parsed.seed = numberValue(value, arg);
				if (!Number.isInteger(parsed.seed)) throw new CliUsageError("--seed must be an integer");
			}
			continue;
		}
		if (arg === "--json" || arg === "--md") {
			const value = requiredValue(args, index, arg);
			index += 1;
			if (arg === "--json") parsed.jsonPath = value;
			else parsed.markdownPath = value;
			continue;
		}
		throw new CliUsageError(`unknown flag ${arg}`);
	}
	if (parsed.sessions.length === 0) throw new CliUsageError("--sessions is required");
	if (parsed.target >= parsed.threshold) throw new CliUsageError("--target must be less than --threshold");
	if (policiesExplicit) {
		const unavailable = parsed.policies.filter((id) => !policyResolves(id));
		if (unavailable.length > 0) {
			throw new CliUsageError(`replay policy is not available in this build: ${unavailable.join(", ")}`);
		}
	}
	return parsed;
}

function policyForTrace(id: ReplayPolicyId, graph: ReferenceGraph, seed: number) {
	if (id === "none") return nonePolicy;
	if (id === "random") return makeRandomPolicy(seed);
	if (id === "oracle") return makeOraclePolicy(graph);
	return resolveWorkingSetPolicy(id);
}

function gitSha(): string | null {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: process.cwd(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

function exactCommandLine(): string[] {
	return [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
}

async function writeOutput(path: string, contents: string): Promise<string> {
	const output = resolve(path);
	await mkdir(dirname(output), { recursive: true });
	await writeFile(output, contents, "utf8");
	return output;
}

function cascadeLine(cascade: ReplayLoadCascade): string {
	const filtered = Object.entries(cascade.filtered)
		.map(([stage, count]) => `${stage}=${count}`)
		.join(" ");
	return `cascade found=${cascade.found} unreadable=${cascade.unreadable} ${filtered} kept=${cascade.kept}`;
}

export async function runContextReplayCommand(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(REPLAY_HELP);
		return 0;
	}
	let parsed: ReplayArgs;
	try {
		parsed = parseReplayArgs(args);
	} catch (error) {
		process.stderr.write(
			`clio-coder context replay: ${error instanceof Error ? error.message : String(error)}\n${REPLAY_HELP}`,
		);
		return 2;
	}
	try {
		const loaded = await loadReplayTraces(parsed.sessions, parsed.format, { filter: !parsed.noFilter });
		const indexed = loaded.traces.map((trace) => {
			const index = buildPathIndex(trace.entries);
			return { trace, index, graph: buildReferenceGraph(trace, index) };
		});
		const settings = { ...DEFAULT_WORKING_SET_SETTINGS, target: parsed.target };
		const results: ReplayPolicyResult[] = [];
		for (const budgetTokens of parsed.budgets) {
			for (const policyId of parsed.policies) {
				const measurements: ReplayMeasurement[] = indexed.map(({ trace, index, graph }) => ({
					trace,
					index,
					graph,
					replay: replayTrace(trace, policyForTrace(policyId, graph, parsed.seed), {
						policyId,
						budgetTokens,
						threshold: parsed.threshold,
						target: parsed.target,
						settings,
						seed: parsed.seed,
					}),
				}));
				results.push({ budgetTokens, policyId, metrics: aggregateReplayMetrics(measurements) });
			}
		}
		const report: ReplayReportInput = {
			config: {
				policies: parsed.policies,
				budgets: parsed.budgets,
				threshold: parsed.threshold,
				target: parsed.target,
				seed: parsed.seed,
				format: parsed.format,
				filter: parsed.noFilter ? "none" : "default",
				settings,
			},
			cascade: loaded.cascade,
			results,
			gitSha: gitSha(),
			commandLine: exactCommandLine(),
		};
		const markdown = renderReplayMarkdown(report);
		if (parsed.markdownPath === undefined) process.stdout.write(markdown);
		else {
			const path = await writeOutput(parsed.markdownPath, markdown);
			process.stdout.write(`${cascadeLine(loaded.cascade)}\nmarkdown ${path}\n`);
		}
		if (parsed.jsonPath !== undefined) {
			const path = await writeOutput(parsed.jsonPath, renderReplayJson(report));
			process.stdout.write(`json ${path}\n`);
		}
		return 0;
	} catch (error) {
		process.stderr.write(`clio-coder context replay failed: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

async function sessionPath(value: string): Promise<string> {
	const candidate = resolve(value);
	try {
		const facts = await stat(candidate);
		if (facts.isDirectory()) return join(candidate, "current.jsonl");
		if (facts.isFile()) return candidate;
	} catch {
		// A non-path value is resolved as a validated session id below.
	}
	try {
		assertSafeId(value, "session");
	} catch (error) {
		throw new CliUsageError(error instanceof Error ? error.message : String(error));
	}
	const sessionsRoot = join(clioStatePath(), "sessions");
	let cwdHashes: string[];
	try {
		cwdHashes = await readdir(sessionsRoot);
	} catch {
		throw new Error(`session not found: ${value}`);
	}
	for (const cwdHash of cwdHashes.sort()) {
		const current = join(sessionsRoot, cwdHash, value, "current.jsonl");
		try {
			if ((await stat(current)).isFile()) return current;
		} catch {
			// Continue across repositories until the id is found.
		}
	}
	throw new Error(`session not found: ${value}`);
}

async function pinnedLeafForSession(source: string): Promise<string | undefined> {
	try {
		const raw = await readFile(join(dirname(source), "meta.json"), "utf8");
		const value = JSON.parse(raw) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const pinned = (value as Record<string, unknown>).pinnedLeafTurnId;
		return typeof pinned === "string" && pinned.length > 0 ? pinned : undefined;
	} catch {
		return undefined;
	}
}

function formatWorkingSet(trace: Trace): string {
	const view = foldWorkingSet(trace.entries);
	const index = buildPathIndex(trace.entries);
	const graph = buildReferenceGraph(trace, index);
	const evictedTokens = [...view.evicted.values()].reduce((sum, state) => sum + state.tokensFreed, 0);
	const churn = view.itemsEvicted === 0 ? "n/a" : (view.recalls / view.itemsEvicted).toFixed(3);
	const opCounts = new Map<string, number>();
	for (const observation of index.observations) {
		opCounts.set(observation.op, (opCounts.get(observation.op) ?? 0) + 1);
	}
	const rewrittenPaths = new Set<string>();
	for (const edge of graph.edges) {
		if (edge.kind !== "file_rewrite") continue;
		const path = index.byRef.get(edge.from)?.path;
		if (path) rewrittenPaths.add(path);
	}
	const lines = [
		`session: ${trace.id}`,
		`source: ${trace.source}`,
		"working set:",
		`  policy: ${view.lastPolicyId ?? "none"}`,
		`  eviction events: ${view.evictionEvents}`,
		`  evicted refs: ${view.evicted.size}`,
		`  items evicted: ${view.itemsEvicted}`,
		`  evicted tokens: ${evictedTokens}`,
		`  recalls: ${view.recalls}`,
		`  churn: ${churn}`,
		"  refs:",
		...([...view.evicted.entries()].length === 0
			? ["    none"]
			: [...view.evicted.entries()]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([ref, state]) => `    ${ref} reason=${state.reason} by=${state.by ?? "-"} tokens=${state.tokensFreed}`)),
		"path index:",
		`  observations: ${index.observations.length}`,
		`  ops: ${
			[...opCounts.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([op, count]) => `${op}=${count}`)
				.join(", ") || "none"
		}`,
		`  paths with rewrites: ${rewrittenPaths.size}`,
		...[...rewrittenPaths].sort().map((path) => `    ${path}`),
		"",
	];
	return lines.join("\n");
}

export async function runContextWorkingSetCommand(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(WORKING_SET_HELP);
		return 0;
	}
	let session: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--session") {
			try {
				session = requiredValue(args, index, arg);
			} catch (error) {
				process.stderr.write(
					`clio-coder context working-set: ${error instanceof Error ? error.message : String(error)}\n${WORKING_SET_HELP}`,
				);
				return 2;
			}
			index += 1;
			continue;
		}
		process.stderr.write(`clio-coder context working-set: unknown flag ${arg}\n${WORKING_SET_HELP}`);
		return 2;
	}
	if (session === undefined) {
		process.stderr.write(`clio-coder context working-set: --session is required\n${WORKING_SET_HELP}`);
		return 2;
	}
	try {
		const source = await sessionPath(session);
		const raw = await readFile(source, "utf8");
		const parsed = parseSessionEntries(raw, source);
		if (parsed.errors.length > 0) throw new Error(parsed.errors.join("; "));
		const entries = filterEntriesToActivePath(parsed.entries, await pinnedLeafForSession(source));
		process.stdout.write(
			formatWorkingSet({ id: basename(dirname(source)), source, entries, turnCount: buildPathIndex(entries).turnCount }),
		);
		return 0;
	} catch (error) {
		if (error instanceof CliUsageError) {
			process.stderr.write(`clio-coder context working-set: ${error.message}\n${WORKING_SET_HELP}`);
			return 2;
		}
		process.stderr.write(
			`clio-coder context working-set failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}
}
