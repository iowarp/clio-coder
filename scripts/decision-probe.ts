/**
 * Score a decision site's wording against its labeled fixture, live.
 *
 * Criteria wording is the quality lever for a System One site: jev-latest
 * follows the text literally, so a rung or an option description that reads
 * two ways gets answered the way it reads. Every wording change is therefore
 * reviewed against this probe's before-and-after numbers.
 *
 *   node --import tsx scripts/decision-probe.ts tests/fixtures/decision-cases/turn-sites.json [--profile system-one] [--runs 2] [--json] [--cases]
 *
 * It runs each fixture turn through the production pre-turn brief, with the
 * operator's own settings and the key stored for the bound target, so it
 * measures exactly what a turn would ask. It **calls the configured decision
 * model** and is never part of CI. The sites named by the fixture must be bound
 * in `fleet.decisionProfiles`, or `--profile` binds them to an existing
 * `fleet.profiles` entry for this run only, without touching the settings file.
 *
 * `--cases` also writes each turn's values to stderr as JSON lines, which is
 * what a threshold is placed against.
 *
 * Fixture keys name `<site>.<field>` of the site's value. A boolean label is
 * graded against the field's probability, abstaining inside 0.4..0.6 as the
 * readers do; a string label is compared with the field, and a null field is an
 * abstention.
 *
 * A fixture whose `site` is `capabilities` instead carries a catalog and find
 * queries labeled with the capability that serves them. It reports how often
 * the gateway's substring filter alone surfaces the label, how often the
 * label is there once related entries are added, and recall at 1 and 5 of the
 * ranking over the whole catalog.
 */

import { readFileSync } from "node:fs";
import { readSettings } from "../src/core/config.js";
import type { DecisionSite } from "../src/core/defaults.js";
import { openAuthStorage, resolveAuthTarget } from "../src/domains/providers/auth/index.js";
import type { ProvidersContract } from "../src/domains/providers/contract.js";
import { inspectDecisionSite } from "../src/domains/providers/decision-sites.js";
import { type PreTurnSite, runPreTurnBrief } from "../src/domains/providers/pre-turn-brief.js";
import { BUILTIN_RUNTIMES } from "../src/domains/providers/runtimes/builtins.js";
import { rankCapabilities } from "../src/domains/providers/sites/capabilities.js";
import { TURN_SITES } from "../src/domains/providers/sites/index.js";
import { GATEWAY_RELATED_BELOW_HITS, GATEWAY_RELATED_MAX } from "../src/tools/gateway/index.js";

/** Sites the probe can drive. Relevance sites need a catalog and have their own tests. */
const PROBE_SITES: ReadonlyMap<string, PreTurnSite<unknown>> = new Map(TURN_SITES.map((site) => [site.site, site]));

/** Decisive certainty for a probability, matching the brief's abstention band. */
const DECIDED = 0.2;
/** A wrong answer this far from the coin-flip is the failure hints cannot absorb. */
const CONFIDENT = 0.6;

interface FixtureCase {
	task: string;
	previous?: string;
	expect: Record<string, boolean | string>;
}

interface Fixture {
	sites: string[];
	cases: FixtureCase[];
}

interface CapabilityFixture {
	site: "capabilities";
	catalog: Array<{ name: string; description: string }>;
	cases: Array<{ query: string; task: string; expect: string }>;
}

/** The related-entry floor the gateway applies. */
const RELATED_MIN_SCORE = 0.5;

type Grade = "agree" | "abstain" | "wrong" | "confident-wrong" | "missing";

function grade(expected: boolean | string, actual: unknown): Grade {
	if (actual === undefined) return "missing";
	if (typeof expected === "string") {
		if (actual === null) return "abstain";
		return actual === expected ? "agree" : "wrong";
	}
	if (typeof actual !== "number") return "missing";
	const certainty = Math.abs(actual * 2 - 1);
	if (certainty < DECIDED) return "abstain";
	if (actual >= 0.5 === expected) return "agree";
	return certainty >= CONFIDENT ? "confident-wrong" : "wrong";
}

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
	const path = process.argv[2];
	if (path === undefined || path.startsWith("--")) {
		process.stderr.write("usage: decision-probe.ts <fixture.json> [--profile NAME] [--runs N] [--json] [--cases]\n");
		process.exit(2);
	}
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Fixture | CapabilityFixture;
	const runs = Number(argValue("--runs") ?? 2);
	if ("site" in parsed && parsed.site === "capabilities") {
		await probeCapabilities(parsed, runs);
		return;
	}
	const fixture = parsed as Fixture;
	const sites = fixture.sites.map((name) => {
		const site = PROBE_SITES.get(name);
		if (site === undefined) throw new Error(`fixture names '${name}', which the probe cannot drive`);
		return site;
	});

	const input = decisionInput(sites.map((site) => site.site));
	for (const site of sites) {
		const status = inspectDecisionSite(site.site as DecisionSite, input);
		if (!status.bound) throw new Error(`site '${site.site}' is not usable: ${JSON.stringify(status)}`);
	}
	await probeTurnSites(fixture, sites, input, runs);
}

/** The operator's settings and stored keys, with `--profile` binding the probed sites in memory. */
function decisionInput(probed: ReadonlyArray<DecisionSite>) {
	const settings = readSettings();
	const profile = argValue("--profile");
	if (profile !== undefined) {
		if (!(profile in settings.fleet.profiles)) throw new Error(`fleet.profiles.${profile} is not defined`);
		const bindings = { ...settings.fleet.decisionProfiles };
		for (const site of probed) bindings[site] = profile;
		settings.fleet.decisionProfiles = bindings;
	}
	const auth = openAuthStorage();
	const providers = {
		getTarget: (id: string) => settings.targets.find((target) => target.id === id) ?? null,
		getRuntime: (id: string) => BUILTIN_RUNTIMES.find((runtime) => runtime.id === id) ?? null,
		auth: {
			resolveForTarget: (
				target: Parameters<typeof resolveAuthTarget>[0],
				runtime: Parameters<typeof resolveAuthTarget>[1],
				options?: { signal?: AbortSignal },
			) => auth.resolveForTarget(resolveAuthTarget(target, runtime), options ?? {}),
		},
	} as unknown as ProvidersContract;
	return { settings, providers, ctx: { credentialsPresent: new Set<string>(), httpTimeoutMs: 15_000 } };
}

async function probeCapabilities(fixture: CapabilityFixture, runs: number): Promise<void> {
	const input = decisionInput(["capabilities"]);
	const status = inspectDecisionSite("capabilities", input);
	if (!status.bound) throw new Error(`site 'capabilities' is not usable: ${JSON.stringify(status)}`);
	let lexical = 0;
	let withRelated = 0;
	let top1 = 0;
	let top5 = 0;
	let unranked = 0;
	const latencies: number[] = [];
	const misses: string[] = [];
	for (let run = 0; run < runs; run += 1) {
		for (const turn of fixture.cases) {
			const needle = turn.query.toLowerCase();
			const hits = fixture.catalog.filter(
				(entry) => entry.name.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle),
			);
			const startedAt = performance.now();
			const ranking = await rankCapabilities(input, { query: turn.query, task: turn.task }, fixture.catalog);
			latencies.push(performance.now() - startedAt);
			const scores = ranking?.scores ?? {};
			if (ranking === null) unranked += 1;
			const order = fixture.catalog
				.filter((entry) => scores[entry.name] !== undefined)
				.sort((left, right) => (scores[right.name] ?? 0) - (scores[left.name] ?? 0))
				.map((entry) => entry.name);
			const position = order.indexOf(turn.expect);
			if (position === 0) top1 += 1;
			if (position >= 0 && position < 5) top5 += 1;
			const hitNames = new Set(hits.map((entry) => entry.name));
			const related =
				hits.length < GATEWAY_RELATED_BELOW_HITS
					? order
							.filter((name) => !hitNames.has(name) && (scores[name] ?? 0) >= RELATED_MIN_SCORE)
							.slice(0, GATEWAY_RELATED_MAX)
					: [];
			if (hitNames.has(turn.expect)) lexical += 1;
			if (hitNames.has(turn.expect) || related.includes(turn.expect)) withRelated += 1;
			else
				misses.push(
					`run ${run} "${turn.query}": want ${turn.expect} (score ${scores[turn.expect]?.toFixed(2) ?? "none"}), got ${[...hitNames, ...related].join(", ") || "nothing"}`,
				);
		}
	}
	latencies.sort((left, right) => left - right);
	const total = fixture.cases.length * runs;
	process.stdout.write(
		`capabilities ${fixture.catalog.length} entries  p50 ${Math.round(latencies[Math.floor(latencies.length / 2)] ?? 0)}ms  max ${Math.round(latencies.at(-1) ?? 0)}ms\n`,
	);
	process.stdout.write(`substring filter alone   ${lexical}/${total}\n`);
	process.stdout.write(`with related entries     ${withRelated}/${total}\n`);
	process.stdout.write(`ranking recall@1 ${top1}/${total}  recall@5 ${top5}/${total}  no opinion ${unranked}\n`);
	for (const miss of misses) process.stdout.write(`  ${miss}\n`);
}

async function probeTurnSites(
	fixture: Fixture,
	sites: ReadonlyArray<PreTurnSite<unknown>>,
	input: ReturnType<typeof decisionInput>,
	runs: number,
): Promise<void> {
	const tally = new Map<string, Record<Grade, number>>();
	const misses: string[] = [];
	const latencies: number[] = [];
	for (let run = 0; run < runs; run += 1) {
		for (const turn of fixture.cases) {
			const startedAt = performance.now();
			const brief = await runPreTurnBrief(input, sites, {
				task: turn.task,
				...(turn.previous !== undefined ? { previous: turn.previous } : {}),
			});
			latencies.push(performance.now() - startedAt);
			// Per-turn values, for placing a threshold between the labeled groups.
			if (process.argv.includes("--cases")) {
				const values = Object.fromEntries(sites.map((site) => [site.site, brief.get(site.site)?.value ?? null]));
				process.stderr.write(
					`${JSON.stringify({ run, expect: turn.expect, values, task: turn.task.slice(0, 80), previous: turn.previous !== undefined })}\n`,
				);
			}
			for (const [key, expected] of Object.entries(turn.expect)) {
				const [site, field] = key.split(".") as [DecisionSite, string];
				const value = brief.get(site)?.value as Record<string, unknown> | undefined;
				const actual = value === undefined ? undefined : value[field];
				const result = grade(expected, actual);
				const counts = tally.get(key) ?? { agree: 0, abstain: 0, wrong: 0, "confident-wrong": 0, missing: 0 };
				counts[result] += 1;
				tally.set(key, counts);
				if (result !== "agree") {
					const shown = typeof actual === "number" ? actual.toFixed(2) : String(actual);
					misses.push(
						`run ${run} ${key} ${result}: got ${shown}, want ${expected} | ${turn.previous ? "(after previous) " : ""}${turn.task.slice(0, 80)}`,
					);
				}
			}
		}
	}
	latencies.sort((left, right) => left - right);
	const summary = {
		fixture: process.argv[2],
		runs,
		versions: Object.fromEntries(sites.map((site) => [site.site, site.version])),
		latencyMs: {
			p50: Math.round(latencies[Math.floor(latencies.length / 2)] ?? 0),
			max: Math.round(latencies.at(-1) ?? 0),
		},
		keys: Object.fromEntries(tally),
	};
	if (process.argv.includes("--json")) {
		process.stdout.write(`${JSON.stringify({ ...summary, misses }, null, 2)}\n`);
		return;
	}
	process.stdout.write(
		`${JSON.stringify(summary.versions)}  p50 ${summary.latencyMs.p50}ms  max ${summary.latencyMs.max}ms\n`,
	);
	for (const [key, counts] of tally) {
		const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
		process.stdout.write(
			`${key.padEnd(28)} ${counts.agree}/${total} agree, ${counts.abstain} abstain, ${counts.wrong} wrong, ${counts["confident-wrong"]} confident-wrong, ${counts.missing} missing\n`,
		);
	}
	for (const miss of misses) process.stdout.write(`  ${miss}\n`);
}

await main();
