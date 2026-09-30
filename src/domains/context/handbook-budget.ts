import type { BootstrapStructuredOutput } from "./bootstrap.js";
import { HANDBOOK_TARGETS, serializeClioMd } from "./clio-md.js";

/** Ignore prose punctuation, but keep operators and glob syntax inside code. */
export function normalizeHandbookRule(text: string): string {
	return text
		.replace(/^\s*(?:[-*+]\s|\d+\.\s)/, "")
		.replace(/\s*\(source: [^)]+\)\s*$/, "")
		.split(/(`[^`]+`)/)
		.map((part, index) =>
			index % 2 === 1
				? part
				: part
						.replace(/[*]/g, "")
						.replace(/[.,;](?=\s|$)/g, " ")
						.toLowerCase(),
		)
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

export function handbookBlocks(body: string): string[] {
	const result: string[] = [];
	let block: string[] = [];
	let fence: string | null = null;
	const flush = (): void => {
		if (block.some((line) => line.trim())) result.push(block.join("\n").trimEnd());
		block = [];
	};
	for (const line of body.split(/\r?\n/)) {
		const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
		if (!fence && (line.trim() === "" || /^(?:[-*+]\s|\d+\.\s)/.test(line))) flush();
		block.push(line);
		if (delimiter) {
			if (fence && delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
			else if (!fence) fence = delimiter;
		}
	}
	flush();
	return result;
}

/** Fit whole rules and recipe blocks; a cut sentence must never lose its remedy. */
export function fitGeneratedHandbook(output: BootstrapStructuredOutput): BootstrapStructuredOutput {
	const result: BootstrapStructuredOutput = {
		projectName: output.projectName,
		identity: output.identity,
		invariants: [],
		conventions: [],
		sections: [],
	};
	const fits = (): boolean => {
		const text = serializeClioMd(result);
		return text.length <= HANDBOOK_TARGETS.chars && text.trimEnd().split("\n").length <= HANDBOOK_TARGETS.lines;
	};
	const seen = new Set<string>();
	const key = normalizeHandbookRule;
	const covered = (normalized: string): boolean =>
		seen.has(normalized) || (normalized.length >= 40 && [...seen].some((existing) => existing.includes(normalized)));
	// Verification has a reserved place even when every generated rule is long.
	const sections = output.sections ?? [];
	const authored = sections
		.filter((section) => section.title === "Authored project rules")
		.flatMap((section) => handbookBlocks(section.body));
	const verification = sections.filter((section) => /\bverification\b/i.test(section.title));
	for (const section of verification) {
		result.sections?.push(section);
		if (!fits()) result.sections?.pop();
	}
	for (const field of ["invariants", "conventions"] as const) {
		for (const proposed of output[field]) {
			const proposedKey = key(proposed);
			// Keep a whole authored constraint when the model merely shortened it;
			// otherwise both the partial summary and its omitted remedy cost space.
			const canonical = proposedKey.length >= 40 ? authored.find((block) => key(block).includes(proposedKey)) : undefined;
			const rule = canonical?.replace(/^\s*[-*+]\s/, "") ?? proposed;
			const normalized = key(rule);
			if (covered(normalized)) continue;
			result[field].push(rule);
			if (!fits()) result[field].pop();
			else seen.add(normalized);
		}
	}
	const retained = [...(result.sections ?? [])];
	result.sections = [];
	for (const section of sections.filter((section) => !verification.includes(section))) {
		const candidate = { title: section.title, body: "" };
		result.sections.push(candidate);
		for (const block of handbookBlocks(section.body)) {
			const normalized = key(block);
			if (covered(normalized)) continue;
			const previous = candidate.body;
			candidate.body = previous ? `${previous}\n${block}` : block;
			result.sections.push(...retained);
			const accepted = fits();
			result.sections.splice(result.sections.length - retained.length, retained.length);
			if (!accepted) candidate.body = previous;
			else seen.add(normalized);
		}
		if (!candidate.body) result.sections.pop();
	}
	result.sections.push(...retained);
	if (output.importedAgentContext) {
		result.importedAgentContext = output.importedAgentContext;
		if (!fits()) delete result.importedAgentContext;
	}
	return result;
}
