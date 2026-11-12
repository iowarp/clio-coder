#!/usr/bin/env node
// Checks the alt text and caption of captures against their recordings. A re-take
// can change what a screen shows (a token count, a row that is no longer there)
// while the words written for the old take stay. Two parts:
//
// - every number in an alt or caption (version literals aside) must appear in the
//   transcript of the scenario that made the capture; a miss is printed and the
//   exit code is 1;
// - every capture checked is listed with its image, alt and caption for a human
//   read against the image, since rows and labels cannot be checked by text alone.
//
//   node site/capture/alt-check.mjs [--scratch <dir>] [--only id,id]
//
// Transcripts and images come from <scratch>/<scenario>/out when --scratch holds
// a take, else from site/assets. Without --only it checks every Terminal capture
// that a scenario makes.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { normalize } from "./quote-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const site = dirname(here);

const versionLiteral = /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?/g;

// The numbers an alt or caption states, without version literals.
export const figures = (text) => (text ?? "").replace(versionLiteral, " ").match(/\d+(?:[,.]\d+)*/g) ?? [];

// Figures in `entry` that the normalized transcript does not show, with or without thousands separators.
export const missingFigures = (entry, transcript) =>
	[...new Set([...figures(entry.alt), ...figures(entry.caption)])].filter(
		(figure) => !transcript.includes(figure) && !transcript.includes(figure.replaceAll(",", "")),
	);

export function altCheck({ scratch, ids, entries } = {}) {
	const spec = JSON.parse(readFileSync(join(here, "scenarios.json"), "utf8"));
	const madeBy = new Map();
	for (const scenario of spec.scenarios) {
		if (!scenario.stillsOnly) madeBy.set(scenario.id, scenario.id);
		for (const id of Object.keys(scenario.shots ?? {})) madeBy.set(id, scenario.id);
	}
	const registry = entries ?? JSON.parse(readFileSync(join(site, "content/captures.json"), "utf8")).captures;
	const wanted = ids ?? Object.keys(registry).filter((id) => registry[id].interface === "Terminal" && madeBy.has(id));
	const take = (scenarioId, file) => scratch && join(scratch, scenarioId, "out", file);
	const misses = [];
	const reads = [];
	for (const id of wanted) {
		const entry = registry[id];
		const scenarioId = madeBy.get(id);
		if (!entry || !scenarioId) {
			misses.push(`${id}: not a capture a scenario makes`);
			continue;
		}
		const taken = take(scenarioId, `${scenarioId}.txt`);
		const path = taken && existsSync(taken) ? taken : join(site, "assets/casts", `${scenarioId}.txt`);
		const image = take(scenarioId, `${id}.png`);
		reads.push({
			id,
			image: relative(process.cwd(), image && existsSync(image) ? image : join(site, entry.original)),
			alt: entry.alt,
			caption: entry.caption,
		});
		if (!existsSync(path)) {
			if (figures(entry.alt).length || figures(entry.caption).length)
				misses.push(`${id}: no transcript for ${scenarioId} to check its figures against`);
			continue;
		}
		const missing = missingFigures(entry, normalize(readFileSync(path, "utf8")));
		if (missing.length) misses.push(`${id}: ${missing.join(", ")} not in the ${scenarioId} recording`);
	}
	return { reads, misses };
}

export function printAltCheck({ reads, misses }, log = console.log) {
	log(`alt-check: read each image against its alt and caption (${reads.length}):`);
	for (const read of reads) log(`  ${read.id}  ${read.image}\n    alt: ${read.alt}\n    caption: ${read.caption}`);
	for (const miss of misses) log(`alt-check: ${miss}`);
	log(
		`alt-check: ${reads.length} captures, ${misses.length} misses (a figure not in the recording, or no recording to check)`,
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: { scratch: { type: "string" }, only: { type: "string" } } });
	const result = altCheck({
		scratch: values.scratch && resolve(values.scratch),
		ids: values.only?.split(","),
	});
	printAltCheck(result);
	process.exitCode = result.misses.length ? 1 : 0;
}
