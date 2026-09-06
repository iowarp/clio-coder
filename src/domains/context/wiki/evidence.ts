/** Mechanical publication checks; these do not prove a claim or that a writer read its source. */
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parse } from "yaml";
import { readWikiPage, resolveSourcePath, stripFrontmatter } from "./frontmatter.js";

export interface WikiPageEvidenceInput {
	pagePath: string;
	content: string;
	sourceRoot: string;
}

export interface WikiPageEvidenceResult {
	ok: boolean;
	/** At most eight actionable diagnostics, each bounded for the persisted retry reason. */
	reasons: string[];
	/** Canonical repository-relative evidence files, present only after successful validation. */
	dependencies?: string[];
}

function within(root: string, path: string): boolean {
	const rel = relative(root, path).replace(/\\/g, "/");
	return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

/**
 * Validate the original writer output BEFORE assembly repairs metadata. Existing
 * frontmatter parsing supplies the references; no claims sidecar or prose schema
 * is required. The supported body citation form is a backticked file path with
 * optional :line[-end][:symbol] or #Lline[-Lend]. Markdown wiki links, commands,
 * symbols and decision refs are not interpreted as source evidence.
 */
export function validateWikiPageEvidence(input: WikiPageEvidenceInput): WikiPageEvidenceResult {
	const reasons: string[] = [];
	const fail = (reason: string): void => {
		if (reasons.length < 8) reasons.push(reason.slice(0, 300));
	};
	if (Buffer.byteLength(input.content, "utf8") > 2 * 1024 * 1024) {
		return { ok: false, reasons: ["Page exceeds the 2 MiB evidence-check limit; split or shorten it before retrying."] };
	}
	const { body, metadata } = readWikiPage({ pagePath: input.pagePath, content: input.content });
	if (
		body
			.replace(/<!--[\s\S]*?-->/g, "")
			.replace(/^\s*#.*$/gm, "")
			.trim().length === 0
	) {
		fail("Write a nonempty page body beyond headings and comments, grounded in current repository files.");
	}
	const { block } = stripFrontmatter(input.content);
	if (block !== null) {
		try {
			const fields: unknown = parse(`\n${block}`, { schema: "core", uniqueKeys: true });
			if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
				fail("Repair the YAML frontmatter as a metadata mapping before retrying.");
			} else {
				for (const field of ["sources", "tests"] as const) {
					const value = (fields as Record<string, unknown>)[field];
					if (
						value !== undefined &&
						(!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()))
					) {
						fail(`Repair frontmatter ${field}: use a list of nonempty repository-relative file paths.`);
					}
				}
			}
		} catch {
			fail("Repair invalid YAML frontmatter; source/test evidence cannot be checked until it parses.");
		}
	} else if (/^---\r?\n/.test(input.content)) {
		fail("Close the YAML frontmatter with a standalone --- line before the page body.");
	}

	const references = new Set([...metadata.sources, ...metadata.tests]);
	for (const reference of references) {
		if (/[:#]/.test(reference))
			fail(
				`Use a plain file path in sources/tests: ${JSON.stringify(reference.slice(0, 160))}; put line/symbol citations in the body.`,
			);
	}
	// Remove code fences: example programs and shell commands are not citations.
	const prose = body.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, "");
	for (const match of prose.matchAll(/`([^`\s]+)`/g)) {
		const cited = match[1] ?? "";
		// A filename extension distinguishes a file citation from a symbol or a
		// recorded decision ref. Include extensionless conventional repo files.
		const pathLike = cited.includes("/") && /\.[\w-]+(?=[:#]|$)/.test(cited);
		const rootFile =
			/^[^/:#]+\.(?:[cm]?[jt]sx?|py|rs|go|c|h|cpp|hpp|java|rb|sh|json|ya?ml|toml|md|txt|ini|cfg|xml|html|css|sql)(?=[:#]|$)/i.test(
				cited,
			);
		if (
			!/^[a-z][a-z\d+.-]*:\/\//i.test(cited) &&
			(pathLike || rootFile || /^(?:Makefile|Dockerfile|LICENSE)(?=[:#]|$)/.test(cited))
		) {
			references.add(cited);
		}
	}
	if (references.size === 0)
		fail("Cite at least one existing repository file in sources/tests or as a backticked source path.");
	if (references.size > 512) {
		fail("Page exceeds the 512-reference evidence-check limit; split or shorten it before retrying.");
		return { ok: false, reasons };
	}
	let root: string;
	try {
		root = realpathSync(input.sourceRoot);
	} catch {
		fail("Repository root is unavailable; restore access and retry evidence validation.");
		return { ok: false, reasons };
	}
	const dependencies = new Set<string>();
	const linesByFile = new Map<string, number>();
	let readBytes = 0;
	for (const reference of references) {
		const label = JSON.stringify(reference.slice(0, 160));
		const match = /^([^:#]+)(?:(?::(\d+)(?:-(\d+))?)|(?:#L(\d+)(?:-L?(\d+))?))?(?::[A-Za-z_$][\w$.-]*)?$/.exec(reference);
		if (!match) {
			fail(`Repair citation ${label}: use path, path:line[-end], or path#Lline[-Lend].`);
			continue;
		}
		const cited = match[1] ?? "";
		try {
			const source = resolveSourcePath(resolve(input.sourceRoot), cited);
			if (source === null) {
				fail(`Replace or remove unresolved repository reference ${label}; inspect the current file path.`);
				continue;
			}
			const real = realpathSync(source);
			const stat = statSync(real);
			if (!within(root, real) || !stat.isFile()) {
				fail(
					`Replace ${label} with an existing file inside the repository; directories and escaping symlinks are not evidence.`,
				);
				continue;
			}
			accessSync(real, constants.R_OK);
			dependencies.add(relative(root, real).split("\\").join("/"));
			const startText = match[2] ?? match[4];
			if (startText !== undefined) {
				if (stat.size > 4 * 1024 * 1024) {
					fail(`Cannot check lines in ${label}: file exceeds 4 MiB; cite the file and symbol without a line range.`);
					continue;
				}
				let lines = linesByFile.get(real);
				if (lines === undefined) {
					if (readBytes + stat.size > 16 * 1024 * 1024) {
						fail(
							"Line citations exceed the 16 MiB total source-read limit; split the page or prefer file and symbol citations.",
						);
						continue;
					}
					readBytes += stat.size;
					const text = readFileSync(real, "utf8");
					lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
					linesByFile.set(real, lines);
				}
				const start = Number(startText);
				const end = Number(match[3] ?? match[5] ?? startText);
				if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lines) {
					fail(
						`Repair line range in ${label}: the current file has ${lines} lines; use an existing ordered range starting at 1.`,
					);
				}
			}
		} catch {
			fail(`Cannot inspect ${label}; restore readable repository evidence or remove the unsupported reference.`);
		}
	}
	return reasons.length === 0 ? { ok: true, reasons, dependencies: [...dependencies].sort() } : { ok: false, reasons };
}

/** Read a planned staging page with bounded IO before validating original evidence. */
export function inspectWikiPageEvidence(input: {
	pagePath: string;
	outputDir: string;
	sourceRoot: string;
}): WikiPageEvidenceResult {
	try {
		const path = realpathSync(resolve(input.outputDir, input.pagePath));
		const stat = statSync(path);
		if (!within(realpathSync(input.outputDir), path) || !stat.isFile())
			return { ok: false, reasons: ["planned page must be a regular file inside wiki staging"] };
		if (stat.size > 2 * 1024 * 1024)
			return { ok: false, reasons: ["page exceeds the 2 MiB evidence-check limit; split or shorten it"] };
		return validateWikiPageEvidence({
			pagePath: input.pagePath,
			content: readFileSync(path, "utf8"),
			sourceRoot: input.sourceRoot,
		});
	} catch {
		return { ok: false, reasons: ["writer finished without a readable planned page file"] };
	}
}
