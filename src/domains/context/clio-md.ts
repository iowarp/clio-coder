import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ClioMdFingerprintFooter {
	initAt: string;
	model: string;
	gitHead: string | null;
	treeHash: string;
	loc: number;
}

export interface ParsedClioMd {
	projectName: string;
	identity: string;
	conventions: string[];
	invariants: string[];
	fingerprint: ClioMdFingerprintFooter | null;
	firstInit: boolean;
	warnings: string[];
}

export type ClioMdParseResult = { ok: true; value: ParsedClioMd } | { ok: false; errors: string[]; warnings: string[] };

export interface SerializeClioMdInput {
	projectName: string;
	identity: string;
	conventions: ReadonlyArray<string>;
	invariants: ReadonlyArray<string>;
	fingerprint: ClioMdFingerprintFooter;
}

const FOOTER_RE = /<!--\s*clio:fingerprint v1\s*\n([\s\S]*?)\n\s*-->/;
const H1_RE = /^#\s+(.+?)\s*$/gm;
const H2_RE = /^##\s+(.+?)\s*$/gm;

function normalizeSource(source: string): string {
	return source
		.replace(/^\uFEFF/, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.trimStart();
}

function charLen(value: string): number {
	return [...value].length;
}

function parseFooter(source: string): {
	body: string;
	footer: ClioMdFingerprintFooter | null;
	firstInit: boolean;
	errors: string[];
	warnings: string[];
} {
	const warnings: string[] = [];
	const markerCount = (source.match(/clio:fingerprint v1/g) ?? []).length;
	const match = FOOTER_RE.exec(source);
	if (!match) {
		if (markerCount > 0) {
			return {
				body: source,
				footer: null,
				firstInit: false,
				errors: ["malformed fingerprint footer"],
				warnings,
			};
		}
		return { body: source, footer: null, firstInit: true, errors: [], warnings };
	}

	const footerEnd = match.index + match[0].length;
	const trailing = source.slice(footerEnd).trim();
	if (trailing.length > 0) warnings.push("trailing content after fingerprint footer ignored");
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[1] ?? "");
	} catch {
		return {
			body: source.slice(0, match.index),
			footer: null,
			firstInit: false,
			errors: ["fingerprint footer is not valid JSON"],
			warnings,
		};
	}
	const footer = validateFooter(parsed);
	if (!footer) {
		return {
			body: source.slice(0, match.index),
			footer: null,
			firstInit: false,
			errors: ["fingerprint footer has invalid shape"],
			warnings,
		};
	}
	return {
		body: source.slice(0, match.index),
		footer,
		firstInit: false,
		errors: [],
		warnings,
	};
}

function validateFooter(value: unknown): ClioMdFingerprintFooter | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const obj = value as Record<string, unknown>;
	if (typeof obj.initAt !== "string" || obj.initAt.length === 0) return null;
	if (typeof obj.model !== "string" || obj.model.length === 0) return null;
	if (!(typeof obj.gitHead === "string" || obj.gitHead === null)) return null;
	if (typeof obj.treeHash !== "string" || !/^[0-9a-f]{64}$/.test(obj.treeHash)) return null;
	if (typeof obj.loc !== "number" || !Number.isInteger(obj.loc) || obj.loc < 0) return null;
	return {
		initAt: obj.initAt,
		model: obj.model,
		gitHead: obj.gitHead,
		treeHash: obj.treeHash,
		loc: obj.loc,
	};
}

function readSections(body: string): Map<string, string> {
	const headings = [...body.matchAll(H2_RE)];
	const sections = new Map<string, string>();
	for (let i = 0; i < headings.length; i += 1) {
		const heading = headings[i];
		if (!heading || heading.index === undefined) continue;
		const next = headings[i + 1];
		const title = (heading[1] ?? "").trim().toLowerCase();
		const start = heading.index + heading[0].length;
		const end = next?.index ?? body.length;
		sections.set(title, body.slice(start, end).trim());
	}
	return sections;
}

function identityParagraph(afterH1: string): string {
	const beforeFirstSection = afterH1.split(/^##\s+/m)[0] ?? "";
	const paragraphs = beforeFirstSection
		.trim()
		.split(/\n\s*\n/)
		.map((part) => part.replace(/\s+/g, " ").trim())
		.filter((part) => part.length > 0);
	return paragraphs[0] ?? "";
}

function parseBullets(section: string): string[] {
	if (section.trim().length === 0) return [];
	return section
		.split("\n")
		.map((line) => /^[-*]\s+(.+?)\s*$/.exec(line)?.[1]?.trim())
		.filter((line): line is string => Boolean(line));
}

function parseNumbered(section: string): string[] {
	if (section.trim().length === 0) return [];
	return section
		.split("\n")
		.map((line) => /^\d+\.\s+(.+?)\s*$/.exec(line)?.[1]?.trim())
		.filter((line): line is string => Boolean(line));
}

export function parseClioMd(source: string): ClioMdParseResult {
	const normalized = normalizeSource(source);
	const warnings: string[] = [];
	const footerResult = parseFooter(normalized);
	warnings.push(...footerResult.warnings);
	if (footerResult.errors.length > 0) return { ok: false, errors: footerResult.errors, warnings };

	const h1Matches = [...footerResult.body.matchAll(H1_RE)];
	if (h1Matches.length === 0) return { ok: false, errors: ["missing H1 heading"], warnings };
	if (h1Matches.length > 1) return { ok: false, errors: ["more than one H1 heading"], warnings };

	const h1 = h1Matches[0];
	if (!h1 || h1.index === undefined) return { ok: false, errors: ["missing H1 heading"], warnings };
	const projectName = (h1[1] ?? "").trim();
	const errors: string[] = [];
	if (projectName.length === 0) errors.push("project name must not be empty");
	if (charLen(projectName) > 80) errors.push("project name must be at most 80 characters");

	const afterH1 = footerResult.body.slice(h1.index + h1[0].length);
	const identity = identityParagraph(afterH1);
	if (identity.length === 0) errors.push("identity paragraph is required");
	if (charLen(identity) > 600) errors.push("identity paragraph must be at most 600 characters");

	const sections = readSections(afterH1);
	const conventions = parseBullets(sections.get("conventions") ?? "");
	const invariants = parseNumbered(sections.get("hard invariants") ?? "");
	if (conventions.length > 6) errors.push("conventions must contain at most 6 bullets");
	if (invariants.length > 3) errors.push("hard invariants must contain at most 3 numbered rules");
	for (const [index, item] of conventions.entries()) {
		if (charLen(item) > 200) errors.push(`convention ${index + 1} must be at most 200 characters`);
	}
	for (const [index, item] of invariants.entries()) {
		if (charLen(item) > 280) errors.push(`hard invariant ${index + 1} must be at most 280 characters`);
	}
	if (errors.length > 0) return { ok: false, errors, warnings };

	return {
		ok: true,
		value: {
			projectName,
			identity,
			conventions,
			invariants,
			fingerprint: footerResult.footer,
			firstInit: footerResult.firstInit,
			warnings,
		},
	};
}

function validateForSerialization(input: SerializeClioMdInput): void {
	const test = parseClioMd(renderWithoutParse(input));
	if (!test.ok) {
		throw new Error(`CLIO.md serialization failed validation: ${test.errors.join("; ")}`);
	}
}

function renderWithoutParse(input: SerializeClioMdInput): string {
	const lines: string[] = [`# ${input.projectName.trim()}`, "", input.identity.trim()];
	if (input.conventions.length > 0) {
		lines.push("", "## Conventions", "", ...input.conventions.map((item) => `- ${item.trim()}`));
	}
	if (input.invariants.length > 0) {
		lines.push("", "## Hard invariants", "", ...input.invariants.map((item, index) => `${index + 1}. ${item.trim()}`));
	}
	const footer = JSON.stringify(input.fingerprint, null, 2);
	return `${lines.join("\n")}\n\n<!-- clio:fingerprint v1\n${footer}\n-->\n`;
}

export function serializeClioMd(input: SerializeClioMdInput): string {
	validateForSerialization(input);
	return renderWithoutParse(input);
}

export function renderProjectTypeFragment(projectType: string): string {
	return `<project-type>${projectType}</project-type>`;
}

export function renderProjectContextFragment(parsed: ParsedClioMd): string {
	const sections: string[] = [`# ${parsed.projectName}`, parsed.identity];
	if (parsed.conventions.length > 0) {
		sections.push("## Conventions", ...parsed.conventions.map((item) => `- ${item}`));
	}
	if (parsed.invariants.length > 0) {
		sections.push("## Hard invariants", ...parsed.invariants.map((item, index) => `${index + 1}. ${item}`));
	}
	return `<project-context>\n${sections.join("\n\n")}\n</project-context>`;
}

export function tryReadClioMd(cwd: string): { ok: true; value: ParsedClioMd } | { ok: false; error: string } | null {
	const filePath = join(cwd, "CLIO.md");
	if (!existsSync(filePath)) return null;
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: message };
	}
	const parsed = parseClioMd(content);
	if (!parsed.ok) return { ok: false, error: parsed.errors.join("; ") };
	return { ok: true, value: parsed.value };
}
