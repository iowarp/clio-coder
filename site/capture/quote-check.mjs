#!/usr/bin/env node
// Checks that tutorial quotes of a recording still match it. For each tutorial
// that embeds (::: capture) or covers a capture made by a scenario in
// scenarios.json, every line of a ```text fence that the page attributes to a
// recording (the prose line just before the fence says "recording" or
// "recorded", e.g. "In the recorded session behind this guide ... read:"), or
// whose info string says `recording`, must appear in the
// transcript of a scenario behind one of those captures. Comparison ignores
// whitespace and box-drawing characters, so terminal wrapping and panel borders
// do not count as differences. Misses are printed as page:line; the exit code
// is 1 when there is any.
//
//   node site/capture/quote-check.mjs [--scratch <dir>]
//
// Transcripts come from <scratch>/<scenario>/out/<scenario>.txt when --scratch
// is given and holds one (a run that was not published), else from
// site/assets/casts.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const site = dirname(here);

export const normalize = (text) => text.replace(/[\u2500-\u257f]/g, " ").replace(/\s+/g, "");

// Lines of the ```text fences a page attributes to a recording, with 1-based line numbers.
export function attributedQuotes(lines) {
	const quotes = [];
	let fence = null;
	let lead = "";
	for (const [index, line] of lines.entries()) {
		const open = line.match(/^\s*(`{3,})(\S*)(.*)/);
		if (fence === null && open) {
			fence = {
				marker: open[1],
				quoted: open[2] === "text" && (/\brecord(ed|ing)\b/i.test(lead) || /\brecording\b/.test(open[3])),
			};
			continue;
		}
		if (fence && line.trim() === fence.marker) {
			fence = null;
			continue;
		}
		if (fence === null && line.trim()) lead = line;
		if (fence?.quoted && line.trim()) quotes.push({ line: index + 1, text: line });
	}
	return quotes;
}

// Whether a quoted line appears in any of the normalized transcripts.
export const quoted = (line, transcripts) => transcripts.some((text) => text.includes(normalize(line)));

export function quoteCheck({ scratch } = {}) {
	const spec = JSON.parse(readFileSync(join(here, "scenarios.json"), "utf8"));
	const madeBy = new Map();
	for (const scenario of spec.scenarios) {
		if (!scenario.stillsOnly) madeBy.set(scenario.id, scenario.id);
		for (const id of Object.keys(scenario.shots ?? {})) madeBy.set(id, scenario.id);
	}
	const transcripts = new Map();
	const transcriptOf = (scenarioId) => {
		if (!transcripts.has(scenarioId)) {
			const taken = scratch && join(scratch, scenarioId, "out", `${scenarioId}.txt`);
			const path = taken && existsSync(taken) ? taken : join(site, "assets/casts", `${scenarioId}.txt`);
			transcripts.set(scenarioId, existsSync(path) ? normalize(readFileSync(path, "utf8")) : null);
		}
		return transcripts.get(scenarioId);
	};

	const misses = [];
	const notes = [];
	let checked = 0;
	for (const tutorial of JSON.parse(readFileSync(join(site, "content/tutorials.json"), "utf8"))) {
		const path = join(site, "content/tutorials", tutorial.source);
		const page = relative(process.cwd(), path);
		const lines = readFileSync(path, "utf8").split("\n");
		const ids = [tutorial.cover, ...lines.flatMap((line) => line.match(/^:::\s*capture\s+(.+)/)?.[1].split(/\s+/) ?? [])];
		const scenarioIds = [...new Set(ids.filter((id) => id && madeBy.has(id)).map((id) => madeBy.get(id)))];
		if (!scenarioIds.length) continue;
		const texts = scenarioIds.map(transcriptOf);
		const available = texts.filter((text) => text !== null);
		const missing = scenarioIds.filter((_, index) => texts[index] === null);
		const quotes = attributedQuotes(lines);
		checked += quotes.length;
		if (quotes.length && missing.length) notes.push(`${page}:${quotes[0].line}: no transcript for ${missing.join(", ")}`);
		for (const quote of quotes)
			if (!quoted(quote.text, available))
				misses.push(`${page}:${quote.line}: not in ${scenarioIds.join(" or ")}: ${quote.text.trim()}`);
	}
	return { checked, misses, notes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: { scratch: { type: "string" } } });
	const { checked, misses, notes } = quoteCheck({ scratch: values.scratch && resolve(values.scratch) });
	for (const note of notes) console.log(`quote-check: ${note}`);
	for (const miss of misses) console.log(`quote-check: ${miss}`);
	console.log(`quote-check: ${checked} quoted lines, ${misses.length} not in their recording`);
	process.exitCode = misses.length ? 1 : 0;
}
