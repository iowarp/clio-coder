/**
 * Tool bench driver: runs one corpus scenario through the full tool path and
 * prints one clio-coder.eval.measure.v1 line.
 *
 * node --import tsx evals/tool-bench/lib/driver.ts --scenario <id> --seed <int> --split search|holdout [--warmup <n>]
 *
 * The call goes through createWorkerToolRegistry at autonomy auto-edit and
 * invokeRegisteredTool, so validation, safety admission, hooks, the tool body,
 * and result shaping all run. The source imports below are relative, so the
 * driver always measures the checkout it sits in. Exit 0 means the scenario's
 * expected outcome and post-state held; the eval runner records that as
 * task.solved.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ToolSpec } from "../../../src/tools/registry.js";
import {
	type EditScenario,
	type ExpectedEntry,
	generateScenario,
	materializeScenario,
	parseCorpusArgs,
	parseScenarioId,
} from "./corpus.js";
import { installFsCounters, startCounting, stopCounting } from "./fs-counter.js";

export const MEASURE_SCHEMA = "clio-coder.eval.measure.v1";
export const BEHAVIOR_SCHEMA = "clio-coder.tool-bench.behavior.v1";
export const DEFAULT_WARMUP = 3;

// The counters go in before any tool module loads, so every module the call
// can reach binds to the wrapped functions.
export const COUNTED_FS_FUNCTIONS = await installFsCounters();
const { ToolNames } = await import("../../../src/core/tool-names.js");
const { createWorkerSafety, createWorkerToolRegistry } = await import("../../../src/engine/worker-tools.js");
const { invokeRegisteredTool } = await import("../../../src/tools/agent-tools.js");

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
	 * Test-only seam: replaces the registered edit spec before each call, so a
	 * test can prove a faulty tool changes the digest without editing src/tools.
	 * The CLI never sets it.
	 */
	replaceTool?: (original: ToolSpec) => ToolSpec;
}

const VOLATILE_KEY =
	/^(?:mtimeMs|atimeMs|ctimeMs|birthtimeMs|mtime|atime|ctime|birthtime|durationMs|elapsedMs|executedMs|timestamp|startedAt|finishedAt|at)$/u;

/** Replaces scratch-root paths in strings and blanks keys that carry time. */
function normalize(value: unknown, roots: readonly string[]): unknown {
	if (typeof value === "string") {
		let out = value;
		for (const root of roots) out = out.split(root).join("<scratch>");
		return out;
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

/** Sorted relative paths with size, content hash, and mode, or the link target. */
export function snapshotTree(root: string): StateEntry[] {
	const out: StateEntry[] = [];
	const walk = (relative: string): void => {
		const names = readdirSync(join(root, relative)).sort();
		for (const name of names) {
			const path = relative === "" ? name : `${relative}/${name}`;
			const absolute = join(root, path);
			const info = lstatSync(absolute);
			if (info.isSymbolicLink()) out.push({ kind: "symlink", path, target: readlinkSync(absolute) });
			else if (info.isDirectory()) {
				out.push({ kind: "dir", path, mode: info.mode & 0o7777 });
				walk(path);
			} else {
				const bytes = readFileSync(absolute);
				const sha256 = createHash("sha256").update(bytes).digest("hex");
				out.push({ kind: "file", path, size: bytes.length, sha256, mode: info.mode & 0o7777 });
			}
		}
	};
	walk("");
	return out;
}

function postStateHolds(expected: readonly ExpectedEntry[], actual: readonly StateEntry[]): boolean {
	const nonDirs = actual.filter((entry) => entry.kind !== "dir");
	if (nonDirs.length !== expected.length) return false;
	return expected.every((want) => {
		const got = nonDirs.find((entry) => entry.path === want.path);
		return got !== undefined && canonicalJson(got) === canonicalJson(want);
	});
}

async function invokeOnce(
	scenario: EditScenario,
	options: RunScenarioOptions,
	measure: boolean,
): Promise<ScenarioMeasurement | null> {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-tool-bench-"));
	const previousCwd = process.cwd();
	try {
		materializeScenario(scenario, root);
		const realRoot = realpathSync(root);
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
		if (options.replaceTool !== undefined) {
			const original = registry.get(ToolNames.Edit);
			if (original === undefined) throw new Error("edit tool is not registered");
			registry.register(options.replaceTool(original));
		}
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
			result = await invokeRegisteredTool(registry, ToolNames.Edit, args);
		} catch (caught) {
			error = caught;
		}
		const finished = process.hrtime.bigint();
		const counted = stopCounting();
		const usageAfter = process.resourceUsage();
		if (!measure) return null;

		const roots = [realRoot, root].sort((left, right) => right.length - left.length);
		const files = snapshotTree(realRoot);
		const errorClass = error === null ? null : error instanceof Error ? error.constructor.name : typeof error;
		const errorMessage =
			error === null ? null : (normalize(error instanceof Error ? error.message : String(error), roots) as string);
		const outcome = error === null ? "ok" : "error";
		const behavior = {
			schema: BEHAVIOR_SCHEMA,
			tool: scenario.tool,
			outcome,
			result: normalize(result, roots),
			error: error === null ? null : { class: errorClass, message: errorMessage },
			files,
		};
		return {
			scenarioId: scenario.id,
			solved: outcome === scenario.expect.outcome && postStateHolds(scenario.expect.files, files),
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
		rmSync(root, { recursive: true, force: true });
	}
}

/** Warmups first, each on a fresh copy of the scenario files, then the measured call. */
export async function runScenario(
	scenario: EditScenario,
	options: RunScenarioOptions = {},
): Promise<ScenarioMeasurement> {
	const warmup = options.warmup ?? DEFAULT_WARMUP;
	for (let i = 0; i < warmup; i += 1) await invokeOnce(scenario, options, false);
	const measured = await invokeOnce(scenario, options, true);
	if (measured === null) throw new Error("measured invocation returned nothing");
	return measured;
}

export function measureLine(measurement: ScenarioMeasurement, scenario: EditScenario, warmup: number): string {
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
	const scenario = generateScenario(seed, split, parsed.key);
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
