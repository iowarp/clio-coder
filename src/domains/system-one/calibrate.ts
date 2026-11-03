/**
 * Measuring a batch LLM route: packaged labeled cases through the same runner,
 * redaction and renderer as production, one label rule per action.
 *
 * A label has no continuous scale to place a margin on, so the rule validates
 * what the label would do directly. It uses the bars `calibration.ts` states for
 * cuts: on holdout a key gets 0 false fires when a false fire spends real work
 * (k 2), and at most 5% of negatives when it is read-only or advisory (k 1), and
 * holdout recall of at least half of fit recall. The same false-fire bar applies
 * on fit, where a key also needs a hit. Holdout is scored once, only for keys that
 * passed fit, and with no fitted number nothing about it can be tuned. Inadequate
 * cases leave a key unavailable: zero false fires on N negatives bounds the rate
 * at about 3/N, so 20 negatives bound it near the 15% a hint can bear.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";
import { pricesCalls } from "../../core/telemetry/pricing.js";
import { calculatePricingCostUsd, type resolveEffectivePricing } from "../providers/catalog.js";
import type { LlmRequestUsage } from "./engines/shared.js";
import type { KeyMeasurement, LabelTally, SiteMeasurement } from "./measurement.js";
import { TOOL_CALL_CARD_SITE, TOOL_CALL_RUNGS, type ToolCallObject } from "./sites/tool-call.js";
import {
	TURN_SITE,
	type TurnObject,
	type TurnRecipeOption,
	WORKER_PREPARE_SITE,
	type WorkerPrepareObject,
} from "./sites/turn.js";
import type { Answer, DecisionRecord, SiteDefinition, SiteId, SystemOne } from "./types.js";

const K1_FALSE_FIRE_BUDGET = 0.05;
const MIN_POSITIVES = 5;
const MIN_NEGATIVES = 20;
/** Consecutive failed calls that end a run, so a dead route does not spend the whole case set. */
const MAX_CONSECUTIVE_FAILURES = 5;
/** A site's deadline over its measured p95: a detached call that misses only loses its reading. */
const DEADLINE_OVER_P95 = 1.5;
const DEADLINE_STEP_MS = 50;

interface Case {
	readonly expect: Readonly<Record<string, unknown>>;
	readonly split?: string;
	readonly [field: string]: unknown;
}

interface Fixture {
	readonly cases: ReadonlyArray<Case>;
	readonly [field: string]: unknown;
}

/** How one action reads a case: a yes on `label`, or the right winner among the labeled options. */
export interface KeySpec {
	readonly key: string;
	readonly label: string;
	readonly k: 1 | 2;
	readonly read: "yes" | "winner";
}

export interface CalibrationSite {
	readonly id: SiteId;
	readonly file: string;
	readonly keys: ReadonlyArray<KeySpec>;
	readonly definition: SiteDefinition<never, unknown>;
	object(fixture: Fixture, testCase: Case): unknown;
	/** The option a label names, in the form the answer reports it. */
	option?(label: unknown): string | null;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function site<O, V>(
	input: Omit<CalibrationSite, "definition" | "object"> & {
		readonly definition: SiteDefinition<O, V>;
		object(fixture: Fixture, testCase: Case): O;
	},
): CalibrationSite {
	return input as unknown as CalibrationSite;
}

/** The sites a route can be measured on, each with a labeled case file that ships in the package. */
export const CALIBRATION_SITES: ReadonlyArray<CalibrationSite> = [
	site<TurnObject, unknown>({
		id: "turn",
		file: "turn.json",
		definition: TURN_SITE,
		keys: [
			{ key: "direct", label: "direct", k: 1, read: "yes" },
			{ key: "dispatch", label: "dispatch", k: 1, read: "yes" },
			{ key: "prewarm", label: "dispatch", k: 2, read: "yes" },
			{ key: "architecture", label: "architecture", k: 1, read: "yes" },
			{ key: "direction", label: "direction", k: 1, read: "yes" },
			{ key: "shape", label: "shape", k: 2, read: "winner" },
		],
		object: (_fixture, testCase) => ({
			task: text(testCase.task),
			previous: text(testCase.previous),
			previousTask: text(testCase.previousTask),
		}),
	}),
	site<WorkerPrepareObject, unknown>({
		id: "workerPrepare",
		file: "worker-prepare.json",
		definition: WORKER_PREPARE_SITE,
		keys: [{ key: "recipe", label: "recipe", k: 2, read: "winner" }],
		object: (fixture, testCase) => ({
			task: text(testCase.task),
			previous: text(testCase.previous),
			previousTask: text(testCase.previousTask),
			recipes: fixture.recipes as ReadonlyArray<TurnRecipeOption>,
		}),
	}),
	site<ToolCallObject, unknown>({
		id: "toolCall",
		file: "tool-calls.json",
		definition: TOOL_CALL_CARD_SITE,
		keys: [
			{ key: "cardFloor", label: "radius", k: 1, read: "winner" },
			{ key: "cardOutside", label: "outside", k: 1, read: "yes" },
			{ key: "cardDestroys", label: "destroys", k: 1, read: "yes" },
		],
		object: (_fixture, testCase) => ({
			tool: text(testCase.tool),
			actionClass: text(testCase.actionClass),
			target: text(testCase.target),
			moment: "card",
		}),
		option: (label) => {
			const index = TOOL_CALL_RUNGS.findIndex((rung) => rung.label === label);
			return index < 0 ? null : String(index);
		},
	}),
];

function readCaseFile(file: string): { fixture: Fixture; sha256: string } {
	const bytes = readFileSync(join(resolvePackageRoot(), "tests", "fixtures", "decision-cases", file));
	return {
		fixture: JSON.parse(bytes.toString("utf8")) as Fixture,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

function splitOf(testCase: Case): "fit" | "holdout" {
	return testCase.split === "holdout" ? "holdout" : "fit";
}

/** Requests a whole run would send: one per case. */
export function planRequests(sites: ReadonlyArray<CalibrationSite>): {
	perSite: Record<string, number>;
	total: number;
} {
	const perSite: Record<string, number> = {};
	let total = 0;
	for (const entry of sites) {
		const { cases } = readCaseFile(entry.file).fixture;
		perSite[entry.id] = cases.length;
		total += cases.length;
	}
	return { perSite, total };
}

function emptyTally(): { positives: number; hits: number; negatives: number; falseFires: number } {
	return { positives: 0, hits: 0, negatives: 0, falseFires: 0 };
}

function answerLabel(answer: Answer | undefined): string | null {
	if (answer === undefined) return null;
	if (answer.type === "choice") return answer.choice ?? null;
	if (answer.type === "score") return answer.score === undefined ? null : String(answer.score);
	return null;
}

/** Adds one case to one key's tally. A case that does not label the key says nothing about it. */
function tallyCase(
	tally: ReturnType<typeof emptyTally>,
	spec: KeySpec,
	label: unknown,
	answer: Answer | undefined,
	option: (label: unknown) => string | null,
): void {
	if (spec.read === "yes") {
		if (typeof label !== "boolean") return;
		const fired = answer?.type === "noul" && answer.noul === 1;
		if (label) {
			tally.positives += 1;
			if (fired) tally.hits += 1;
		} else {
			tally.negatives += 1;
			if (fired) tally.falseFires += 1;
		}
		return;
	}
	const wanted = option(label);
	if (wanted === null) return;
	tally.positives += 1;
	tally.negatives += 1;
	const said = answerLabel(answer);
	if (said === wanted) tally.hits += 1;
	else if (said !== null) tally.falseFires += 1;
}

function falseFiresWithinBudget(spec: KeySpec, tally: LabelTally): boolean {
	if (spec.k === 2) return tally.falseFires === 0;
	return tally.falseFires <= K1_FALSE_FIRE_BUDGET * tally.negatives;
}

function adequate(spec: KeySpec, tally: LabelTally): boolean {
	return tally.positives >= MIN_POSITIVES && (spec.read === "winner" || tally.negatives >= MIN_NEGATIVES);
}

function rate(tally: LabelTally): number {
	return tally.positives === 0 ? 0 : tally.hits / tally.positives;
}

/** Whether a key survives fit, or why it does not. */
export function judgeFit(spec: KeySpec, fit: LabelTally): string | null {
	if (!adequate(spec, fit)) return `too few fit cases (${fit.positives} positive, ${fit.negatives} negative)`;
	if (fit.hits === 0) return "no hit on fit";
	if (!falseFiresWithinBudget(spec, fit)) return `${fit.falseFires}/${fit.negatives} false fires on fit`;
	return null;
}

/** Whether a key survives its one holdout, or why it does not. */
export function judgeHoldout(spec: KeySpec, fit: LabelTally, holdout: LabelTally): string | null {
	if (!adequate(spec, holdout)) {
		return `too few holdout cases (${holdout.positives} positive, ${holdout.negatives} negative)`;
	}
	if (!falseFiresWithinBudget(spec, holdout)) return `${holdout.falseFires}/${holdout.negatives} false fires on holdout`;
	if (rate(holdout) < rate(fit) / 2) return `holdout recall ${holdout.hits}/${holdout.positives} is under half of fit`;
	return null;
}

function percentile(sorted: ReadonlyArray<number>, fraction: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

/** Adds one request to a run's spend. A route with no pricing is reported as unknown, never as free. */
export function addCalibrationSpend(
	spend: { usd: number; unpriced: boolean },
	pricing: ReturnType<typeof resolveEffectivePricing>,
	usage: LlmRequestUsage,
): void {
	if (!pricesCalls(pricing.pricedBy)) {
		spend.unpriced ||= pricing.pricedBy === "none";
		return;
	}
	spend.usd +=
		usage.costUsd ??
		calculatePricingCostUsd(pricing.rates, {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: usage.cacheWrite ?? 0,
			cacheWrite1h: usage.cacheWrite1h ?? 0,
		});
}

export interface SiteRun {
	readonly site: SiteMeasurement;
	readonly keys: Readonly<Record<string, KeyMeasurement>>;
	readonly raw: ReadonlyArray<unknown>;
}

export class CalibrationStopped extends Error {}

/**
 * One site on one route. `next` runs a case and hands back its record; a build
 * other than `build` on any response ends the run, because the measurement would
 * describe no single model.
 */
export async function calibrateSite(input: {
	readonly entry: CalibrationSite;
	readonly build: string;
	readonly system: Pick<SystemOne, "run">;
	readonly takeRecord: () => DecisionRecord | null;
	readonly onProgress?: (done: number, total: number) => void;
}): Promise<SiteRun> {
	const { entry, build, system, takeRecord } = input;
	const { fixture, sha256 } = readCaseFile(entry.file);
	const latencies: number[] = [];
	const raw: unknown[] = [];
	const tokens = { input: 0, output: 0 };
	let requests = 0;
	let failed = 0;
	let consecutive = 0;
	const option = entry.option ?? ((label: unknown) => (typeof label === "string" ? label : null));

	const score = async (split: "fit" | "holdout", specs: ReadonlyArray<KeySpec>): Promise<Map<string, LabelTally>> => {
		const tallies = new Map(specs.map((spec) => [spec.key, emptyTally()]));
		const cases = fixture.cases.filter((testCase) => splitOf(testCase) === split);
		for (const [index, testCase] of cases.entries()) {
			await system.run(entry.definition, entry.object(fixture, testCase) as never);
			const record = takeRecord();
			requests += 1;
			input.onProgress?.(index + 1, cases.length);
			if (record === null || record.outcome !== "answered") {
				failed += 1;
				consecutive += 1;
				if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
					throw new CalibrationStopped(
						`${entry.id}: ${consecutive} calls in a row failed, the last with ${record?.outcome ?? "no record"}: ${record?.error ?? "no detail"}`,
					);
				}
			} else {
				consecutive = 0;
				if (record.build !== build) {
					throw new CalibrationStopped(
						`${entry.id}: the answering identity changed from ${build} to ${record.build}, so this run describes no single model`,
					);
				}
				latencies.push(record.latencyMs);
				tokens.input += record.usage?.input ?? 0;
				tokens.output += record.usage?.output ?? 0;
			}
			const answers = record?.answers ?? {};
			raw.push({
				site: entry.id,
				split,
				index,
				outcome: record?.outcome ?? null,
				latencyMs: record?.latencyMs ?? null,
				answers,
			});
			for (const spec of specs) {
				const tally = tallies.get(spec.key);
				if (tally !== undefined) tallyCase(tally, spec, testCase.expect[spec.label], answers[spec.label], option);
			}
		}
		return tallies;
	};

	const fit = await score("fit", entry.keys);
	const keys: Record<string, KeyMeasurement> = {};
	const survivors: KeySpec[] = [];
	for (const spec of entry.keys) {
		const tally = fit.get(spec.key) as LabelTally;
		const reason = judgeFit(spec, tally);
		if (reason === null) survivors.push(spec);
		else keys[`${entry.id}.${spec.key}`] = { pass: false, k: spec.k, fit: tally, reason };
	}
	if (survivors.length > 0) {
		const holdout = await score("holdout", survivors);
		for (const spec of survivors) {
			const tally = fit.get(spec.key) as LabelTally;
			const held = holdout.get(spec.key) as LabelTally;
			const reason = judgeHoldout(spec, tally, held);
			keys[`${entry.id}.${spec.key}`] = {
				pass: reason === null,
				k: spec.k,
				fit: tally,
				holdout: held,
				...(reason !== null ? { reason } : {}),
			};
		}
	}
	const sorted = [...latencies].sort((left, right) => left - right);
	const p95 = percentile(sorted, 0.95);
	return {
		site: {
			version: entry.definition.version,
			caseSet: sha256,
			requests,
			failed,
			tokens,
			latencyMs: { p50: percentile(sorted, 0.5), p95, max: sorted.at(-1) ?? 0 },
			deadlineMs: Math.ceil((p95 * DEADLINE_OVER_P95) / DEADLINE_STEP_MS) * DEADLINE_STEP_MS,
		},
		keys,
		raw,
	};
}
