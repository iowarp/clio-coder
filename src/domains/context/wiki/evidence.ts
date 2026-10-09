/** Mechanical publication checks; these do not prove a claim or that a writer read its source. */
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, matchesGlob, posix, relative, resolve } from "node:path";
import { parse } from "yaml";
import { enumerateWorkspaceFiles } from "../../../core/workspace-files.js";
import { mapWikiProse, readWikiPage, resolveSourcePath, stripFrontmatter } from "./frontmatter.js";
import { isGeneratedWikiFile, WIKI_INDEX, WIKI_QUICKSTART, wikiMarkdownFilesInDir } from "./layout.js";

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
	/** Changed body citations that passed individually, even when another reference failed. */
	resolvedCitations?: Record<string, string>;
}

function within(root: string, path: string): boolean {
	const rel = relative(root, path).replace(/\\/g, "/");
	return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

export interface WikiLinkInventory {
	targets: ReadonlySet<string>;
	unavailable: ReadonlySet<string>;
}

export function wikiLinkInventory(dir: string): WikiLinkInventory {
	const targets = new Set([WIKI_QUICKSTART, WIKI_INDEX]);
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
): { body: string; unresolved: string[] } {
	const { targets, unavailable } = inventory;
	const unresolved: string[] = [];
	const repaired = mapWikiProse(body, (line) =>
		line.replace(
			/(\[[^\]]*\]\()(?![a-z][a-z\d+.-]*:|\/\/|#)([^)\s]+\.md)(#[^)\s]*)?\)/gi,
			(link: string, opening: string, href: string, anchor: string = "") => {
				const fromDir = posix.dirname(pagePath);
				const target = posix.normalize(posix.join(fromDir, href));
				if (!target.startsWith("..") && targets.has(target)) return link;
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
					return link;
				}
				return `${opening}${posix.relative(fromDir, replacement)}${anchor})`;
			},
		),
	);
	return { body: repaired, unresolved };
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
	const fail = (reason: string): void => {
		if (reasons.length < 8) reasons.push(reason.slice(0, 300));
	};
	if (Buffer.byteLength(input.content, "utf8") > 2 * 1024 * 1024) {
		return { ok: false, reasons: ["Page exceeds the 2 MiB evidence-check limit; split or shorten it before retrying."] };
	}
	const { body, metadata } = readWikiPage({ pagePath: input.pagePath, content: input.content });
	if (input.wikiLinks) {
		for (const href of repairWikiLinks(input.pagePath, body, input.wikiLinks).unresolved) {
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
				for (const field of ["sources", "tests"] as const) {
					const value = (fields as Record<string, unknown>)[field];
					if (
						value !== undefined &&
						(!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()))
					) {
						const received = value === null ? "null" : Array.isArray(value) ? "array with invalid entries" : typeof value;
						fail(`Repair frontmatter ${field}: use a list of nonempty repository-relative file paths; received ${received}.`);
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
			bodyReferences.add(cited);
		}
	}
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
	const resolvedCitations: Record<string, string> = {};
	const declaredFiles = new Set<string>();
	const declaredFilesByName = new Map<string, Set<string>>();
	const linesByFile = new Map<string, number>();
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
	const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
			`(?:\\bfrom\\s*|\\b(?:require|import)\\s*\\(\\s*|\\bimport\\s*)["']${escapeRegex(specifier)}["']`,
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
		const pattern = new RegExp(`^${selector.split("*").map(escapeRegex).join("[^/]*")}$`);
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
	const groundedLayout = (cited: string): boolean => {
		if (isAbsolute(cited) || cited.includes("\\") || cited.split("/").includes("..")) return false;
		const literal = (value: string): RegExp => new RegExp(`(?<![\\w/.-])${escapeRegex(value)}(?![\\w/-]|\\.\\w)`);
		const fragments = cited
			.split(/<[A-Za-z_][\w-]*>/)
			.map((fragment) => fragment.replace(/^\/+|\/+$/g, ""))
			.filter(Boolean);
		const glob = /[*?[]/.test(cited);
		if (glob && !cited.includes("<") && listedFiles().some((file) => matchesGlob(file, cited))) return true;
		return [...declaredFiles].some((path) => {
			const text = sourceText(path) ?? "";
			if (literal(cited).test(text)) return true;
			if (glob && !cited.includes("<")) return false;
			return (
				fragments.length > 0 &&
				fragments.every(
					(fragment) => literal(fragment).test(text) || fragment.split("/").every((part) => literal(part).test(text)),
				)
			);
		});
	};
	for (const reference of references) {
		const label = JSON.stringify(reference.slice(0, 160));
		const match =
			/^([^:#]+)(?:(?::(\d+)(?:-(\d+))?)|(?:#L(\d+)(?:-L?(\d+))?))?(?::[A-Za-z_$][\w$.-]*|(?:::[A-Za-z_][\w$.-]*)+)?$/.exec(
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
				verifiedTestSelector(cited)
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
				}
				const start = Number(startText);
				const end = Number(match[3] ?? match[5] ?? startText);
				if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lines) {
					fail(
						`Repair line range in ${label}: the current file has ${lines} lines; use an existing ordered range starting at 1.`,
					);
					continue;
				}
			}
			if (bodyReferences.has(reference) && canonical !== cited) {
				resolvedCitations[reference] = `${canonical}${reference.slice(cited.length)}`;
			}
		} catch {
			fail(`Cannot inspect ${label}; restore readable repository evidence or remove the unsupported reference.`);
		}
	}
	if (dependencies.size === 0)
		fail("Cite at least one existing repository file in sources/tests or as a backticked source path.");
	return {
		ok: reasons.length === 0,
		reasons,
		...(reasons.length === 0 ? { dependencies: [...dependencies].sort() } : {}),
		...(Object.keys(resolvedCitations).length > 0 ? { resolvedCitations } : {}),
	};
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
			wikiLinks: wikiLinkInventory(input.outputDir),
		});
	} catch {
		return { ok: false, reasons: ["writer finished without a readable planned page file"] };
	}
}
