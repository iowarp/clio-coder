/**
 * Score a System One site's wording against its labeled fixture, live.
 *
 *   node --import tsx scripts/decision-probe.ts <fixture> --engine <name> [--runs 3] [--json] [--cases]
 *        [--kind systemone|llm --target T --model M --mode auto|logprobs|answer] [--site toolCall.gate]
 *        [--deadline MS] [--split broad] [--limit N] [--recipes]
 *
 * It **calls the named engine** and is never part of CI. The engine comes from
 * `systemOne.engines` in the operator's settings, or from `--kind`, `--target`
 * and `--model` when the settings lack that name. Settings are read leniently:
 * keys the schema no longer knows are reported and ignored, so the probe works
 * mid-migration. Nothing is written back to the settings file.
 *
 * A fixture names its site (`turn`, `turnEnd`, `toolCall`, `toolResult` or
 * `relevance`) and every case carries `expect`, a map from a question id or a
 * value field to a label. Each case goes through `createSystemOne` exactly as
 * production does, with an in-memory recorder that keeps the raw answers.
 *
 * For each labeled key the report gives, per run: how many answers agreed,
 * abstained (inside the site's certainty band, or an unsure choice), were
 * wrong, or were confidently wrong; the probability ranges of the positive and
 * negative classes; and a suggested cut with its margin to each side, which is
 * null when the classes overlap. The answering build is printed because a cut
 * belongs to one build. `--cases` writes one JSON line per call to stderr.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateSettingsFile } from "../src/core/config.js";
import { openAuthStorage, resolveAuthTarget } from "../src/domains/providers/auth/index.js";
import type { ProvidersContract } from "../src/domains/providers/contract.js";
import { BUILTIN_RUNTIMES } from "../src/domains/providers/runtimes/builtins.js";
import type {
	Answer,
	DecisionRecord,
	DecisionRecorder,
	Question,
	SiteDefinition,
	SiteId,
} from "../src/domains/system-one/index.js";
import { createSystemOne } from "../src/domains/system-one/index.js";
import { RELEVANCE_SITE, type RelevanceObject } from "../src/domains/system-one/sites/relevance.js";
import {
	TOOL_CALL_CARD_SITE,
	TOOL_CALL_GATE_SITE,
	TOOL_CALL_RUNGS,
	type ToolCallObject,
} from "../src/domains/system-one/sites/tool-call.js";
import { TOOL_RESULT_SITE, type ToolResultObject } from "../src/domains/system-one/sites/tool-result.js";
import { TURN_SITE, type TurnObject, type TurnRecipeOption } from "../src/domains/system-one/sites/turn.js";
import { TURN_END_SITE, type TurnEndObject } from "../src/domains/system-one/sites/turn-end.js";

/** A probability this close to the coin-flip is an abstention, the band the sites' readers use. */
const DECIDED = 0.2;
/** A wrong answer this far from the coin-flip is the failure a hint or a gate cannot absorb. */
const CONFIDENT = 0.6;
/** The gateway's own related-entry rule (`src/tools/gateway/index.ts`), mirrored so the probe reports what a find would surface. */
const RELATED_MIN_SCORE = 0.5;
const RELATED_MAX = 5;
/** Certainty floors the turn site applies to its choices, mirrored here so a grade means what the site did. */
const CHOICE_FLOOR: Readonly<Record<string, number>> = { shape: 0.5, intent: 0.6, breadth: 0.5, recipe: 0.6 };
/** The card shows a rung only when the radius answer is this peaked. */
const RUNG_FLOOR = 0.25;

type Grade = "agree" | "abstain" | "wrong" | "confident-wrong" | "missing";
type Label = boolean | string;

interface Case {
	expect: Record<string, Label>;
	[field: string]: unknown;
}

interface Fixture {
	description?: string;
	site: string;
	cases: Case[];
	[field: string]: unknown;
}

/** What the probe needs to drive one fixture: the site, an object per case, and how to read a label. */
interface Driver<O, V> {
	site: SiteDefinition<O, V>;
	object(fixture: Fixture, testCase: Case): O;
}

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string): never {
	process.stderr.write(`decision-probe: ${message}\n`);
	process.exit(2);
}

function driverFor(fixture: Fixture): Driver<never, unknown> {
	const asDriver = <O, V>(driver: Driver<O, V>): Driver<never, unknown> => driver as unknown as Driver<never, unknown>;
	switch (fixture.site) {
		case "turn":
			return asDriver<TurnObject, unknown>({
				site: TURN_SITE,
				object: (source, testCase) => ({
					task: String(testCase.task),
					previous: typeof testCase.previous === "string" ? testCase.previous : "",
					previousTask: typeof testCase.previousTask === "string" ? testCase.previousTask : "",
					...((testCase.recipes === true || process.argv.includes("--recipes")) && Array.isArray(source.recipes)
						? { recipes: source.recipes as TurnRecipeOption[] }
						: {}),
				}),
			});
		case "turnEnd":
			return asDriver<TurnEndObject, unknown>({
				site: TURN_END_SITE,
				object: (_source, testCase) => ({
					request: String(testCase.request),
					message: String(testCase.message),
					earlier: Array.isArray(testCase.earlier) ? (testCase.earlier as string[]) : [],
					tools: Array.isArray(testCase.tools) ? (testCase.tools as string[]) : [],
				}),
			});
		case "toolResult":
			return asDriver<ToolResultObject, unknown>({
				site: TOOL_RESULT_SITE,
				object: (_source, testCase) => ({ source: String(testCase.source), content: String(testCase.content) }),
			});
		case "toolCall": {
			const gate = argValue("--site") === "toolCall.gate";
			return asDriver<ToolCallObject, unknown>({
				site: gate ? TOOL_CALL_GATE_SITE : TOOL_CALL_CARD_SITE,
				object: (_source, testCase) => ({
					tool: String(testCase.tool),
					actionClass: String(testCase.actionClass),
					target: String(testCase.target),
					moment: gate ? "gate" : "card",
				}),
			});
		}
		default:
			return fail(`fixture site '${fixture.site}' is not one this probe can drive`);
	}
}

/** The operator's settings, read without failing on keys this checkout no longer knows. */
function lenientSettings() {
	const { settings, issues } = validateSettingsFile();
	if (issues.length > 0) {
		process.stderr.write(
			`decision-probe: settings has ${issues.length} issue(s), ignored: ${issues
				.slice(0, 4)
				.map((issue) => issue.path)
				.join(", ")}${issues.length > 4 ? ", ..." : ""}\n`,
		);
	}
	return settings;
}

function buildSystemOne(siteId: SiteId, recorder: DecisionRecorder) {
	const settings = lenientSettings();
	const name = argValue("--engine");
	if (name === undefined) fail("--engine <name> is required");
	const configured = Object.hasOwn(settings.systemOne.engines, name) ? settings.systemOne.engines[name] : undefined;
	const kind = argValue("--kind");
	const target = argValue("--target");
	if (configured === undefined) {
		if (kind !== "systemone" && kind !== "llm")
			fail(`engine '${name}' is not in systemOne.engines; give --kind systemone|llm`);
		if (target === undefined) fail("--target T is required with --kind");
	}
	const model = argValue("--model");
	const mode = argValue("--mode") as "auto" | "logprobs" | "answer" | undefined;
	const engine: (typeof settings.systemOne.engines)[string] = configured ?? {
		kind: kind as "systemone" | "llm",
		target: target as string,
		...(model !== undefined ? { model } : {}),
		...(mode !== undefined && kind === "llm" ? { mode } : {}),
	};
	if (!settings.targets.some((entry) => entry.id === engine.target))
		fail(`target '${engine.target}' is not in settings.targets`);
	// A probe measures answers, so the binding's deadline is generous by default;
	// the latency report says how the calls sat against the site's own deadline.
	const timeoutMs = Number(argValue("--deadline") ?? 60_000);
	const live = {
		...settings,
		systemOne: {
			...settings.systemOne,
			engines: { [name]: engine },
			sites: { [siteId]: { engine: name, timeoutMs } },
			cuts: {},
		},
	};
	const auth = openAuthStorage();
	const providers = {
		getTarget: (id: string) => settings.targets.find((entry) => entry.id === id) ?? null,
		getRuntime: (id: string) => BUILTIN_RUNTIMES.find((runtime) => runtime.id === id) ?? null,
		auth: {
			resolveForTarget: (
				descriptor: Parameters<typeof resolveAuthTarget>[0],
				runtime: Parameters<typeof resolveAuthTarget>[1],
				options?: { signal?: AbortSignal },
			) => auth.resolveForTarget(resolveAuthTarget(descriptor, runtime), options ?? {}),
		},
	} as unknown as ProvidersContract;
	return {
		name,
		engine,
		system: createSystemOne({
			settings: () => live,
			providers,
			credentialsPresent: () => new Set<string>(),
			recorder: () => recorder,
		}),
	};
}

// ---- grading ---------------------------------------------------------------

function certaintyOf(p: number): number {
	return Math.abs(p * 2 - 1);
}

export function gradeProbability(expected: boolean, p: number | undefined): Grade {
	if (p === undefined) return "missing";
	const certainty = certaintyOf(p);
	if (certainty < DECIDED) return "abstain";
	if (p >= 0.5 === expected) return "agree";
	return certainty >= CONFIDENT ? "confident-wrong" : "wrong";
}

export function gradeChoice(expected: string, answer: Answer | undefined, floor: number): Grade {
	if (answer === undefined || answer.type !== "choice" || answer.choice === undefined) return "missing";
	// The site reads an unsure choice as its "unknown" option, so that label is met by either.
	if (expected === "unknown" && (answer.choice === "unknown" || answer.certainty < floor)) return "agree";
	if (answer.certainty < floor) return "abstain";
	if (answer.choice === expected) return "agree";
	return answer.certainty >= CONFIDENT ? "confident-wrong" : "wrong";
}

/** The rung a ladder position rounds to, by the card's own rule. */
function rungIndex(score: number): number {
	return Math.min(TOOL_CALL_RUNGS.length - 1, Math.max(0, Math.round(score)));
}

export function gradeRung(expected: string, answer: Answer | undefined): Grade {
	if (answer === undefined || answer.type !== "score" || answer.score === undefined) return "missing";
	if (answer.certainty < RUNG_FLOOR) return "abstain";
	const want = TOOL_CALL_RUNGS.findIndex((rung) => rung.label === expected);
	if (want < 0) return "missing";
	if (rungIndex(answer.score) === want) return "agree";
	return answer.certainty >= CONFIDENT ? "confident-wrong" : "wrong";
}

/** One number per labeled key per call, for the class ranges and the cut. */
function scalar(answer: Answer | undefined): number | undefined {
	if (answer === undefined) return undefined;
	if (answer.type === "noul") return answer.noul;
	// The gate's cut sits on the rung position divided by the top rung, so the
	// probe reports the same scale a `toolCall.gateRadius` cut is written on.
	if (answer.type === "score" && answer.score !== undefined) return answer.score / (TOOL_CALL_RUNGS.length - 1);
	return undefined;
}

interface KeyTally {
	counts: Record<Grade, number>;
	/** Per run: the scalar for every positive and negative case. */
	positives: number[][];
	negatives: number[][];
	kind: "noul" | "choice" | "score";
}

const GRADES: Grade[] = ["agree", "abstain", "wrong", "confident-wrong", "missing"];

function emptyTally(kind: KeyTally["kind"], runs: number): KeyTally {
	return {
		counts: { agree: 0, abstain: 0, wrong: 0, "confident-wrong": 0, missing: 0 },
		positives: Array.from({ length: runs }, () => []),
		negatives: Array.from({ length: runs }, () => []),
		kind,
	};
}

function range(values: number[]): string {
	if (values.length === 0) return "none";
	return `${Math.min(...values).toFixed(2)}..${Math.max(...values).toFixed(2)}`;
}

/**
 * A cut between the classes: the midpoint of the gap between the highest
 * negative and the lowest positive, with the margin to each side. Null when
 * the classes overlap, because no cut then separates them.
 */
export function suggestCut(
	positives: ReadonlyArray<number>,
	negatives: ReadonlyArray<number>,
): { cut: number; abovePositives: number; belowNegatives: number } | null {
	if (positives.length === 0 || negatives.length === 0) return null;
	const lowestPositive = Math.min(...positives);
	const highestNegative = Math.max(...negatives);
	if (highestNegative >= lowestPositive) return null;
	const cut = (lowestPositive + highestNegative) / 2;
	return { cut, abovePositives: lowestPositive - cut, belowNegatives: cut - highestNegative };
}

function median(values: number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

// ---- relevance -------------------------------------------------------------

async function probeRelevance(fixture: Fixture, runs: number): Promise<void> {
	const catalog = fixture.catalog as Array<{ name: string; description: string }>;
	const cases = fixture.cases as unknown as Array<{ query: string; task: string; expect: string }>;
	const records: DecisionRecord[] = [];
	const { system, engine } = buildSystemOne("relevance", {
		decision: (row) => records.push(row),
		outcome: () => undefined,
	});
	const use = (fixture.use as RelevanceObject["use"] | undefined) ?? "capabilities";
	const latencies: number[] = [];
	let lexical = 0;
	let withRelated = 0;
	let top1 = 0;
	let top5 = 0;
	let unranked = 0;
	const misses: string[] = [];
	for (let run = 0; run < runs; run += 1) {
		for (const turn of cases) {
			const needle = turn.query.toLowerCase();
			const hits = new Set(
				catalog
					.filter((entry) => entry.name.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle))
					.map((entry) => entry.name),
			);
			const started = performance.now();
			const verdict = await system.run(RELEVANCE_SITE, {
				use,
				need: turn.query,
				task: turn.task,
				candidates: catalog.map((entry) => ({ id: entry.name, summary: entry.description })),
			});
			latencies.push(performance.now() - started);
			const scores = verdict?.value.scores ?? {};
			if (verdict === null) unranked += 1;
			const order = catalog
				.filter((entry) => scores[entry.name] !== undefined)
				.sort((left, right) => (scores[right.name] ?? 0) - (scores[left.name] ?? 0))
				.map((entry) => entry.name);
			const position = order.indexOf(turn.expect);
			if (position === 0) top1 += 1;
			if (position >= 0 && position < 5) top5 += 1;
			const related = order
				.filter((name) => !hits.has(name) && (scores[name] ?? 0) >= RELATED_MIN_SCORE)
				.slice(0, RELATED_MAX);
			if (hits.has(turn.expect)) lexical += 1;
			if (hits.has(turn.expect) || related.includes(turn.expect)) withRelated += 1;
			else {
				misses.push(`run ${run} "${turn.query}": want ${turn.expect} (score ${scores[turn.expect]?.toFixed(2) ?? "none"})`);
			}
		}
	}
	const total = cases.length * runs;
	const builds = [...new Set(records.map((row) => row.build).filter((build): build is string => build !== null))];
	const p50 = Math.round(median(latencies));
	const max = Math.round(Math.max(0, ...latencies));
	if (process.argv.includes("--json")) {
		process.stdout.write(
			`${JSON.stringify({ fixture: process.argv[2], engine: engine.target, builds, runs, latencyMs: { p50, max }, lexical, withRelated, top1, top5, unranked, total, misses }, null, 2)}\n`,
		);
		return;
	}
	process.stdout.write(
		`relevance/${use} ${catalog.length} entries  builds ${builds.join(", ") || "none"}  p50 ${p50}ms  max ${max}ms\n`,
	);
	process.stdout.write(`substring filter alone   ${lexical}/${total}\n`);
	process.stdout.write(`with related entries     ${withRelated}/${total}\n`);
	process.stdout.write(`ranking recall@1 ${top1}/${total}  recall@5 ${top5}/${total}  no opinion ${unranked}\n`);
	for (const miss of misses) process.stdout.write(`  ${miss}\n`);
	for (const row of records.filter((entry) => entry.outcome !== "answered").slice(0, 5)) {
		process.stdout.write(`  unanswered: ${row.outcome} after ${row.latencyMs}ms: ${row.error ?? "no detail"}\n`);
	}
}

// ---- labeled sites ---------------------------------------------------------

async function probeLabeled(fixture: Fixture, runs: number): Promise<void> {
	const driver = driverFor(fixture);
	const records: DecisionRecord[] = [];
	const { system, engine } = buildSystemOne(driver.site.id, {
		decision: (row) => records.push(row),
		outcome: () => undefined,
	});
	const tally = new Map<string, KeyTally>();
	const misses: string[] = [];
	const latencies: number[] = [];
	const builds = new Set<string>();
	let overDeadline = 0;

	for (let run = 0; run < runs; run += 1) {
		for (const testCase of fixture.cases) {
			const object = driver.object(fixture, testCase);
			const before = records.length;
			await system.run(driver.site as SiteDefinition<never, unknown>, object as never);
			const record = records.length > before ? (records[records.length - 1] as DecisionRecord) : null;
			if (record === null) continue;
			latencies.push(record.latencyMs);
			if (record.latencyMs > driver.site.deadlineMs) overDeadline += 1;
			if (record.build !== null) builds.add(record.build);
			const answers = record.answers ?? {};
			if (process.argv.includes("--cases")) {
				const values = Object.fromEntries(
					Object.entries(answers).map(([id, answer]) => [
						id,
						answer.type === "noul"
							? round(answer.noul)
							: answer.type === "choice"
								? `${answer.choice}@${round(answer.certainty)}`
								: round(answer.score),
					]),
				);
				process.stderr.write(
					`${JSON.stringify({ run, outcome: record.outcome, expect: testCase.expect, values, case: labelOf(testCase) })}\n`,
				);
			}
			for (const [key, expected] of Object.entries(testCase.expect)) {
				// A label that is neither a boolean nor an option name is no label.
				if (typeof expected !== "boolean" && typeof expected !== "string") continue;
				const question = record.questions[key] as Question | undefined;
				if (question === undefined) continue;
				const kind = question.type === "noul" ? "noul" : question.type === "choice" ? "choice" : "score";
				const entry = tally.get(key) ?? emptyTally(kind, runs);
				tally.set(key, entry);
				const answer = answers[key];
				const result = gradeAnswer(key, expected, question, answer);
				entry.counts[result] += 1;
				const value = scalar(answer);
				if (value !== undefined) {
					const positive = isPositive(expected, question);
					(positive ? entry.positives : entry.negatives)[run]?.push(value);
				}
				if (result !== "agree") {
					misses.push(
						`run ${run} ${key} ${result}: got ${describe(answer)}, want ${String(expected)} | ${labelOf(testCase)}`,
					);
				}
			}
		}
	}

	const buildList = [...builds];
	const failedCalls = records.filter((row) => row.outcome !== "answered");
	if (process.argv.includes("--json")) {
		const report = {
			fixture: process.argv[2],
			site: driver.site.id,
			siteVersion: driver.site.version,
			engine: engine.target,
			builds: buildList,
			runs,
			deadlineMs: driver.site.deadlineMs,
			latencyMs: { p50: Math.round(median(latencies)), max: Math.round(Math.max(0, ...latencies)), overDeadline },
			keys: Object.fromEntries([...tally].map(([key, entry]) => [key, keyReport(entry)])),
			misses,
			failedCalls: failedCalls.map((row) => ({
				outcome: row.outcome,
				latencyMs: row.latencyMs,
				error: row.error ?? null,
			})),
		};
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return;
	}
	process.stdout.write(
		`${driver.site.id} ${driver.site.version}  engine ${engine.target}  build ${buildList.join(", ") || "none"}  ${fixture.cases.length} cases x ${runs} runs\n`,
	);
	process.stdout.write(
		`latency p50 ${Math.round(median(latencies))}ms  max ${Math.round(Math.max(0, ...latencies))}ms  over the ${driver.site.deadlineMs}ms site deadline ${overDeadline}/${latencies.length}\n`,
	);
	for (const [key, entry] of tally) printKey(key, entry);
	for (const miss of misses) process.stdout.write(`  ${miss}\n`);
	for (const row of failedCalls.slice(0, 5)) {
		process.stdout.write(`  unanswered: ${row.outcome} after ${row.latencyMs}ms: ${row.error ?? "no detail"}\n`);
	}
}

function round(value: number | undefined): number | null {
	return value === undefined ? null : Math.round(value * 100) / 100;
}

function labelOf(testCase: Case): string {
	const text = ["task", "request", "target", "source"]
		.map((field) => testCase[field])
		.find((value) => typeof value === "string");
	return String(text ?? "")
		.replace(/\s+/g, " ")
		.slice(0, 80);
}

function describe(answer: Answer | undefined): string {
	if (answer === undefined) return "no answer";
	if (answer.type === "noul") return (answer.noul ?? Number.NaN).toFixed(2);
	if (answer.type === "choice") return `${answer.choice} (certainty ${answer.certainty.toFixed(2)})`;
	return `${(answer.score ?? Number.NaN).toFixed(2)} (certainty ${answer.certainty.toFixed(2)})`;
}

/** The class a label puts a case in, for the cut: true, or a rung at or above the split. */
function isPositive(expected: Label, question: Question): boolean {
	if (typeof expected === "boolean") return expected;
	if (question.type !== "score") return false;
	const split = TOOL_CALL_RUNGS.findIndex((rung) => rung.label === (argValue("--split") ?? "broad"));
	return TOOL_CALL_RUNGS.findIndex((rung) => rung.label === expected) >= split;
}

function gradeAnswer(key: string, expected: Label, question: Question, answer: Answer | undefined): Grade {
	if (question.type === "noul")
		return typeof expected === "boolean" ? gradeProbability(expected, answer?.noul) : "missing";
	if (question.type === "choice") {
		return typeof expected === "string" ? gradeChoice(expected, answer, CHOICE_FLOOR[key] ?? 0.5) : "missing";
	}
	return typeof expected === "string" ? gradeRung(expected, answer) : "missing";
}

function keyReport(entry: KeyTally) {
	const positives = entry.positives.flat();
	const negatives = entry.negatives.flat();
	const suggestion = suggestCut(positives, negatives);
	return {
		counts: entry.counts,
		perRun: entry.positives.map((run, index) => ({
			positives: range(run),
			negatives: range(entry.negatives[index] ?? []),
		})),
		suggestedCut: suggestion === null ? null : { ...suggestion },
	};
}

function printKey(key: string, entry: KeyTally): void {
	const total = GRADES.reduce((sum, grade) => sum + entry.counts[grade], 0);
	const counts = entry.counts;
	process.stdout.write(
		`${key.padEnd(20)} ${counts.agree}/${total} agree, ${counts.abstain} abstain, ${counts.wrong} wrong, ${counts["confident-wrong"]} confident-wrong, ${counts.missing} missing\n`,
	);
	if (entry.kind === "choice") return;
	const scale = entry.kind === "score" ? "radius/3 " : "";
	for (const [run, positives] of entry.positives.entries()) {
		process.stdout.write(
			`  run ${run}  ${scale}positive ${range(positives)}  negative ${range(entry.negatives[run] ?? [])}\n`,
		);
	}
	const suggestion = suggestCut(entry.positives.flat(), entry.negatives.flat());
	const bothClasses = entry.positives.flat().length > 0 && entry.negatives.flat().length > 0;
	process.stdout.write(
		suggestion === null
			? `  suggested cut: none, ${bothClasses ? "the classes overlap" : "the labels hold only one class"}\n`
			: `  suggested cut ${suggestion.cut.toFixed(2)}  margin ${suggestion.belowNegatives.toFixed(2)} above the highest negative, ${suggestion.abovePositives.toFixed(2)} below the lowest positive\n`,
	);
}

async function main(): Promise<void> {
	const path = process.argv[2];
	if (path === undefined || path.startsWith("--")) {
		fail(
			"usage: decision-probe.ts <fixture.json> --engine <name> [--runs N] [--json] [--cases] [--kind K --target T --model M]",
		);
	}
	const fixture = JSON.parse(readFileSync(path, "utf8")) as Fixture;
	const limit = argValue("--limit");
	if (limit !== undefined) fixture.cases = fixture.cases.slice(0, Number(limit));
	const runs = Number(argValue("--runs") ?? 3);
	if (!Number.isInteger(runs) || runs < 1) fail("--runs must be a positive integer");
	if (fixture.site === "relevance") await probeRelevance(fixture, runs);
	else await probeLabeled(fixture, runs);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
