/**
 * Bounded adapter for Clio Coder's stored eval reports.
 *
 * The browser supplies no eval id and no argv. `eval inventory --json` selects
 * the newest bounded window itself and has already dropped everything an eval
 * artifact holds that cannot cross: the runner attachments, which for the
 * Clio Coder runner are the whole session transcript, the per-result metric map, the eval
 * entry path, the suite hash, the compiled prompt hash, and the receipt
 * digests. This host projection revalidates what is left and rejects any field
 * outside the closed GUI DTO before the snapshot reaches the renderer.
 */

import { resolve } from "node:path";
import { ClioReadCommandError, ClioReadCommandRunner } from "./clio-read-command.ts";
import {
	type CommandErrorCode,
	EVAL_BEHAVIOR_OUTCOMES,
	EVAL_FAILURE_CLASSES,
	EVAL_MATRIX_DIMENSIONS,
	MAX_WIRE_EVAL_REPORTS,
	MAX_WIRE_EVAL_SCENARIOS,
	type WireEvalInventory,
	type WireEvalReport,
	type WireEvalScenario,
	type WireEvalTokens,
} from "./src/protocol.ts";

export const DEFAULT_EVAL_INSPECT_TIMEOUT_MS = 15_000;
export const MAX_EVAL_INSPECT_STDOUT_BYTES = 1024 * 1024;
export const MAX_EVAL_INSPECT_STDERR_BYTES = 64 * 1024;
const MAX_COUNT = 1_000_000_000;
const MAX_ELAPSED_MS = 365 * 24 * 60 * 60 * 1_000;
const encoder = new TextEncoder();

export interface ClioEvalInspector {
	inspect(cwd: string): Promise<WireEvalInventory>;
}

export interface ClioCliEvalInspectorOptions {
	readonly executable?: string;
	/** Test/development prefix only. Browser commands can never influence argv. */
	readonly prefixArgs?: readonly string[];
	readonly timeoutMs?: number;
	readonly maximumStdoutBytes?: number;
	readonly maximumStderrBytes?: number;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

export class ClioEvalProjectionError extends Error {
	override readonly name = "ClioEvalProjectionError";
}

export class ClioEvalInspectError extends Error {
	override readonly name = "ClioEvalInspectError";

	constructor(readonly code: CommandErrorCode, message: string) {
		super(message);
	}
}

function projectionError(message: string): never {
	throw new ClioEvalProjectionError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exactKeys(record: Record<string, unknown>, required: readonly string[]): boolean {
	const keys = Object.keys(record);
	return keys.length === required.length && required.every((key) => Object.hasOwn(record, key));
}

function text(value: unknown, maximumBytes: number): string | null {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return null;
	if (encoder.encode(value).byteLength > maximumBytes) return null;
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return null;
	}
	return value;
}

function nullableText(value: unknown, maximumBytes: number): string | null | undefined {
	return value === null ? null : text(value, maximumBytes) ?? undefined;
}

function timestamp(value: unknown): string | null {
	const candidate = text(value, 128);
	if (candidate === null) return null;
	const parsed = new Date(candidate);
	return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== candidate ? null : candidate;
}

function counter(value: unknown, maximum: number): number | undefined {
	return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum
		? value as number
		: undefined;
}

function nullableCounter(value: unknown, maximum: number): number | null | undefined {
	return value === null ? null : counter(value, maximum);
}

function isOneOf<const T extends readonly string[]>(value: unknown, choices: T): value is T[number] {
	return typeof value === "string" && choices.includes(value as T[number]);
}

/** The instant `createEvalId` stamped into an id, or null when the id is not one it minted. */
function evalIdStartedAt(evalId: string): string | null {
	const match = /^eval-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-[0-9a-f]{8}-[0-9a-f]{12}$/u.exec(evalId);
	if (match === null) return null;
	const [, year, month, day, hour, minute, second, millisecond] = match;
	const stamp = `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`;
	const parsed = new Date(stamp);
	return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== stamp ? null : stamp;
}

function projectTokens(value: unknown, runs: number): WireEvalTokens {
	const keys = ["measured", "runs", "measuredRuns", "input", "output", "total", "cacheRead", "cacheWrite"] as const;
	if (!isRecord(value) || !exactKeys(value, keys) || typeof value.measured !== "boolean") {
		return projectionError("Clio Coder returned invalid eval token accounting.");
	}
	const counted = counter(value.runs, MAX_COUNT);
	const measuredRuns = counter(value.measuredRuns, MAX_COUNT);
	const counts = {
		input: nullableCounter(value.input, MAX_COUNT),
		output: nullableCounter(value.output, MAX_COUNT),
		total: nullableCounter(value.total, MAX_COUNT),
		cacheRead: nullableCounter(value.cacheRead, MAX_COUNT),
		cacheWrite: nullableCounter(value.cacheWrite, MAX_COUNT),
	};
	if (counted === undefined || measuredRuns === undefined || Object.values(counts).some((c) => c === undefined)) {
		return projectionError("Clio Coder returned invalid eval token accounting.");
	}
	const present = Object.values(counts).filter((count) => count !== null).length;
	// Unmeasured accounting carries no counts. Reading counts beside
	// `measured: false` is a contradiction, not a value to prefer.
	if (value.measured !== (present === 5)) {
		return projectionError("Clio Coder returned eval token counts that disagree with its own measurement flag.");
	}
	if (!value.measured && measuredRuns !== 0) {
		return projectionError("Clio Coder returned an unmeasured eval report with measured coverage.");
	}
	if (value.measured && (measuredRuns === 0 || measuredRuns > counted)) {
		return projectionError("Clio Coder returned eval token coverage its own run count cannot hold.");
	}
	if (counted !== runs) {
		return projectionError("Clio Coder returned eval token accounting for a different number of runs.");
	}
	return {
		measured: value.measured,
		runs: counted,
		measuredRuns,
		...(counts as {
			input: number | null;
			output: number | null;
			total: number | null;
			cacheRead: number | null;
			cacheWrite: number | null;
		}),
	};
}

function projectScenario(value: unknown): WireEvalScenario {
	const keys = [
		"scenarioId",
		"trials",
		"passed",
		"failed",
		"unmeasured",
		"machineryFailures",
		"passAtK",
		"passPowK",
	] as const;
	if (!isRecord(value) || !exactKeys(value, keys)) {
		return projectionError("Clio Coder returned an invalid eval scenario.");
	}
	const scenarioId = text(value.scenarioId, 128);
	const counts = {
		trials: counter(value.trials, MAX_COUNT),
		passed: counter(value.passed, MAX_COUNT),
		failed: counter(value.failed, MAX_COUNT),
		unmeasured: counter(value.unmeasured, MAX_COUNT),
		machineryFailures: counter(value.machineryFailures, MAX_COUNT),
		passAtK: counter(value.passAtK, 1),
		passPowK: counter(value.passPowK, 1),
	};
	if (scenarioId === null || Object.values(counts).some((count) => count === undefined)) {
		return projectionError("Clio Coder returned an invalid eval scenario.");
	}
	const scenario = counts as Record<keyof typeof counts, number>;
	// The reducer partitions one scenario's trials into exactly three outcomes,
	// counts machinery failures inside the failures, and derives both rates.
	if (scenario.passed + scenario.failed + scenario.unmeasured !== scenario.trials) {
		return projectionError("Clio Coder returned an eval scenario whose outcomes do not sum to its trials.");
	}
	if (scenario.machineryFailures > scenario.failed) {
		return projectionError("Clio Coder returned an eval scenario blaming machinery for more trials than failed.");
	}
	if (
		scenario.passAtK !== (scenario.trials > 0 && scenario.passed > 0 ? 1 : 0) ||
		scenario.passPowK !== (scenario.trials > 0 && scenario.passed === scenario.trials ? 1 : 0)
	) {
		return projectionError("Clio Coder returned eval scenario pass rates that disagree with its own outcomes.");
	}
	return { scenarioId, ...scenario };
}

function projectMatrix(value: unknown): WireEvalReport["matrix"] {
	if (!isRecord(value) || !exactKeys(value, ["target", "model", "thinking", "dimensions"])) {
		return projectionError("Clio Coder returned an invalid eval matrix.");
	}
	const target = nullableText(value.target, 128);
	const model = nullableText(value.model, 128);
	const thinking = nullableText(value.thinking, 64);
	if (
		target === undefined || model === undefined || thinking === undefined ||
		!Array.isArray(value.dimensions) || value.dimensions.length > EVAL_MATRIX_DIMENSIONS.length
	) return projectionError("Clio Coder returned an invalid eval matrix.");
	const dimensions = value.dimensions.filter((entry) => isOneOf(entry, EVAL_MATRIX_DIMENSIONS));
	if (dimensions.length !== value.dimensions.length || new Set(dimensions).size !== dimensions.length) {
		return projectionError("Clio Coder returned an invalid eval matrix dimension list.");
	}
	return { target, model, thinking, dimensions: dimensions as WireEvalReport["matrix"]["dimensions"] };
}

function projectServing(value: unknown): WireEvalReport["serving"] {
	const keys = [
		"observed",
		"targetId",
		"runtimeId",
		"modelId",
		"serverBuild",
		"thinkingLevel",
		"totalSlots",
		"compiledPromptPinned",
	] as const;
	if (
		!isRecord(value) || !exactKeys(value, keys) || typeof value.observed !== "boolean" ||
		typeof value.compiledPromptPinned !== "boolean"
	) return projectionError("Clio Coder returned an invalid eval serving record.");
	const fields = {
		targetId: nullableText(value.targetId, 128),
		runtimeId: nullableText(value.runtimeId, 128),
		modelId: nullableText(value.modelId, 128),
		serverBuild: nullableText(value.serverBuild, 128),
		thinkingLevel: nullableText(value.thinkingLevel, 64),
	};
	const totalSlots = nullableCounter(value.totalSlots, MAX_COUNT);
	if (Object.values(fields).some((entry) => entry === undefined) || totalSlots === undefined) {
		return projectionError("Clio Coder returned an invalid eval serving record.");
	}
	// A report with no recorded serving configuration is read off the matrix it
	// declared, and the matrix knows nothing about the runtime, the server
	// build, the slot count, or the compiled prompt.
	if (
		!value.observed &&
		(fields.runtimeId !== null || fields.serverBuild !== null || totalSlots !== null || value.compiledPromptPinned)
	) return projectionError("Clio Coder returned eval serving facts a declared matrix cannot supply.");
	return {
		observed: value.observed,
		...(fields as Record<keyof typeof fields, string | null>),
		totalSlots,
		compiledPromptPinned: value.compiledPromptPinned,
	};
}

/**
 * A tally over a closed vocabulary: distinct members, positive counts.
 *
 * A member with a zero count is refused rather than accepted, because the
 * projection emits a row only for a member it actually counted, so a zero row
 * means the frame was not built by it.
 */
function projectTally<const T extends readonly string[]>(
	value: unknown,
	field: string,
	choices: T,
	label: string,
): { member: T[number]; count: number }[] {
	if (!Array.isArray(value) || value.length > choices.length) {
		return projectionError(`Clio Coder returned an invalid eval ${label} tally.`);
	}
	const rows = value.map((entry) => {
		if (!isRecord(entry) || !exactKeys(entry, [field, "count"])) {
			return projectionError(`Clio Coder returned an invalid eval ${label} tally.`);
		}
		const count = counter(entry.count, MAX_COUNT);
		const member = entry[field];
		if (!isOneOf(member, choices) || count === undefined || count === 0) {
			return projectionError(`Clio Coder returned an invalid eval ${label} tally.`);
		}
		return { member, count };
	});
	if (new Set(rows.map((row) => row.member)).size !== rows.length) {
		return projectionError(`Clio Coder returned a repeated eval ${label}.`);
	}
	return rows;
}

function projectResults(value: unknown, runs: number, failed: number): WireEvalReport["results"] {
	const keys = [
		"total",
		"withAssignment",
		"withTerminalReceipt",
		"withVerdict",
		"withBehavioral",
		"withExecutionEnvelope",
		"machineryFailures",
		"attachments",
		"canonicalMetrics",
		"otherMetrics",
	] as const;
	if (!isRecord(value) || !exactKeys(value, keys)) {
		return projectionError("Clio Coder returned an invalid eval result roll-up.");
	}
	const counts = Object.fromEntries(keys.map((key) => [key, counter(value[key], MAX_COUNT)])) as Record<
		(typeof keys)[number],
		number | undefined
	>;
	if (Object.values(counts).some((count) => count === undefined)) {
		return projectionError("Clio Coder returned an invalid eval result roll-up.");
	}
	const results = counts as WireEvalReport["results"];
	if (results.total !== runs) {
		return projectionError("Clio Coder returned an eval result roll-up for a different number of runs.");
	}
	if (
		results.withAssignment > results.total || results.withTerminalReceipt > results.total ||
		results.withVerdict > results.total
	) return projectionError("Clio Coder returned eval linkage counts larger than the report holds.");
	// The artifact parser requires a behavioral document to reference a verdict
	// and an execution envelope to reference a behavioral document.
	if (results.withBehavioral > results.withVerdict || results.withExecutionEnvelope > results.withBehavioral) {
		return projectionError("Clio Coder returned eval documents without the ones they reference.");
	}
	if (results.machineryFailures > failed) {
		return projectionError("Clio Coder returned an eval report blaming machinery for more runs than failed.");
	}
	return results;
}

function projectReport(value: unknown): WireEvalReport {
	const keys = [
		"evalId",
		"startedAt",
		"suiteId",
		"servingGroup",
		"clioCoderVersion",
		"clioCoderCommit",
		"platform",
		"node",
		"matrix",
		"serving",
		"summary",
		"results",
		"failureClasses",
		"behaviorOutcomes",
		"scenarios",
		"scenariosTruncated",
		"scenariosDropped",
	] as const;
	if (!isRecord(value) || !exactKeys(value, keys)) {
		return projectionError("Clio Coder returned an invalid eval report.");
	}
	const evalId = text(value.evalId, 128);
	const startedAt = value.startedAt === null ? null : timestamp(value.startedAt);
	const suiteId = text(value.suiteId, 128);
	const servingGroup = counter(value.servingGroup, MAX_WIRE_EVAL_REPORTS);
	const identity = {
		clioCoderVersion: nullableText(value.clioCoderVersion, 64),
		clioCoderCommit: nullableText(value.clioCoderCommit, 64),
		platform: nullableText(value.platform, 64),
		node: nullableText(value.node, 64),
	};
	if (
		evalId === null || suiteId === null || servingGroup === undefined || servingGroup === 0 ||
		(value.startedAt !== null && startedAt === null) ||
		Object.values(identity).some((entry) => entry === undefined)
	) return projectionError("Clio Coder returned an invalid eval report.");
	// The stamp is not an independent fact: it is read out of the id, and the id
	// crosses, so a stamp that disagrees with it was not read out of anything.
	if (startedAt !== null && startedAt !== evalIdStartedAt(evalId)) {
		return projectionError("Clio Coder returned an eval start instant its own id does not carry.");
	}

	if (
		!isRecord(value.summary) ||
		!exactKeys(value.summary, ["runs", "passed", "failed", "passRate", "wallTimeMs", "tokens"])
	) {
		return projectionError("Clio Coder returned an invalid eval summary.");
	}
	const runs = counter(value.summary.runs, MAX_COUNT);
	const passed = counter(value.summary.passed, MAX_COUNT);
	const failed = counter(value.summary.failed, MAX_COUNT);
	const wallTimeMs = counter(value.summary.wallTimeMs, MAX_ELAPSED_MS);
	const passRate = value.summary.passRate;
	if (
		runs === undefined || passed === undefined || failed === undefined || wallTimeMs === undefined ||
		typeof passRate !== "number" || !Number.isFinite(passRate) || passRate < 0 || passRate > 1
	) return projectionError("Clio Coder returned an invalid eval summary.");
	if (passed + failed !== runs) {
		return projectionError("Clio Coder returned an eval summary whose outcomes do not sum to its runs.");
	}
	if (Math.abs(passRate - (runs === 0 ? 0 : passed / runs)) > 1e-9) {
		return projectionError("Clio Coder returned an eval pass rate that disagrees with its own outcomes.");
	}

	const results = projectResults(value.results, runs, failed);
	const failures = projectTally(value.failureClasses, "failureClass", EVAL_FAILURE_CLASSES, "failure class");
	// A passing result carries no class and a failing one always carries one.
	if (failures.reduce((sum, entry) => sum + entry.count, 0) !== failed) {
		return projectionError("Clio Coder returned an eval failure tally that does not account for its failures.");
	}
	const failureClasses: WireEvalReport["failureClasses"] = failures.map((entry) => ({
		failureClass: entry.member,
		count: entry.count,
	}));
	const behaviors = projectTally(value.behaviorOutcomes, "outcome", EVAL_BEHAVIOR_OUTCOMES, "behavior outcome");
	if (behaviors.reduce((sum, entry) => sum + entry.count, 0) !== results.withBehavioral) {
		return projectionError("Clio Coder returned an eval behavior tally that does not account for its documents.");
	}
	const behaviorOutcomes: WireEvalReport["behaviorOutcomes"] = behaviors.map((entry) => ({
		outcome: entry.member,
		count: entry.count,
	}));

	const scenariosDropped = counter(value.scenariosDropped, MAX_COUNT);
	if (typeof value.scenariosTruncated !== "boolean" || scenariosDropped === undefined) {
		return projectionError("Clio Coder returned an invalid eval scenario bound.");
	}
	let scenarios: readonly WireEvalScenario[] | null = null;
	if (value.scenarios !== null) {
		if (!Array.isArray(value.scenarios) || value.scenarios.length > MAX_WIRE_EVAL_SCENARIOS) {
			return projectionError("Clio Coder returned an invalid eval scenario list.");
		}
		scenarios = value.scenarios.map(projectScenario);
		if (new Set(scenarios.map((entry) => entry.scenarioId)).size !== scenarios.length) {
			return projectionError("Clio Coder returned duplicate eval scenarios.");
		}
		// The reductions cover exactly the results that carried a verdict.
		const trials = scenarios.reduce((sum, entry) => sum + entry.trials, 0);
		const whole = !value.scenariosTruncated && scenariosDropped === 0;
		if (whole ? trials !== results.withVerdict : trials > results.withVerdict) {
			return projectionError("Clio Coder returned eval scenarios that do not account for their verdicts.");
		}
	} else if (value.scenariosTruncated || scenariosDropped > 0) {
		return projectionError("Clio Coder bounded an eval scenario list it never reported.");
	}

	return {
		evalId,
		startedAt,
		suiteId,
		servingGroup,
		...(identity as Record<keyof typeof identity, string | null>),
		matrix: projectMatrix(value.matrix),
		serving: projectServing(value.serving),
		summary: {
			runs,
			passed,
			failed,
			passRate,
			wallTimeMs,
			tokens: projectTokens(value.summary.tokens, runs),
		},
		results,
		failureClasses,
		behaviorOutcomes,
		scenarios,
		scenariosTruncated: value.scenariosTruncated,
		scenariosDropped,
	};
}

export function projectEvalInventory(value: unknown, inspectedAt: string): WireEvalInventory {
	if (
		!isRecord(value) ||
		!exactKeys(value, ["version", "generatedAt", "available", "stored", "unreadable", "reports", "truncated"])
	) {
		throw new ClioEvalProjectionError("Clio Coder returned an invalid eval inventory.");
	}
	const generatedAt = timestamp(value.generatedAt);
	const stored = counter(value.stored, MAX_COUNT);
	const unreadable = counter(value.unreadable, MAX_COUNT);
	if (
		value.version !== 1 || generatedAt === null || stored === undefined || unreadable === undefined ||
		typeof value.available !== "boolean" || typeof value.truncated !== "boolean" ||
		!Array.isArray(value.reports) || value.reports.length > MAX_WIRE_EVAL_REPORTS
	) {
		throw new ClioEvalProjectionError("Clio Coder returned an invalid eval inventory.");
	}
	const reports = value.reports.map(projectReport);
	if (new Set(reports.map((report) => report.evalId)).size !== reports.length) {
		throw new ClioEvalProjectionError("Clio Coder returned duplicate eval identities.");
	}
	// An installation with no eval store has nothing to have counted.
	if (!value.available && (stored > 0 || unreadable > 0 || reports.length > 0 || value.truncated)) {
		throw new ClioEvalProjectionError("Clio Coder reported eval contents for a store it says does not exist.");
	}
	const window = reports.length + unreadable;
	if (window > stored) throw new ClioEvalProjectionError("Clio Coder read more eval reports than its store holds.");
	if (value.truncated !== stored > window) {
		throw new ClioEvalProjectionError("Clio Coder returned an eval window that disagrees with its own bound.");
	}
	return {
		scope: "installation",
		inspectedAt,
		generatedAt,
		available: value.available,
		stored,
		unreadable,
		reports,
		truncated: value.truncated,
	};
}

export class ClioCliEvalInspector implements ClioEvalInspector {
	readonly #runner: ClioReadCommandRunner;
	readonly #now: () => number;
	readonly #log: (message: string) => void;

	constructor(options: ClioCliEvalInspectorOptions = {}) {
		this.#runner = new ClioReadCommandRunner({
			executable: options.executable,
			prefixArgs: options.prefixArgs,
			timeoutMs: options.timeoutMs ?? DEFAULT_EVAL_INSPECT_TIMEOUT_MS,
			maximumStdoutBytes: options.maximumStdoutBytes ?? MAX_EVAL_INSPECT_STDOUT_BYTES,
			maximumStderrBytes: options.maximumStderrBytes ?? MAX_EVAL_INSPECT_STDERR_BYTES,
		});
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? (() => undefined);
	}

	async inspect(cwd: string): Promise<WireEvalInventory> {
		let parsed: unknown;
		try {
			parsed = await this.#runner.runJson(resolve(cwd), ["eval", "inventory", "--json"]);
		} catch (error) {
			if (!(error instanceof ClioReadCommandError)) throw error;
			if (error.code === "spawn") {
				throw new ClioEvalInspectError("not-ready", "The GUI could not start Clio Coder's eval inspector.");
			}
			if (error.code === "timeout") {
				throw new ClioEvalInspectError("not-ready", "Clio Coder's eval inspection did not finish in time.");
			}
			if (error.code === "exit") {
				const unsupported =
					/(?:unknown|unsupported|unexpected).{0,32}(?:command|eval|inventory)|inventory.{0,32}(?:unknown|unsupported)/iu
						.test(error.diagnostic);
				this.#log(`Clio Coder eval inspector exited with code ${error.exitCode ?? "unknown"}.`);
				throw new ClioEvalInspectError(
					unsupported ? "unsupported" : "not-ready",
					unsupported
						? "This Clio Coder version does not provide an eval inventory."
						: "Clio Coder could not inspect its stored eval reports.",
				);
			}
			throw new ClioEvalInspectError("internal", "Clio Coder returned an invalid or oversized eval inventory.");
		}
		try {
			return projectEvalInventory(parsed, new Date(this.#now()).toISOString());
		} catch (error) {
			if (!(error instanceof ClioEvalProjectionError)) throw error;
			this.#log("Clio Coder eval projection rejected an incompatible inventory.");
			throw new ClioEvalInspectError(
				"internal",
				"Clio Coder's eval inventory is not compatible with this GUI build.",
			);
		}
	}
}
