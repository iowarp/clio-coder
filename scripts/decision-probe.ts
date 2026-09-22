/**
 * Score a decision site's wording against its labeled fixture, live.
 *
 * Criteria wording is the quality lever for a System One site: jev-latest
 * follows the text literally, so a rung or an option description that reads
 * two ways gets answered the way it reads. Every wording change is therefore
 * reviewed against this probe's before-and-after numbers.
 *
 *   node --import tsx scripts/decision-probe.ts evals/fixtures/decision-cases/turn-sites.json [--profile system-one] [--runs 2] [--json]
 *
 * It runs each fixture turn through the production pre-turn brief, with the
 * operator's own settings and the key stored for the bound target, so it
 * measures exactly what a turn would ask. It **calls the configured decision
 * model** and is never part of CI. The sites named by the fixture must be bound
 * in `fleet.decisionProfiles`, or `--profile` binds them to an existing
 * `fleet.profiles` entry for this run only, without touching the settings file.
 *
 * Fixture keys name `<site>.<field>` of the site's value. A boolean label is
 * graded against the field's probability, abstaining inside 0.4..0.6 as the
 * readers do; a string label is compared with the field, and a null field is an
 * abstention.
 */

import { readFileSync } from "node:fs";
import { readSettings } from "../src/core/config.js";
import type { DecisionSite } from "../src/core/defaults.js";
import { openAuthStorage, resolveAuthTarget } from "../src/domains/providers/auth/index.js";
import type { ProvidersContract } from "../src/domains/providers/contract.js";
import { inspectDecisionSite } from "../src/domains/providers/decision-sites.js";
import { type PreTurnSite, runPreTurnBrief } from "../src/domains/providers/pre-turn-brief.js";
import { BUILTIN_RUNTIMES } from "../src/domains/providers/runtimes/builtins.js";
import { TURN_SITES } from "../src/domains/providers/sites/index.js";

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
		process.stderr.write("usage: decision-probe.ts <fixture.json> [--profile NAME] [--runs N] [--json]\n");
		process.exit(2);
	}
	const fixture = JSON.parse(readFileSync(path, "utf8")) as Fixture;
	const runs = Number(argValue("--runs") ?? 2);
	const sites = fixture.sites.map((name) => {
		const site = PROBE_SITES.get(name);
		if (site === undefined) throw new Error(`fixture names '${name}', which the probe cannot drive`);
		return site;
	});

	const settings = readSettings();
	const profile = argValue("--profile");
	if (profile !== undefined) {
		if (!(profile in settings.fleet.profiles)) throw new Error(`fleet.profiles.${profile} is not defined`);
		const bindings = { ...settings.fleet.decisionProfiles };
		for (const site of sites) bindings[site.site] = profile;
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
	const input = { settings, providers, ctx: { credentialsPresent: new Set<string>(), httpTimeoutMs: 15_000 } };
	for (const site of sites) {
		const status = inspectDecisionSite(site.site as DecisionSite, input);
		if (!status.bound) throw new Error(`site '${site.site}' is not usable: ${JSON.stringify(status)}`);
	}

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
		fixture: path,
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
