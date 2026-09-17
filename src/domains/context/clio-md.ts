import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface ClioMdFingerprintFooter {
	initAt: string;
	model: string;
	gitHead: string | null;
	treeHash: string;
	loc: number;
}

export interface ClioMdSection {
	title: string;
	body: string;
}

export interface ParsedClioMd {
	projectName: string;
	identity: string;
	conventions: string[];
	invariants: string[];
	sections: ClioMdSection[];
	importedAgentContext: string | null;
	fingerprint: ClioMdFingerprintFooter | null;
	firstInit: boolean;
	warnings: string[];
}

export interface LoadedClioMdFile {
	path: string;
	/** Exact UTF-8 authored source for prompt rendering. */
	source: string;
	/** Optional generator-format projection; never the authority for authored text. */
	value: ParsedClioMd | null;
}

export interface ClioMdLoadError {
	path: string;
	error: string;
}

export interface LoadedProjectClioMd {
	/** Effective files in ancestor-to-descendant order. */
	files: LoadedClioMdFile[];
	/** Selected files that could not be read or were empty. */
	errors: ClioMdLoadError[];
	/** The layered structured projection, or null when no selected file matches the generator format. */
	value: ParsedClioMd | null;
}

export type ClioMdParseResult = { ok: true; value: ParsedClioMd } | { ok: false; errors: string[]; warnings: string[] };

export interface SerializeClioMdInput {
	projectName: string;
	identity: string;
	conventions: ReadonlyArray<string>;
	invariants: ReadonlyArray<string>;
	sections?: ReadonlyArray<ClioMdSection>;
	importedAgentContext?: string;
	fingerprint?: ClioMdFingerprintFooter | null;
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

function normalizeInline(value: string): string {
	return value
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^#{1,6}\s+/, "")
		.trim();
}

/**
 * The same text with every character inside a fenced code block or an HTML
 * comment replaced by a filler, newlines kept, so offsets into the mask are
 * offsets into the original. Heading scans run on the mask and slice from the
 * source: a `# comment` line in a fenced shell example used to read as a
 * second H1 and reject the whole handbook, and a `## not a heading` inside a
 * fence split into a section whose serialization then rewrote the fence.
 */
function maskNonHeadingRegions(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let fence: { char: string; length: number } | null = null;
	let inComment = false;
	for (const line of lines) {
		let masked = false;
		if (fence) {
			masked = true;
			const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
			if (close?.[1] && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
		} else if (inComment) {
			masked = true;
			if (line.includes("-->")) inComment = false;
		} else {
			const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
			if (open?.[1]) {
				fence = { char: open[1][0] ?? "`", length: open[1].length };
				masked = true;
			} else if (/^\s*<!--/.test(line)) {
				masked = true;
				if (!line.includes("-->")) inComment = true;
			}
		}
		// A non-whitespace filler: the heading regexes end in `\s*$`, which would
		// otherwise run through a blank-masked block and swallow it into the
		// heading match.
		out.push(masked ? "_".repeat(line.length) : line);
	}
	return out.join("\n");
}

function normalizeNestedMarkdown(value: string): string {
	const body = normalizeSource(value).trim();
	// Demote authored H1/H2 inside a section body so it cannot outrank the
	// section, but only where a heading scan would see one: a fence or comment
	// keeps its bytes.
	const mask = maskNonHeadingRegions(body);
	let out = "";
	let cursor = 0;
	for (const match of mask.matchAll(/^(#{1,2})(\s+)/gm)) {
		if (match.index === undefined) continue;
		out += `${body.slice(cursor, match.index)}###${match[2] ?? ""}`;
		cursor = match.index + match[0].length;
	}
	return out + body.slice(cursor);
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
	if (trailing.length > 0) warnings.push("trailing content after fingerprint footer omitted from structured fields");
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

function readSections(body: string): ClioMdSection[] {
	const headings = [...maskNonHeadingRegions(body).matchAll(H2_RE)];
	const sections: ClioMdSection[] = [];
	for (let i = 0; i < headings.length; i += 1) {
		const heading = headings[i];
		if (!heading || heading.index === undefined) continue;
		const next = headings[i + 1];
		const title = (heading[1] ?? "").trim();
		const start = heading.index + heading[0].length;
		const end = next?.index ?? body.length;
		sections.push({ title, body: body.slice(start, end).trim() });
	}
	return sections;
}

function sectionBody(sections: ReadonlyArray<ClioMdSection>, title: string): string {
	return sections.find((section) => section.title.toLowerCase() === title.toLowerCase())?.body ?? "";
}

const RESERVED_SECTION_TITLES = new Set(["conventions", "hard invariants", "imported agent context"]);

function extraSections(sections: ReadonlyArray<ClioMdSection>): ClioMdSection[] {
	return sections.filter((section) => !RESERVED_SECTION_TITLES.has(section.title.toLowerCase()));
}

function identityParagraph(afterH1: string): string {
	const firstSection = /^##\s+/m.exec(maskNonHeadingRegions(afterH1));
	const beforeFirstSection = firstSection ? afterH1.slice(0, firstSection.index) : afterH1;
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

	const h1Matches = [...maskNonHeadingRegions(footerResult.body).matchAll(H1_RE)];
	if (h1Matches.length === 0) return { ok: false, errors: ["missing H1 heading"], warnings };
	if (h1Matches.length > 1) return { ok: false, errors: ["more than one H1 heading"], warnings };

	const h1 = h1Matches[0];
	if (!h1 || h1.index === undefined) return { ok: false, errors: ["missing H1 heading"], warnings };
	const projectName = (h1[1] ?? "").trim();
	const errors: string[] = [];
	if (projectName.length === 0) errors.push("project name must not be empty");
	if (charLen(projectName) > 80) warnings.push("project name is longer than the generator target");

	const afterH1 = footerResult.body.slice(h1.index + h1[0].length);
	const identity = identityParagraph(afterH1);
	if (identity.length === 0) errors.push("identity paragraph is required");
	if (charLen(identity) > 600) warnings.push("identity paragraph is longer than the generator target");

	const sections = readSections(afterH1);
	const conventions = parseBullets(sectionBody(sections, "conventions"));
	const invariants = parseNumbered(sectionBody(sections, "hard invariants"));
	const customSections = extraSections(sections);
	const importedAgentContext = sectionBody(sections, "imported agent context") || null;
	if (conventions.length > 6) warnings.push("conventions exceed the generator target of six bullets");
	if (invariants.length > 3) warnings.push("hard invariants exceed the generator target of three numbered rules");
	if (customSections.length > 8) warnings.push("custom sections exceed the generator target of eight H2 sections");
	for (const [index, item] of conventions.entries()) {
		if (charLen(item) > 200) warnings.push(`convention ${index + 1} is longer than the generator target`);
	}
	for (const [index, item] of invariants.entries()) {
		if (charLen(item) > 280) warnings.push(`hard invariant ${index + 1} is longer than the generator target`);
	}
	for (const [index, section] of customSections.entries()) {
		if (charLen(section.title) > 80)
			warnings.push(`custom section ${index + 1} title is longer than the generator target`);
		if (charLen(section.body) > 2500)
			warnings.push(`custom section ${index + 1} body is longer than the generator target`);
	}
	if (errors.length > 0) return { ok: false, errors, warnings };

	return {
		ok: true,
		value: {
			projectName,
			identity,
			conventions,
			invariants,
			sections: customSections,
			importedAgentContext,
			fingerprint: footerResult.footer,
			firstInit: footerResult.firstInit,
			warnings,
		},
	};
}

function validateForSerialization(input: SerializeClioMdInput): void {
	const test = parseClioMd(renderWithoutParse(input));
	if (!test.ok) {
		throw new Error(`CLIO-CODER.md serialization failed validation: ${test.errors.join("; ")}`);
	}
}

function renderWithoutParse(input: SerializeClioMdInput): string {
	const lines: string[] = [`# ${normalizeInline(input.projectName)}`, "", normalizeInline(input.identity)];
	const conventions = input.conventions.map((item) => normalizeInline(item)).filter((item) => item.length > 0);
	if (conventions.length > 0) {
		lines.push("", "## Conventions", "", ...conventions.map((item) => `- ${item}`));
	}
	const invariants = input.invariants.map((item) => normalizeInline(item)).filter((item) => item.length > 0);
	if (invariants.length > 0) {
		lines.push("", "## Hard invariants", "", ...invariants.map((item, index) => `${index + 1}. ${item}`));
	}
	for (const section of input.sections ?? []) {
		const title = normalizeInline(section.title);
		const body = normalizeNestedMarkdown(section.body);
		if (title.length > 0 && body.length > 0) lines.push("", `## ${title}`, "", body);
	}
	const imported = input.importedAgentContext ? normalizeNestedMarkdown(input.importedAgentContext) : undefined;
	if (imported && imported.length > 0) {
		lines.push("", "## Imported agent context", "", imported);
	}
	if (!input.fingerprint) return `${lines.join("\n")}\n`;
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

function escapeXmlAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function renderProjectContextFragment(parsed: ParsedClioMd | string, sourcePath?: string): string {
	const source = sourcePath ? ` path="${escapeXmlAttribute(sourcePath)}"` : "";
	if (typeof parsed === "string") return `<project-context${source}>\n${parsed}\n</project-context>`;
	const sections: string[] = [`# ${parsed.projectName}`, parsed.identity];
	if (parsed.conventions.length > 0) {
		sections.push("## Conventions", ...parsed.conventions.map((item) => `- ${item}`));
	}
	if (parsed.invariants.length > 0) {
		sections.push("## Hard invariants", ...parsed.invariants.map((item, index) => `${index + 1}. ${item}`));
	}
	for (const section of parsed.sections) {
		sections.push(`## ${section.title}`, section.body);
	}
	if (parsed.importedAgentContext) {
		sections.push("## Imported agent context", parsed.importedAgentContext);
	}
	return `<project-context${source}>\n${sections.join("\n\n")}\n</project-context>`;
}

const PROJECT_CONTEXT_CANDIDATES = ["CLIO-CODER.override.md", "CLIO-CODER.md"] as const;

function selectedClioMdPath(directory: string): string | null {
	for (const filename of PROJECT_CONTEXT_CANDIDATES) {
		const filePath = join(directory, filename);
		if (!existsSync(filePath)) continue;
		try {
			if (statSync(filePath).isFile()) return filePath;
		} catch {
			// Preserve candidate precedence and let the read below own the
			// actionable error instead of silently falling back to the base file.
			return filePath;
		}
	}
	return null;
}

function readClioMdPath(
	filePath: string,
): { ok: true; source: string; value: ParsedClioMd | null } | { ok: false; error: string } {
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
	if (content.trim().length === 0) return { ok: false, error: "handbook is empty" };
	// Authored Markdown needs no generator schema. Preserve it even when a
	// structured projection cannot be derived; producer validation stays strict.
	const parsed = parseClioMd(content);
	return { ok: true, source: content, value: parsed.ok ? parsed.value : null };
}

function mergeClioMdFiles(files: ReadonlyArray<LoadedClioMdFile>): ParsedClioMd | null {
	const values = files.flatMap((file) => (file.value ? [file.value] : []));
	const nearest = values.at(-1);
	if (!nearest) return null;
	return {
		projectName: nearest.projectName,
		identity: values.map((value) => value.identity).join("\n\n"),
		conventions: values.flatMap((value) => value.conventions),
		invariants: values.flatMap((value) => value.invariants),
		sections: values.flatMap((value) => value.sections),
		importedAgentContext:
			values
				.map((value) => value.importedAgentContext)
				.filter((value): value is string => value !== null)
				.join("\n\n") || null,
		fingerprint: nearest.fingerprint,
		firstInit: nearest.firstInit,
		warnings: values.flatMap((value) => value.warnings),
	};
}

/**
 * Load effective project handbooks from filesystem root through `cwd`.
 * Candidate selection follows pi-coding-agent 0.84's
 * `loadProjectContextFiles`: an override wins over the base file in the same
 * directory. Clio's override additionally resets the inherited
 * handbook chain for that subtree, as required by the project-context
 * contract. Handbooks below the override may add new layers.
 */
export function loadProjectClioMd(cwd: string): LoadedProjectClioMd {
	const directories: string[] = [];
	let directory = resolve(cwd);
	while (true) {
		directories.unshift(directory);
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}

	const selectedPaths: string[] = [];
	for (const current of directories) {
		const selected = selectedClioMdPath(current);
		if (!selected) continue;
		if (basename(selected) === "CLIO-CODER.override.md") {
			selectedPaths.length = 0;
		}
		selectedPaths.push(selected);
	}

	const files: LoadedClioMdFile[] = [];
	const errors: ClioMdLoadError[] = [];
	for (const filePath of selectedPaths) {
		const read = readClioMdPath(filePath);
		if (read.ok) files.push({ path: filePath, source: read.source, value: read.value });
		else errors.push({ path: filePath, error: read.error });
	}
	return { files, errors, value: mergeClioMdFiles(files) };
}

export function tryReadClioMd(
	cwd: string,
): { ok: true; source: string; value: ParsedClioMd | null } | { ok: false; error: string } | null {
	const filePath = join(cwd, "CLIO-CODER.md");
	if (!existsSync(filePath)) return null;
	return readClioMdPath(filePath);
}
