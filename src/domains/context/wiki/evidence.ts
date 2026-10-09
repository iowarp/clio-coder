/** Mechanical publication checks; these do not prove a claim or that a writer read its source. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, posix, relative, resolve } from "node:path";
import type { Tokens } from "marked";
import { parse } from "yaml";
import { enumerateWorkspaceFiles } from "../../../core/workspace-files.js";
import { readWikiPage, resolveSourcePath, stripFrontmatter } from "./frontmatter.js";
import { isGeneratedWikiFile, WIKI_INDEX, WIKI_QUICKSTART, wikiMarkdownFilesInDir } from "./layout.js";
import type { WikiMarkdownEdit } from "./markdown.js";
import { decodeWikiDestination, inspectWikiMarkdown, patchWikiMarkdown, repairWikiCitations } from "./markdown.js";
import type { WikiPlan } from "./plan.js";

export interface WikiPageEvidenceInput {
	pagePath: string;
	content: string;
	sourceRoot: string;
	wikiLinks?: WikiLinkInventory;
}

export interface WikiPageEvidenceResult {
	ok: boolean;
	/** At most eight actionable diagnostics, each bounded for the persisted retry reason. */
	reasons: string[];
	/** Canonical repository-relative evidence files, present only after successful validation. */
	dependencies?: string[];
	/** Individually resolved files on failure, including files with invalid line citations. */
	resolvedDependencies?: string[];
	/** Every diagnostic produced on failure, without the display count or length limits. */
	allReasons?: string[];
	/** Changed body citations that passed individually, even when another reference failed. */
	resolvedCitations?: Record<string, string>;
	/** Digest of the contained, regular draft bytes read by the shared inspector. */
	draftHash?: string;
	/** Coverage failures require substantive writing, not a mechanical repair pass. */
	validationKind?: "coverage";
	/** Non-gating diagnostic: line citations whose bound identifier is absent from the cited lines. */
	relevance?: WikiRelevance;
}

export interface WikiRelevanceFlag {
	citation: string;
	identifier: string;
	/** 1-based lines where the identifier occurs in the cited file, at most eight. */
	lines: number[];
}

export interface WikiRelevance {
	flags: WikiRelevanceFlag[];
	summary: string;
}

const IDENTIFIER_SPAN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;
const SOURCE_EXTENSION =
	/\.(?:[cm]?[jt]sx?|py|rs|go|c|h|cpp|hpp|java|rb|sh|json|ya?ml|toml|md|txt|ini|cfg|xml|html|css|sql)$/i;
const RELEVANCE_SLACK = 2;
const MAX_RELEVANCE_FLAGS = 32;

function escapeRegexText(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A backticked span is an identifier when it is not itself a file reference. */
function identifierFromSpan(span: string): string | null {
	const text = span.replace(/^`+|`+$/g, "").trim();
	if (!IDENTIFIER_SPAN.test(text) || SOURCE_EXTENSION.test(text)) return null;
	return text.replace(/\(\)$/, "");
}

/**
 * Finds the identifiers prose ties to one citation span: `ID` (`cite`), `ID` at|in|defined in `cite`
 * (up to four letter-led words between, so punctuation ends adjacency), or `cite` (`ID`). Marked supplies
 * the inline text; only the exact citation span anchors the match. The regexes compile once per span and
 * identical inline texts are scanned once.
 */
function adjacentIdentifiers(inlines: ReadonlySet<string>, citationRaw: string): string[] {
	const cite = escapeRegexText(citationRaw);
	const before = new RegExp(`(\`+[^\`]+\`+)\\s*(?:\\(\\s*|(?:[A-Za-z][\\w'-]*\\s+){0,4}(?:at|in)\\s+)${cite}`, "g");
	const after = new RegExp(`${cite}\\s*\\(\\s*(\`+[^\`]+\`+)\\s*\\)`, "g");
	const found = new Set<string>();
	for (const inline of inlines) {
		for (const matcher of [before, after]) {
			for (const hit of inline.matchAll(matcher)) {
				const id = identifierFromSpan(hit[1] ?? "");
				if (id !== null) found.add(id);
			}
		}
	}
	return [...found];
}

function relevanceSummary(flags: readonly WikiRelevanceFlag[]): string {
	const items = flags.map((flag) => {
		const where = flag.lines.length > 0 ? `at ${flag.lines.slice(0, 3).join(", ")}` : "not found";
		return `\`${flag.citation}\` (${flag.identifier} ${where})`;
	});
	const noun = flags.length === 1 ? "line citation names" : "line citations name";
	const line = `${flags.length} ${noun} an identifier outside the cited lines \u00b12: ${items.join(", ")}`;
	return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

function within(root: string, path: string): boolean {
	const rel = relative(root, path).replace(/\\/g, "/");
	return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

export interface WikiLinkInventory {
	targets: ReadonlySet<string>;
	unavailable: ReadonlySet<string>;
}

export function wikiLinkInventory(dir: string, plannedPages: readonly string[] = []): WikiLinkInventory {
	const targets = new Set([WIKI_QUICKSTART, WIKI_INDEX, ...plannedPages]);
	const files = wikiMarkdownFilesInDir(dir);
	for (const pagePath of files) {
		if (isGeneratedWikiFile(pagePath)) continue;
		let body: string;
		try {
			body = stripFrontmatter(readFileSync(resolve(dir, pagePath), "utf8")).body;
		} catch {
			continue;
		}
		if (
			!body
				.replace(/<!--[\s\S]*?-->/g, "")
				.replace(/^\s*#.*$/gm, "")
				.trim()
		)
			continue;
		targets.add(pagePath);
	}
	for (const pagePath of targets) {
		let section = posix.dirname(pagePath);
		while (section !== ".") {
			targets.add(`${section}/${WIKI_INDEX}`);
			section = posix.dirname(section);
		}
	}
	return { targets, unavailable: new Set(files.filter((path) => !targets.has(path))) };
}

export function repairWikiLinks(
	pagePath: string,
	body: string,
	inventory: WikiLinkInventory,
): { body: string; unresolved: string[]; diagnostics?: string[] } {
	const { targets, unavailable } = inventory;
	const unresolved: string[] = [];
	const repair = (destination: string): string => {
		const decoded = decodeWikiDestination(destination);
		// A tail after .md (encoded %23, %3F, whitespace, control or odd characters) is part of the literal file
		// name a browser requests, so such links are checked as page links. The tail starts with a non-name
		// character and stays inside the last segment. A tail that ends in a letter-led extension (.png, .ts)
		// names a non-page asset like img.md%3Fx.png and is skipped; a digit-led ending like %23v2.1 is a version
		// dot and is still checked. .mdx and .md.bak never match because the tail cannot start with a dot.
		const tail = decoded ? /\.md(?:([^\w./-][^/]*))?$/i.exec(decoded.path) : null;
		if (!decoded || !tail || (tail[1] !== undefined && /\.[A-Za-z][A-Za-z0-9]*$/.test(tail[1]))) return destination;
		const href = decoded.path;
		const anchor = decoded.suffix;
		const fromDir = posix.dirname(pagePath);
		// A leading slash names the wiki root. Joining it onto fromDir would certify a same-directory sibling.
		const target = posix.normalize(posix.isAbsolute(href) ? href.slice(1) : posix.join(fromDir, href));
		if (!target.startsWith("..") && targets.has(target)) return destination;
		let replacement: string | undefined;
		const rootPath = posix.normalize(href);
		if (!posix.isAbsolute(href) && !unavailable.has(target) && !unavailable.has(rootPath)) {
			if (targets.has(rootPath)) replacement = rootPath;
			else {
				const parts = rootPath.split("/");
				while (parts.length > 0) {
					const suffix = parts.join("/");
					const matches = [...targets].filter((page) => page === suffix || page.endsWith(`/${suffix}`));
					if (matches.length > 0) {
						if (matches.length === 1) replacement = matches[0];
						break;
					}
					parts.shift();
				}
			}
		}
		if (replacement === undefined) {
			unresolved.push(href);
			return destination;
		}
		const repaired = encodeURI(posix.relative(fromDir, replacement)).replace(
			/[?#()]/g,
			(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
		);
		return `${repaired}${anchor}`;
	};
	const inspection = inspectWikiMarkdown(body);
	const edits = new Map<WikiMarkdownEdit["token"], WikiMarkdownEdit>();
	for (const { token, definition } of inspection.links) {
		const value = repair(token.href);
		if (value === token.href) continue;
		const target = definition ?? token;
		const edit = edits.get(target) ?? { token: target, value, users: [] };
		if (definition) edit.users?.push(token);
		edits.set(target, edit);
	}
	const repaired = patchWikiMarkdown(body, inspection, [...edits.values()]);
	return {
		body: repaired.body,
		unresolved: [...new Set(unresolved)],
		...(repaired.diagnostics.length ? { diagnostics: repaired.diagnostics } : {}),
	};
}

/**
 * Validate the original writer output BEFORE assembly repairs metadata. Existing
 * frontmatter parsing supplies the references; no claims sidecar or prose schema
 * is required. The supported body citation form is a backticked file path with
 * optional :line[-end][:symbol], #Lline[-Lend] or a pytest node id
 * `path::Name(::Name)*`, which validates the file only. Markdown wiki links, commands,
 * symbols and decision refs are not interpreted as source evidence.
 */
export function validateWikiPageEvidence(input: WikiPageEvidenceInput): WikiPageEvidenceResult {
	const reasons: string[] = [];
	const allReasons: string[] = [];
	const fail = (reason: string): void => {
		allReasons.push(reason);
		if (reasons.length < 8) reasons.push(reason.slice(0, 300));
	};
	if (Buffer.byteLength(input.content, "utf8") > 2 * 1024 * 1024) {
		fail("Page exceeds the 2 MiB evidence-check limit; split or shorten it before retrying.");
		return { ok: false, reasons, allReasons, resolvedDependencies: [] };
	}
	const { body, metadata } = readWikiPage({ pagePath: input.pagePath, content: input.content });
	const coverageGaps = metadata.coverage_gaps ?? [];
	for (const gap of coverageGaps) fail(`Coverage gap: ${gap}`);
	if (input.wikiLinks) {
		const links = repairWikiLinks(input.pagePath, body, input.wikiLinks);
		for (const diagnostic of links.diagnostics ?? []) fail(diagnostic);
		for (const href of links.unresolved) {
			fail(`Repair unresolved wiki link ${JSON.stringify(href)} in ${input.pagePath}; its target page is unavailable.`);
		}
	}
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
				for (const field of ["sources", "tests", "coverage_gaps"] as const) {
					const value = (fields as Record<string, unknown>)[field];
					if (
						value !== undefined &&
						(!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()))
					) {
						const received = value === null ? "null" : Array.isArray(value) ? "array with invalid entries" : typeof value;
						const entries = field === "coverage_gaps" ? "coverage gap descriptions" : "repository-relative file paths";
						fail(`Repair frontmatter ${field}: use a list of nonempty ${entries}; received ${received}.`);
					}
				}
			}
		} catch {
			fail("Repair invalid YAML frontmatter; source/test evidence cannot be checked until it parses.");
		}
	} else if (/^---\r?\n/.test(input.content)) {
		fail("Close the YAML frontmatter with a standalone --- line before the page body.");
	}

	const declaredReferences = new Set([...metadata.sources, ...metadata.tests]);
	const references = new Set(declaredReferences);
	const bodyReferences = new Set<string>();
	for (const reference of references) {
		if (/[:#]/.test(reference))
			fail(`Use a plain file path in sources/tests: ${JSON.stringify(reference)}; put line/symbol citations in the body.`);
	}
	const inspection = inspectWikiMarkdown(body);
	const citationTokens = new Map<string, Tokens.Codespan[]>();
	for (const token of inspection.citations) {
		const cited = token.text;
		citationTokens.set(cited, [...(citationTokens.get(cited) ?? []), token]);
		if (/\s/.test(cited)) continue;
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
			bodyReferences.add(cited);
		}
	}

	if (references.size > 512) {
		fail("Page exceeds the 512-reference evidence-check limit; split or shorten it before retrying.");
		return {
			ok: false,
			reasons,
			allReasons,
			resolvedDependencies: [],
			...(coverageGaps.length > 0 ? { validationKind: "coverage" } : {}),
		};
	}
	let root: string;
	try {
		root = realpathSync(input.sourceRoot);
	} catch {
		fail("Repository root is unavailable; restore access and retry evidence validation.");
		return {
			ok: false,
			reasons,
			allReasons,
			resolvedDependencies: [],
			...(coverageGaps.length > 0 ? { validationKind: "coverage" } : {}),
		};
	}
	const dependencies = new Set<string>();
	const resolvedCitations: Record<string, string> = {};
	const declaredFiles = new Set<string>();
	const declaredFilesByName = new Map<string, Set<string>>();
	const linesByFile = new Map<string, number>();
	// Split text is kept beside the count so the relevance diagnostic never reads a file again.
	const textLinesByFile = new Map<string, string[]>();
	const relevanceFlags: WikiRelevanceFlag[] = [];
	let readBytes = 0;
	let literalBytes = 0;
	const literalText = new Map<string, string | null>();
	const sourceText = (path: string): string | null => {
		if (literalText.has(path)) return literalText.get(path) ?? null;
		let text: string | null = null;
		try {
			const real = realpathSync(path);
			const stat = statSync(real);
			if (within(root, real) && stat.isFile() && stat.size <= 512 * 1024 && literalBytes + stat.size <= 4 * 1024 * 1024) {
				literalBytes += stat.size;
				text = readFileSync(real, "utf8");
			}
		} catch {
			// An unreadable definition cannot establish a literal reference.
		}
		literalText.set(path, text);
		return text;
	};
	// Repository files, listed once and only when a body citation matches no
	// declared file. Small writer models cite `grader.py` for
	// `src/clio_researcher/grader.py` and `contracts/campaign.py` for
	// `src/clio_researcher/contracts/campaign.py`. Exactly one file whose name, or
	// whose path ending on whole segments, equals the citation is that file; zero
	// or several cannot establish a source dependency.
	let workspaceFiles: string[] | null = null;
	let filesByName: Map<string, string[]> | null = null;
	const listedFiles = (): string[] => {
		if (workspaceFiles === null) {
			try {
				workspaceFiles = enumerateWorkspaceFiles(root);
			} catch {
				// An incomplete listing resolves nothing; the reference fails as before.
				workspaceFiles = [];
			}
		}
		return workspaceFiles;
	};
	const sourceCandidates = (path: string): string[] => {
		if (path.endsWith(".js")) return [path, `${path.slice(0, -3)}.ts`, `${path.slice(0, -3)}.tsx`];
		if (path.endsWith(".mjs")) return [path, `${path.slice(0, -4)}.mts`];
		if (path.endsWith(".cjs")) return [path, `${path.slice(0, -4)}.cts`];
		return [path];
	};
	const repositoryFilesNamed = (name: string): string[] => {
		if (filesByName === null) {
			filesByName = new Map();
			for (const file of listedFiles()) {
				const key = basename(file);
				const files = filesByName.get(key) ?? [];
				files.push(file);
				filesByName.set(key, files);
			}
		}
		return sourceCandidates(name).flatMap((candidate) =>
			(filesByName?.get(candidate) ?? []).map((file) => resolve(root, file)),
		);
	};
	const repositoryFileEndingWith = (cited: string): string | null => {
		const segments = cited.split("/");
		if (segments.some((segment) => segment === "" || segment === "." || segment === "..") || /[*?{}<>[\]\\]/.test(cited))
			return null;
		const candidates = sourceCandidates(cited);
		const matches = listedFiles().filter((file) =>
			candidates.some((candidate) => file === candidate || file.split("\\").join("/").endsWith(`/${candidate}`)),
		);
		return matches.length === 1 ? resolveSourcePath(root, matches[0] ?? "") : null;
	};
	const importedSource = (specifier: string): string | null => {
		if (!/^\.\.?\//.test(specifier)) return null;
		const importPattern = new RegExp(
			`(?:\\bfrom\\s*|\\b(?:require|import)\\s*\\(\\s*|\\bimport\\s*)["']${escapeRegexText(specifier)}["']`,
		);
		const found = new Set<string>();
		for (const origin of declaredFiles) {
			if (!importPattern.test(sourceText(origin) ?? "")) continue;
			const cited = relative(root, resolve(dirname(origin), specifier));
			const resolved = resolveSourcePath(root, cited);
			if (resolved !== null) found.add(resolved);
		}
		return found.size === 1 ? ([...found][0] ?? null) : null;
	};
	const verifiedTestSelector = (selector: string): boolean => {
		if (
			selector.length > 160 ||
			!selector.includes("*") ||
			selector.includes("**") ||
			!/^[\w./*-]+$/.test(selector) ||
			selector.split("/").includes("..")
		)
			return false;
		const pattern = new RegExp(`^${selector.split("*").map(escapeRegexText).join("[^/]*")}$`);
		for (const path of declaredFiles) {
			try {
				let dir = dirname(path);
				while (dir !== root && !existsSync(resolve(dir, "package.json"))) {
					const parent = dirname(dir);
					if (parent === dir) break;
					dir = parent;
				}
				if (!pattern.test(relative(dir, path).split("\\").join("/"))) continue;
				const manifest = resolve(dir, "package.json");
				const scripts: unknown = JSON.parse(sourceText(manifest) ?? "{}").scripts;
				if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) continue;
				if (
					!Object.values(scripts).some(
						(command) =>
							typeof command === "string" &&
							command.split(/\s+/).some((token) => token.replace(/^["']|["']$/g, "") === selector),
					)
				)
					continue;
				dependencies.add(relative(root, realpathSync(manifest)).split("\\").join("/"));
				return true;
			} catch {
				// An unreadable package cannot establish a test selector.
			}
		}
		return false;
	};
	let trackedFiles: string[] | undefined;
	// Each tracked name is resolved at most once per validation, however many globs match it.
	const regularFileCache = new Map<string, boolean>();
	const isContainedRegularFile = (file: string): boolean => {
		const known = regularFileCache.get(file);
		if (known !== undefined) return known;
		let valid = false;
		try {
			const real = realpathSync(resolve(root, file));
			valid = within(root, real) && statSync(real).isFile();
		} catch {
			// A tracked path that no longer resolves cannot ground a layout.
		}
		regularFileCache.set(file, valid);
		return valid;
	};
	const groundedLayout = (cited: string): boolean => {
		if (isAbsolute(cited) || cited.includes("\\") || cited.split("/").includes("..")) return false;
		const literal = new RegExp(`(?<![\\w/.-])${escapeRegexText(cited)}(?![\\w/-]|\\.\\w)`);
		const glob = /[*?[]/.test(cited);
		const template = /<[A-Za-z_][\w-]*>|[{}]/.test(cited);
		if (glob && !template) {
			if (trackedFiles === undefined) {
				try {
					trackedFiles = execFileSync("git", ["ls-files", "--cached", "-z"], {
						cwd: root,
						encoding: "utf8",
						maxBuffer: 128 * 1024 * 1024,
						stdio: ["ignore", "pipe", "ignore"],
					})
						.split("\0")
						.filter(Boolean);
				} catch {
					// A repository without a tracked inventory cannot establish a glob.
					trackedFiles = [];
				}
			}
			// The index keeps deleted paths and symlinks, so a match must still be a contained regular file.
			return trackedFiles.some((file) => posix.matchesGlob(file, cited) && isContainedRegularFile(file));
		}
		return [...declaredFiles].some((path) => literal.test(sourceText(path) ?? ""));
	};
	for (const reference of references) {
		const label = JSON.stringify(reference);
		const match =
			/^([^:#]+)(?:(?::(\d+)(?:-(\d+))?)|(?:#L(\d+)(?:-L?(\d+))?))?(?::([A-Za-z_$][\w$.-]*)|((?:::[A-Za-z_][\w$.-]*)+))?$/.exec(
				reference,
			);
		if (!match) {
			fail(`Repair citation ${label}: use path, path:line[-end], path#Lline[-Lend], or path::Name.`);
			continue;
		}
		const cited = match[1] ?? "";
		const mention = !declaredReferences.has(reference) && reference === cited;
		try {
			if (
				!declaredReferences.has(reference) &&
				match[2] === undefined &&
				match[4] === undefined &&
				verifiedTestSelector(cited) &&
				groundedLayout(cited)
			)
				continue;
			let source = resolveSourcePath(resolve(input.sourceRoot), cited);
			if (source === null && !declaredReferences.has(reference)) source = importedSource(cited);
			if (source === null && !declaredReferences.has(reference) && !/[\\/]/.test(cited)) {
				const declared = declaredFilesByName.get(cited);
				const matches = declared ? [...declared] : repositoryFilesNamed(cited);
				if (matches.length === 1) source = matches[0] ?? null;
				else if (mention && matches.length > 1) continue;
			} else if (source === null && !declaredReferences.has(reference)) {
				source = repositoryFileEndingWith(cited);
			}
			if (source === null) {
				if (mention && groundedLayout(cited)) continue;
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
			// Declared references are checked first. Body shorthand can reuse only
			// their verified files; frontmatter itself remains repository-relative.
			if (declaredReferences.has(reference) && !/[:#]/.test(reference)) {
				declaredFiles.add(real);
				for (const name of [basename(cited), basename(real)]) {
					const files = declaredFilesByName.get(name) ?? new Set<string>();
					files.add(real);
					declaredFilesByName.set(name, files);
				}
			}
			const canonical = relative(root, real).split("\\").join("/");
			dependencies.add(canonical);
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
					textLinesByFile.set(real, text.split("\n"));
				}
				const start = Number(startText);
				const end = Number(match[3] ?? match[5] ?? startText);
				if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lines) {
					fail(
						`Repair line range in ${label}: the current file has ${lines} lines; use an existing ordered range starting at 1.`,
					);
					continue;
				}
				if (bodyReferences.has(reference) && relevanceFlags.length < MAX_RELEVANCE_FLAGS) {
					const tail = match[6] !== undefined ? `:${match[6]}` : (match[7] ?? "");
					const symbol = (match[6] ?? match[7]?.split("::").pop() ?? "").replace(/[.-]+$/, "");
					const own = identifierFromSpan(symbol);
					const tokens = citationTokens.get(reference) ?? [];
					const bound = own
						? [own]
						: [...new Set(tokens.map((token) => token.raw))].flatMap((raw) =>
								adjacentIdentifiers(
									new Set(
										tokens.filter((token) => token.raw === raw).map((token) => inspection.citationContext.get(token) ?? ""),
									),
									raw,
								),
							);
					const fileLines = textLinesByFile.get(real);
					for (const identifier of fileLines ? new Set(bound) : []) {
						if (relevanceFlags.length >= MAX_RELEVANCE_FLAGS) break;
						// The last segment alone decides: it is a whole-word match for the dotted form as well.
						const name = identifier.split(".").pop() ?? identifier;
						const word = new RegExp(`(?<![\\w$])${escapeRegexText(name)}(?![\\w$])`);
						const near = (fileLines ?? []).slice(Math.max(0, start - 1 - RELEVANCE_SLACK), end + RELEVANCE_SLACK);
						if (near.some((line) => word.test(line))) continue;
						const where: number[] = [];
						for (let index = 0; index < (fileLines?.length ?? 0) && where.length < 8; index++) {
							if (word.test(fileLines?.[index] ?? "")) where.push(index + 1);
						}
						relevanceFlags.push({
							citation: tail ? reference.slice(0, -tail.length) : reference,
							identifier,
							lines: where,
						});
					}
				}
			}
			if (bodyReferences.has(reference) && canonical !== cited) {
				resolvedCitations[reference] = `${canonical}${reference.slice(cited.length)}`;
			}
		} catch {
			fail(`Cannot inspect ${label}; restore readable repository evidence or remove the unsupported reference.`);
		}
	}
	for (const diagnostic of repairWikiCitations(body, resolvedCitations).diagnostics) fail(diagnostic);
	if (dependencies.size === 0)
		fail("Cite at least one existing repository file in sources/tests or as a backticked source path.");
	return {
		ok: reasons.length === 0,
		reasons,
		...(reasons.length === 0
			? { dependencies: [...dependencies].sort() }
			: { resolvedDependencies: [...dependencies].sort(), allReasons }),
		...(Object.keys(resolvedCitations).length > 0 ? { resolvedCitations } : {}),
		...(coverageGaps.length > 0 ? { validationKind: "coverage" } : {}),
		...(relevanceFlags.length > 0
			? { relevance: { flags: relevanceFlags, summary: relevanceSummary(relevanceFlags) } }
			: {}),
	};
}

/** Read a planned staging page with bounded IO before validating original evidence. */
export function inspectWikiPageEvidence(input: {
	pagePath: string;
	outputDir: string;
	sourceRoot: string;
	plan?: WikiPlan;
}): WikiPageEvidenceResult {
	const fail = (reason: string): WikiPageEvidenceResult => ({
		ok: false,
		reasons: [reason],
		allReasons: [reason],
		resolvedDependencies: [],
	});
	try {
		const path = realpathSync(resolve(input.outputDir, input.pagePath));
		const stat = statSync(path);
		if (!within(realpathSync(input.outputDir), path) || !stat.isFile())
			return fail("planned page must be a regular file inside wiki staging");
		if (stat.size > 2 * 1024 * 1024) return fail("page exceeds the 2 MiB evidence-check limit; split or shorten it");
		const content = readFileSync(path);
		return {
			...validateWikiPageEvidence({
				pagePath: input.pagePath,
				content: content.toString("utf8"),
				sourceRoot: input.sourceRoot,
				wikiLinks: wikiLinkInventory(
					input.outputDir,
					input.plan?.pages.map((page) => page.path),
				),
			}),
			draftHash: createHash("sha256").update(content).digest("hex"),
		};
	} catch {
		return fail("writer finished without a readable planned page file");
	}
}
