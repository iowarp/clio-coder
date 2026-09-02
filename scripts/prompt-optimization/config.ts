/**
 * The experiment configuration and its fail-closed parser.
 *
 * A prompt A/B is only meaningful when every knob except the prompt is pinned,
 * so this parser refuses a configuration rather than defaulting one: a missing
 * temperature is not zero, and an absent target URL is not localhost. The
 * parsed configuration hashes to `experimentHash`, which every trial record
 * carries and every resume checks, so two runs that disagree about the
 * experiment can never share one append-only file.
 */
import { isAbsolute, resolve } from "node:path";
import { canonicalJson, sha256 } from "../../src/domains/prompts/hash.js";
import type {
	PromptAbArmId,
	PromptAbCorpusId,
	PromptAbPhase,
	PromptAbPinnedConfig,
	PromptAbSamplingPins,
	PromptAbStratum,
} from "./contract.js";
import { PROMPT_AB_CONFIG_SCHEMA_V1, PROMPT_AB_HARNESS_VERSION } from "./contract.js";

export class PromptAbConfigError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(`prompt-ab configuration is invalid:\n  ${issues.join("\n  ")}`);
		this.name = "PromptAbConfigError";
		this.issues = issues;
	}
}

export interface PromptAbArmConfig {
	id: PromptAbArmId;
	label: string;
	/** Absolute path to an independently built source checkout of Clio. */
	checkout: string;
	/** Built CLI entry, relative to `checkout`. */
	entry: string;
	/** Commit the checkout is expected to be at; a mismatch fails the run. */
	commit: string | null;
}

export interface PromptAbWarmConfig {
	/**
	 * Fixed conversation prefix replayed before the scenario's final turn. Warm
	 * trials vary only that last turn, which is the only way a cache-read ratio
	 * says something about the prompt rather than about the conversation.
	 */
	prefixTurns: readonly string[];
}

export interface PromptAbExperimentConfig {
	schema: typeof PROMPT_AB_CONFIG_SCHEMA_V1;
	harnessVersion: number;
	experimentId: string;
	seed: number;
	repetitions: number;
	corpus: PromptAbCorpusId;
	phase: PromptAbPhase;
	strata: readonly PromptAbStratum[];
	arms: readonly PromptAbArmConfig[];
	pinned: PromptAbPinnedConfig;
	warm: PromptAbWarmConfig;
	/** Absolute directory holding the manifest, the append-only trial log, and retained transcripts. */
	outDir: string;
	/** Seconds to hold after a cache reset before a cold trial starts. */
	coldResetSettleMs: number;
	/** Command that resets the serving cache before each cold trial; null means the operator does it. */
	coldResetCommand: string | null;
}

const ARM_IDS: readonly PromptAbArmId[] = ["A", "B", "B2"];
const STRATA: readonly PromptAbStratum[] = ["cold", "warm"];
const CORPORA: readonly PromptAbCorpusId[] = ["development", "holdout"];
const PHASES: readonly PromptAbPhase[] = ["tuning", "frozen"];
const AUTONOMY_LEVELS = ["read-only", "suggest", "auto-edit", "full-auto"] as const;
const SAMPLING_KEYS: ReadonlyArray<keyof PromptAbSamplingPins> = [
	"temperature",
	"topP",
	"topK",
	"minP",
	"repeatPenalty",
	"presencePenalty",
	"frequencyPenalty",
];

/**
 * Parse a configuration object, collecting every problem before throwing.
 *
 * `baseDir` resolves relative checkout and output paths so a configuration
 * file can sit beside the checkouts it names.
 */
export function parsePromptAbConfig(value: unknown, baseDir: string): PromptAbExperimentConfig {
	const issues: string[] = [];
	const record = asRecord(value, "$", issues);
	if (record === null) throw new PromptAbConfigError(issues);

	if (record.schema !== PROMPT_AB_CONFIG_SCHEMA_V1) {
		issues.push(`$.schema: expected ${PROMPT_AB_CONFIG_SCHEMA_V1}`);
	}
	const harnessVersion = readInteger(record.harnessVersion, "$.harnessVersion", issues, 1, 1_000);
	if (harnessVersion !== null && harnessVersion !== PROMPT_AB_HARNESS_VERSION) {
		issues.push(`$.harnessVersion: this harness is version ${PROMPT_AB_HARNESS_VERSION}`);
	}
	const experimentId = readSlug(record.experimentId, "$.experimentId", issues);
	const seed = readInteger(record.seed, "$.seed", issues, 0, Number.MAX_SAFE_INTEGER);
	const repetitions = readInteger(record.repetitions, "$.repetitions", issues, 1, 200);
	const corpus = readEnum(record.corpus, "$.corpus", CORPORA, issues);
	const phase = readEnum(record.phase, "$.phase", PHASES, issues);
	const strata = readStrata(record.strata, issues);
	const arms = readArms(record.arms, baseDir, issues);
	const pinned = readPinned(record.pinned, issues);
	const warm = readWarm(record.warm, strata, issues);
	const outDir = readPath(record.outDir, "$.outDir", baseDir, issues);
	const coldResetSettleMs = readInteger(record.coldResetSettleMs, "$.coldResetSettleMs", issues, 0, 600_000);
	const coldResetCommand = readNullableString(record.coldResetCommand, "$.coldResetCommand", issues);

	if (
		experimentId === null ||
		seed === null ||
		repetitions === null ||
		corpus === null ||
		phase === null ||
		strata === null ||
		arms === null ||
		pinned === null ||
		warm === null ||
		outDir === null ||
		coldResetSettleMs === null ||
		issues.length > 0
	) {
		throw new PromptAbConfigError(issues.length > 0 ? issues : ["$: configuration could not be read"]);
	}

	return {
		schema: PROMPT_AB_CONFIG_SCHEMA_V1,
		harnessVersion: PROMPT_AB_HARNESS_VERSION,
		experimentId,
		seed,
		repetitions,
		corpus,
		phase,
		strata,
		arms,
		pinned,
		warm,
		outDir,
		coldResetSettleMs,
		coldResetCommand,
	};
}

/**
 * Identity of everything that decides which trials exist and what they mean.
 *
 * `outDir` is deliberately excluded: moving a run directory does not change
 * the experiment. Arm checkouts are included by path *and* expected commit
 * because pointing an arm at a different tree is a different experiment even
 * when nothing else moves.
 */
export function promptAbExperimentHash(config: PromptAbExperimentConfig): string {
	return sha256(
		canonicalJson({
			schema: config.schema,
			harnessVersion: config.harnessVersion,
			experimentId: config.experimentId,
			seed: config.seed,
			repetitions: config.repetitions,
			corpus: config.corpus,
			phase: config.phase,
			strata: config.strata,
			arms: config.arms.map((arm) => ({ id: arm.id, checkout: arm.checkout, entry: arm.entry, commit: arm.commit })),
			pinned: config.pinned,
			warm: config.warm,
			coldResetSettleMs: config.coldResetSettleMs,
			coldResetCommand: config.coldResetCommand,
		}),
	);
}

function readArms(value: unknown, baseDir: string, issues: string[]): PromptAbArmConfig[] | null {
	if (!Array.isArray(value)) {
		issues.push("$.arms: expected an array of exactly two arms");
		return null;
	}
	if (value.length !== 2) {
		issues.push(`$.arms: a paired comparison needs exactly two arms, got ${value.length}`);
	}
	const arms: PromptAbArmConfig[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of value.entries()) {
		const path = `$.arms[${index}]`;
		const record = asRecord(entry, path, issues);
		if (record === null) continue;
		const id = readEnum(record.id, `${path}.id`, ARM_IDS, issues);
		const label = readNonEmptyString(record.label, `${path}.label`, issues);
		const checkout = readPath(record.checkout, `${path}.checkout`, baseDir, issues);
		const entryPath = readNonEmptyString(record.entry, `${path}.entry`, issues);
		const commit = readNullableString(record.commit, `${path}.commit`, issues);
		if (entryPath !== null && isAbsolute(entryPath)) {
			issues.push(`${path}.entry: expected a path relative to the arm checkout`);
		}
		if (commit !== null && !/^[0-9a-f]{7,40}$/u.test(commit)) {
			issues.push(`${path}.commit: expected an abbreviated or full lowercase hex commit`);
		}
		if (id !== null) {
			if (seen.has(id)) issues.push(`${path}.id: arm ${id} is declared twice`);
			seen.add(id);
		}
		if (id === null || label === null || checkout === null || entryPath === null) continue;
		arms.push({ id, label, checkout, entry: entryPath, commit });
	}
	if (arms.length === 2 && arms[0]?.checkout === arms[1]?.checkout) {
		issues.push("$.arms: both arms name the same checkout; a prompt A/B needs two independently built trees");
	}
	return arms.length === value.length ? arms : null;
}

function readPinned(value: unknown, issues: string[]): PromptAbPinnedConfig | null {
	const record = asRecord(value, "$.pinned", issues);
	if (record === null) return null;
	const target = readNonEmptyString(record.target, "$.pinned.target", issues);
	const model = readNonEmptyString(record.model, "$.pinned.model", issues);
	const runtime = readNonEmptyString(record.runtime, "$.pinned.runtime", issues);
	const thinking = readNonEmptyString(record.thinking, "$.pinned.thinking", issues);
	const autonomy = readEnum(record.autonomy, "$.pinned.autonomy", AUTONOMY_LEVELS, issues);
	const toolProfile = readNullableString(record.toolProfile, "$.pinned.toolProfile", issues);
	const maxContextTokens = readInteger(record.maxContextTokens, "$.pinned.maxContextTokens", issues, 1, 10_000_000);
	const kvCacheMode = readNullableString(record.kvCacheMode, "$.pinned.kvCacheMode", issues);
	const serverConcurrency = readInteger(record.serverConcurrency, "$.pinned.serverConcurrency", issues, 1, 1_024);
	const targetUrl = readNonEmptyString(record.targetUrl, "$.pinned.targetUrl", issues);
	if (targetUrl !== null && !/^https?:\/\//u.test(targetUrl)) {
		issues.push("$.pinned.targetUrl: expected an http(s) URL");
	}
	const sampling = readSampling(record.sampling, issues);
	if (
		target === null ||
		model === null ||
		runtime === null ||
		thinking === null ||
		autonomy === null ||
		maxContextTokens === null ||
		serverConcurrency === null ||
		targetUrl === null ||
		sampling === null
	) {
		return null;
	}
	return {
		target,
		model,
		runtime,
		thinking,
		autonomy,
		toolProfile,
		maxContextTokens,
		kvCacheMode,
		sampling,
		serverConcurrency,
		targetUrl,
	};
}

function readSampling(value: unknown, issues: string[]): PromptAbSamplingPins | null {
	const record = asRecord(value, "$.pinned.sampling", issues);
	if (record === null) return null;
	const read: Partial<Record<keyof PromptAbSamplingPins, number>> = {};
	for (const key of SAMPLING_KEYS) {
		const entry = record[key];
		if (typeof entry !== "number" || !Number.isFinite(entry)) {
			issues.push(`$.pinned.sampling.${key}: expected a finite number; sampling is pinned, never defaulted`);
			continue;
		}
		read[key] = entry;
	}
	if (SAMPLING_KEYS.some((key) => read[key] === undefined)) return null;
	return {
		temperature: read.temperature as number,
		topP: read.topP as number,
		topK: read.topK as number,
		minP: read.minP as number,
		repeatPenalty: read.repeatPenalty as number,
		presencePenalty: read.presencePenalty as number,
		frequencyPenalty: read.frequencyPenalty as number,
	};
}

function readWarm(
	value: unknown,
	strata: readonly PromptAbStratum[] | null,
	issues: string[],
): PromptAbWarmConfig | null {
	const record = asRecord(value, "$.warm", issues);
	if (record === null) return null;
	const turns = record.prefixTurns;
	if (!Array.isArray(turns) || turns.some((turn) => typeof turn !== "string" || turn.length === 0)) {
		issues.push("$.warm.prefixTurns: expected an array of non-empty strings");
		return null;
	}
	if (strata?.includes("warm") === true && turns.length === 0) {
		issues.push("$.warm.prefixTurns: the warm stratum needs a fixed prefix to warm the cache with");
	}
	return { prefixTurns: turns as string[] };
}

function readStrata(value: unknown, issues: string[]): PromptAbStratum[] | null {
	if (!Array.isArray(value) || value.length === 0) {
		issues.push("$.strata: expected a non-empty array");
		return null;
	}
	const strata: PromptAbStratum[] = [];
	for (const [index, entry] of value.entries()) {
		const stratum = readEnum(entry, `$.strata[${index}]`, STRATA, issues);
		if (stratum === null) continue;
		if (strata.includes(stratum)) issues.push(`$.strata[${index}]: ${stratum} is listed twice`);
		else strata.push(stratum);
	}
	return strata.length > 0 ? strata : null;
}

function readPath(value: unknown, path: string, baseDir: string, issues: string[]): string | null {
	const raw = readNonEmptyString(value, path, issues);
	if (raw === null) return null;
	return resolve(baseDir, raw);
}

function readSlug(value: unknown, path: string, issues: string[]): string | null {
	const raw = readNonEmptyString(value, path, issues);
	if (raw === null) return null;
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(raw)) {
		issues.push(`${path}: expected a lowercase slug usable as a directory name`);
		return null;
	}
	return raw;
}

function readEnum<T extends string>(value: unknown, path: string, allowed: readonly T[], issues: string[]): T | null {
	if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
	issues.push(`${path}: expected one of ${allowed.join("|")}`);
	return null;
}

function readInteger(value: unknown, path: string, issues: string[], min: number, max: number): number | null {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		issues.push(`${path}: expected an integer in [${min}, ${max}]`);
		return null;
	}
	return value;
}

function readNonEmptyString(value: unknown, path: string, issues: string[]): string | null {
	if (typeof value !== "string" || value.length === 0) {
		issues.push(`${path}: expected a non-empty string`);
		return null;
	}
	return value;
}

function readNullableString(value: unknown, path: string, issues: string[]): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || value.length === 0) {
		issues.push(`${path}: expected a non-empty string or null`);
		return null;
	}
	return value;
}

function asRecord(value: unknown, path: string, issues: string[]): Record<string, unknown> | null {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	issues.push(`${path}: expected an object`);
	return null;
}
