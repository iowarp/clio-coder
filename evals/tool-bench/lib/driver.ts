/**
 * Tool bench driver: runs one corpus scenario through the full tool path and
 * prints one clio-coder.eval.measure.v1 line.
 *
 * node --import tsx evals/tool-bench/lib/driver.ts --scenario <id> --seed <int> --split search|holdout [--warmup <n>]
 *
 * The scenario id names the tool. The call goes through createWorkerToolRegistry at autonomy auto-edit and
 * invokeRegisteredTool, so validation, safety admission, hooks, the tool body,
 * and result shaping all run. The source imports below are relative, so the
 * driver always measures the checkout it sits in. Exit 0 means the scenario's
 * expected outcome and post-state held; the eval runner records that as
 * task.solved.
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ToolSpec } from "../../../src/tools/registry.js";
import {
	type BenchTool,
	type ExpectedEntry,
	generateScenario,
	materializeScenario,
	parseCorpusArgs,
	parseScenarioId,
	type Scenario,
	type ScenarioExpect,
} from "./corpus.js";
import { installFsCounters, startCounting, stopCounting } from "./fs-counter.js";

export const MEASURE_SCHEMA = "clio-coder.eval.measure.v1";
export const BEHAVIOR_SCHEMA = "clio-coder.tool-bench.behavior.v1";
export const DEFAULT_WARMUP = 3;

// Truncated grep results offload their full rendering under Clio's
// state directory. A private one per process keeps the bench out of the
// operator's state and gives the offload path a token in the digest. It is
// set before any tool module loads, because the state directory is cached.
const STATE_DIR = mkdtempSync(join(tmpdir(), "clio-coder-tool-bench-state-"));
process.env.CLIO_CODER_STATE_DIR = STATE_DIR;
process.on("exit", () => rmSync(STATE_DIR, { recursive: true, force: true }));

// The counters go in before any tool module loads, so every module the call
// can reach binds to the wrapped functions.
export const COUNTED_FS_FUNCTIONS = await installFsCounters();
const { ToolNames } = await import("../../../src/core/tool-names.js");
const { createWorkerSafety, createWorkerToolRegistry } = await import("../../../src/engine/worker-tools.js");
const { invokeRegisteredTool } = await import("../../../src/tools/agent-tools.js");

const TOOL_NAMES = {
	edit: ToolNames.Edit,
	read: ToolNames.Read,
	write: ToolNames.Write,
	grep: ToolNames.Grep,
	find: ToolNames.Find,
} as const satisfies Record<BenchTool, string>;

/**
 * Tools whose output order is not guaranteed: rg and fd walk a tree on
 * several threads, so the digest sorts the lines of their text result.
 */
const UNORDERED_TOOLS: ReadonlySet<BenchTool> = new Set(["grep", "find"]);

/** The reason the driver gives when it denies a parked call. */
const PARK_DENIED = "tool bench: no operator attends this call, so the parked confirmation is denied";

/** Pinned around every call, so the modes of files and directories a tool creates never depend on the caller. */
const BENCH_UMASK = 0o022;

export type StateEntry =
	| { kind: "dir"; path: string; mode: number }
	| { kind: "file"; path: string; size: number; sha256: string; mode: number }
	| { kind: "symlink"; path: string; target: string };

export interface ScenarioMeasurement {
	scenarioId: string;
	solved: boolean;
	outcome: "ok" | "error";
	errorClass: string | null;
	errorMessage: string | null;
	digest: string;
	wallMs: number;
	fsOps: number;
	fsOpsByName: Record<string, number>;
	maxRssKb: number;
	cpuUserMs: number;
	cpuSystemMs: number;
	/** The canonical document the digest hashes, kept for diagnosis. */
	behavior: unknown;
}

export interface RunScenarioOptions {
	warmup?: number;
	/**
	 * Test-only seam: replaces the scenario tool's registered spec before each call, so a
	 * test can prove a faulty tool changes the digest without editing src/tools.
	 * The CLI never sets it.
	 */
	replaceTool?: (original: ToolSpec) => ToolSpec;
}

// Random names, such as the write path's publish temp file, which an error can quote.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

const VOLATILE_KEY =
	/^(?:mtimeMs|atimeMs|ctimeMs|birthtimeMs|mtime|atime|ctime|birthtime|durationMs|elapsedMs|executedMs|timestamp|startedAt|finishedAt|at)$/u;

/**
 * Replaces temp paths and UUIDs in strings and blanks keys that carry time. Each pair is
 * (path, token); the longest path goes first, so the scratch root wins over
 * the temp directory that holds it.
 */
function normalize(value: unknown, roots: ReadonlyArray<readonly [string, string]>): unknown {
	if (typeof value === "string") {
		let out = value;
		for (const [root, token] of roots) out = out.split(root).join(token);
		return out.replace(UUID, "<uuid>");
	}
	if (Array.isArray(value)) return value.map((item) => normalize(item, roots));
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value))
			out[key] = VOLATILE_KEY.test(key) ? "<volatile>" : normalize(item, roots);
		return out;
	}
	return value;
}

/** Sorts the lines of every text item and the skipped-path samples of a shaped result. */
function sortResultLines(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	const result = value as { content?: unknown; details?: { search?: { skipped?: { samples?: unknown } } } };
	if (Array.isArray(result.content)) {
		for (const item of result.content as Array<{ type?: unknown; text?: unknown }>) {
			if (item.type === "text" && typeof item.text === "string") item.text = item.text.split("\n").sort().join("\n");
		}
	}
	const samples = result.details?.search?.skipped?.samples;
	if (Array.isArray(samples)) samples.sort();
	return value;
}

/** JSON with sorted object keys and undefined members dropped. */
export function canonicalJson(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	const entries = Object.entries(value)
		.filter(([, item]) => item !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** Reads a file even when its mode denies the owner read, then puts the mode back. */
function readAnyFile(path: string, mode: number): Buffer {
	if ((mode & 0o400) !== 0) return readFileSync(path);
	chmodSync(path, mode | 0o400);
	try {
		return readFileSync(path);
	} finally {
		chmodSync(path, mode);
	}
}

/** Sorted relative paths with size, content hash, and mode, or the link target. */
export function snapshotTree(root: string, skip: ReadonlySet<string> = new Set()): StateEntry[] {
	const out: StateEntry[] = [];
	const walk = (relative: string): void => {
		const names = readdirSync(join(root, relative)).sort();
		for (const name of names) {
			if (relative === "" && skip.has(name)) continue;
			const path = relative === "" ? name : `${relative}/${name}`;
			const absolute = join(root, path);
			const info = lstatSync(absolute);
			if (info.isSymbolicLink()) out.push({ kind: "symlink", path, target: readlinkSync(absolute) });
			else if (info.isDirectory()) {
				out.push({ kind: "dir", path, mode: info.mode & 0o7777 });
				walk(path);
			} else {
				const bytes = readAnyFile(absolute, info.mode & 0o7777);
				const sha256 = createHash("sha256").update(bytes).digest("hex");
				out.push({ kind: "file", path, size: bytes.length, sha256, mode: info.mode & 0o7777 });
			}
		}
	};
	walk("");
	return out;
}

/** Every file and symlink must match the expectation; a directory only when it is listed. */
function postStateHolds(expected: readonly ExpectedEntry[], actual: readonly StateEntry[]): boolean {
	const nonDirs = actual.filter((entry) => entry.kind !== "dir");
	if (nonDirs.length !== expected.filter((entry) => entry.kind !== "dir").length) return false;
	const byPath = new Map(actual.map((entry) => [entry.path, entry]));
	return expected.every((want) => {
		const got = byPath.get(want.path);
		return got !== undefined && canonicalJson(got) === canonicalJson(want);
	});
}

function outputHolds(expected: ScenarioExpect["output"], shown: string): boolean {
	if (expected === undefined) return true;
	return (
		expected.includes.every((text) => shown.includes(text)) && expected.excludes.every((text) => !shown.includes(text))
	);
}

/** Gives the owner write and search on every directory, so a read-only one can be removed. */
function makeRemovable(root: string): void {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const path = join(root, entry.name);
		chmodSync(path, 0o755);
		makeRemovable(path);
	}
}

async function invokeOnce(
	scenario: Scenario,
	options: RunScenarioOptions,
	measure: boolean,
): Promise<ScenarioMeasurement | null> {
	// The scratch root sits one level inside its own temp directory, so a call
	// that escapes the root lands in that directory, where it is recorded and
	// removed with the rest.
	const base = mkdtempSync(join(tmpdir(), "clio-coder-tool-bench-"));
	const root = join(base, "root");
	const previousCwd = process.cwd();
	const previousUmask = process.umask(BENCH_UMASK);
	try {
		mkdirSync(root, { mode: 0o755 });
		materializeScenario(scenario, root);
		const realBase = realpathSync(base);
		const realRoot = join(realBase, "root");
		process.chdir(realRoot);
		// A fresh safety contract and registry per call. The worker loop guard
		// keys repeated identical calls, and warmups repeat the measured call.
		const registry = createWorkerToolRegistry(
			undefined,
			createWorkerSafety({ cwd: realRoot }),
			{ noSkills: true },
			[],
			"auto-edit",
		);
		const toolName = TOOL_NAMES[scenario.tool];
		if (options.replaceTool !== undefined) {
			const original = registry.get(toolName);
			if (original === undefined) throw new Error(`${scenario.tool} tool is not registered`);
			registry.register(options.replaceTool(original));
		}
		// No operator attends a bench call, so a call that admission parks for
		// confirmation is denied on the next turn of the event loop, the way an
		// unattended worker ends it. The safety decision goes into the digest.
		let parked: { tool: string; decision: unknown } | undefined;
		registry.onPermissionRequired((call, decision, meta) => {
			parked = { tool: call.tool, decision };
			setImmediate(() => registry.cancelParkedCall(meta.requestId, PARK_DENIED));
		});
		const args = structuredClone(scenario.args);
		// Let setup I/O drain so it cannot land inside the counted window.
		await yieldImmediate();
		await yieldImmediate();

		let result: unknown = null;
		let error: unknown = null;
		const usageBefore = process.resourceUsage();
		startCounting();
		const started = process.hrtime.bigint();
		try {
			result = await invokeRegisteredTool(registry, toolName, args);
		} catch (caught) {
			error = caught;
		}
		const finished = process.hrtime.bigint();
		const counted = stopCounting();
		const usageAfter = process.resourceUsage();
		if (!measure) return null;

		const roots: Array<readonly [string, string]> = [
			[realRoot, "<scratch>"],
			[root, "<scratch>"],
			[realBase, "<outside>"],
			[base, "<outside>"],
			[realpathSync(STATE_DIR), "<state>"],
			[STATE_DIR, "<state>"],
		];
		roots.sort(([left], [right]) => right.length - left.length);
		const files = snapshotTree(realRoot);
		// Anything next to the scratch root was written outside it.
		const outside = snapshotTree(realBase, new Set(["root"]));
		const errorClass = error === null ? null : error instanceof Error ? error.constructor.name : typeof error;
		const errorMessage =
			error === null ? null : (normalize(error instanceof Error ? error.message : String(error), roots) as string);
		const outcome = error === null ? "ok" : "error";
		const behavior = {
			schema: BEHAVIOR_SCHEMA,
			tool: scenario.tool,
			outcome,
			result: UNORDERED_TOOLS.has(scenario.tool) ? sortResultLines(normalize(result, roots)) : normalize(result, roots),
			error: error === null ? null : { class: errorClass, message: errorMessage },
			files,
			// Both absent unless a call parked or escaped, so digests of calls
			// that did neither keep their value.
			parked: normalize(parked, roots),
			outside: outside.length > 0 ? outside : undefined,
		};
		const shown = canonicalJson({ result: behavior.result, error: errorMessage });
		return {
			scenarioId: scenario.id,
			solved:
				outcome === scenario.expect.outcome &&
				outside.length === 0 &&
				postStateHolds(scenario.expect.files, files) &&
				outputHolds(scenario.expect.output, shown),
			outcome,
			errorClass,
			errorMessage,
			digest: createHash("sha256").update(canonicalJson(behavior)).digest("hex"),
			wallMs: Number(finished - started) / 1e6,
			fsOps: counted.total,
			fsOpsByName: counted.byName,
			maxRssKb: usageAfter.maxRSS,
			cpuUserMs: (usageAfter.userCPUTime - usageBefore.userCPUTime) / 1000,
			cpuSystemMs: (usageAfter.systemCPUTime - usageBefore.systemCPUTime) / 1000,
			behavior,
		};
	} finally {
		process.chdir(previousCwd);
		process.umask(previousUmask);
		makeRemovable(base);
		rmSync(base, { recursive: true, force: true });
	}
}

/** Warmups first, each on a fresh copy of the scenario files, then the measured call. */
export async function runScenario(scenario: Scenario, options: RunScenarioOptions = {}): Promise<ScenarioMeasurement> {
	const warmup = options.warmup ?? DEFAULT_WARMUP;
	for (let i = 0; i < warmup; i += 1) await invokeOnce(scenario, options, false);
	const measured = await invokeOnce(scenario, options, true);
	if (measured === null) throw new Error("measured invocation returned nothing");
	return measured;
}

export function measureLine(measurement: ScenarioMeasurement, scenario: Scenario, warmup: number): string {
	return JSON.stringify({
		schema: MEASURE_SCHEMA,
		metrics: {
			"custom.latency.wall_ms": measurement.wallMs,
			"custom.counters.fs_ops": measurement.fsOps,
			"custom.memory.max_rss_kb": measurement.maxRssKb,
			"custom.cpu.user_ms": measurement.cpuUserMs,
			"custom.cpu.system_ms": measurement.cpuSystemMs,
			"custom.digest.behavior": measurement.digest,
			"custom.corpus.seed": scenario.seed,
			"custom.corpus.holdout": scenario.split === "holdout",
			"custom.bench.warmup": warmup,
		},
	});
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
	const { seed, split, rest } = parseCorpusArgs(process.argv.slice(2));
	const id = rest.get("scenario");
	if (id === undefined) throw new Error("--scenario <id> is required");
	const warmupText = rest.get("warmup") ?? String(DEFAULT_WARMUP);
	if (!/^\d+$/u.test(warmupText)) throw new Error(`--warmup must be a non-negative integer: ${warmupText}`);
	rest.delete("scenario");
	rest.delete("warmup");
	if (rest.size > 0) throw new Error(`unknown flags: ${[...rest.keys()].join(", ")}`);
	const parsed = parseScenarioId(id);
	if (parsed.split !== split) throw new Error(`scenario ${id} belongs to split ${parsed.split}, not ${split}`);
	const scenario = generateScenario(parsed.tool, seed, split, parsed.key);
	const warmup = Number(warmupText);
	const measurement = await runScenario(scenario, { warmup });
	process.stderr.write(
		`${JSON.stringify({
			scenario: scenario.id,
			solved: measurement.solved,
			outcome: measurement.outcome,
			errorClass: measurement.errorClass,
			errorMessage: measurement.errorMessage,
			fsOpsByName: measurement.fsOpsByName,
		})}\n`,
	);
	process.stdout.write(`${measureLine(measurement, scenario, warmup)}\n`);
	process.exitCode = measurement.solved ? 0 : 1;
}
