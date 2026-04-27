/**
 * Interop-aware instruction merger.
 *
 * Replaces the old "concatenate every context file" strategy. Each source
 * (CLIO.md, CLAUDE.md, AGENTS.md, CODEX.md, GEMINI.md, CLIO-dev.md) is
 * parsed into sections keyed by `^## ` header. The merger then composes a
 * single deterministic block where:
 *
 *   - CLIO.md wins on every section conflict;
 *   - CLIO-dev.md (when present) overrides CLIO.md;
 *   - among the rest, the source closest to cwd wins (later in the input
 *     array, since callers should pass parent-to-child);
 *   - byte-identical bodies across non-CLIO sources are de-duplicated;
 *   - section ordering follows CLIO.md when present; otherwise the
 *     stable header order observed across sources.
 *
 * The output carries a short provenance footer naming every contributor
 * and which sections it actually contributed.
 */

import { createHash } from "node:crypto";

export type InstructionSourceKind = "clio" | "clio-dev" | "claude" | "agents" | "codex" | "gemini";

export interface InstructionSource {
	path: string;
	kind: InstructionSourceKind;
	sections: Map<string, string>;
}

export interface InstructionContributor {
	path: string;
	sections: string[];
	tag?: "dev";
}

export interface MergedInstructions {
	text: string;
	contributors: InstructionContributor[];
}

const PREAMBLE_KEY = "";

/**
 * Parse a markdown document into sections keyed by `^## ` header. Any
 * content that precedes the first H2 header is stored under the empty
 * string key (PREAMBLE_KEY).
 */
export function parseSections(text: string): Map<string, string> {
	const sections = new Map<string, string>();
	if (text.length === 0) return sections;

	const lines = text.split(/\r?\n/);
	let currentKey = PREAMBLE_KEY;
	let currentLines: string[] = [];
	const flush = (): void => {
		const body = currentLines.join("\n").replace(/^\s+|\s+$/g, "");
		if (body.length > 0) sections.set(currentKey, body);
	};

	for (const line of lines) {
		const headerMatch = /^##\s+(.+?)\s*$/.exec(line);
		if (headerMatch?.[1]) {
			flush();
			currentKey = headerMatch[1].trim();
			currentLines = [];
			continue;
		}
		currentLines.push(line);
	}
	flush();
	return sections;
}

interface SectionPick {
	header: string;
	body: string;
	contributorPath: string;
}

function hashBody(body: string): string {
	const normalized = body
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.join("\n");
	return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Merge a list of instruction sources into a single deterministic block.
 *
 * Sources should be passed in increasing-priority order for non-CLIO files
 * (parent-to-child closest-to-cwd). The CLIO.md and CLIO-dev.md sources
 * win regardless of position via the conflict policy described in the
 * module header.
 */
export function mergeInstructions(sources: ReadonlyArray<InstructionSource>): MergedInstructions {
	if (sources.length === 0) return { text: "", contributors: [] };

	const clio = sources.find((s) => s.kind === "clio") ?? null;
	const dev = sources.find((s) => s.kind === "clio-dev") ?? null;
	const others = sources.filter((s) => s.kind !== "clio" && s.kind !== "clio-dev");

	const picks: SectionPick[] = [];
	const seenHeaders = new Set<string>();
	const sectionContributors = new Map<string, string[]>();

	const recordContributor = (path: string, header: string): void => {
		const list = sectionContributors.get(path) ?? [];
		if (!list.includes(header)) list.push(header);
		sectionContributors.set(path, list);
	};

	const sectionOrder: string[] = [];
	if (clio) {
		for (const header of clio.sections.keys()) {
			if (header === PREAMBLE_KEY) continue;
			sectionOrder.push(header);
		}
	}
	for (const src of others) {
		for (const header of src.sections.keys()) {
			if (header === PREAMBLE_KEY) continue;
			if (!sectionOrder.includes(header)) sectionOrder.push(header);
		}
	}
	if (dev) {
		for (const header of dev.sections.keys()) {
			if (header === PREAMBLE_KEY) continue;
			if (!sectionOrder.includes(header)) sectionOrder.push(header);
		}
	}

	for (const header of sectionOrder) {
		if (seenHeaders.has(header)) continue;
		// Priority: dev override -> clio -> last-among-others (closest-to-cwd wins)
		const devBody = dev?.sections.get(header);
		if (devBody !== undefined && dev) {
			picks.push({ header, body: devBody, contributorPath: dev.path });
			recordContributor(dev.path, header);
			seenHeaders.add(header);
			continue;
		}
		const clioBody = clio?.sections.get(header);
		if (clioBody !== undefined && clio) {
			picks.push({ header, body: clioBody, contributorPath: clio.path });
			recordContributor(clio.path, header);
			seenHeaders.add(header);
			continue;
		}
		// Among others, child wins (later index). De-dup byte-identical bodies.
		let chosen: { body: string; path: string } | null = null;
		const seenHashes = new Set<string>();
		for (const src of others) {
			const body = src.sections.get(header);
			if (body === undefined) continue;
			const h = hashBody(body);
			if (seenHashes.has(h)) continue;
			seenHashes.add(h);
			chosen = { body, path: src.path };
		}
		if (chosen) {
			picks.push({ header, body: chosen.body, contributorPath: chosen.path });
			recordContributor(chosen.path, header);
			seenHeaders.add(header);
		}
	}

	// Render output
	const parts: string[] = [];
	for (const pick of picks) {
		parts.push(`## ${pick.header}\n\n${pick.body}`);
	}

	const provenance: string[] = ["", "<!-- instruction provenance -->"];
	const contributors: InstructionContributor[] = [];
	const orderedPaths: string[] = [];
	if (clio && sectionContributors.has(clio.path)) orderedPaths.push(clio.path);
	for (const src of others) {
		if (sectionContributors.has(src.path) && !orderedPaths.includes(src.path)) {
			orderedPaths.push(src.path);
		}
	}
	if (dev && sectionContributors.has(dev.path)) orderedPaths.push(dev.path);

	for (const path of orderedPaths) {
		const sections = sectionContributors.get(path) ?? [];
		const isDev = dev?.path === path;
		const tag = isDev ? " [dev]" : "";
		provenance.push(`<!-- ${path}${tag}: ${sections.join(", ")} -->`);
		const entry: InstructionContributor = { path, sections };
		if (isDev) entry.tag = "dev";
		contributors.push(entry);
	}

	const text = picks.length > 0 ? `${parts.join("\n\n")}\n${provenance.join("\n")}` : "";
	return { text, contributors };
}
