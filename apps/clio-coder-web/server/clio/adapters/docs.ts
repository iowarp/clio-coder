import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { marked, type Token, type Tokens } from "marked";
import { resolvePackageRoot } from "../../../../../src/core/package-root.js";
import type { DocPage, DocsRequest, DocsTree } from "../../../contracts/docs.js";
import { documentHeadings } from "../../../contracts/docs-headings.js";
import { AppProblem } from "../../services/problem.js";

function within(root: string, target: string) {
	const rel = relative(root, target);
	return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}
function contained(root: string, path: string) {
	if (!path || path.includes("\0") || path.includes("\\") || isAbsolute(path) || path.split("/").includes(".."))
		throw new AppProblem("unauthorized", "Documentation path is outside the allowed root.", 403);
	let target: string;
	try {
		target = realpathSync(resolve(root, path));
	} catch {
		throw new AppProblem("not_found", "Documentation file was not found.");
	}
	if (!within(root, target))
		throw new AppProblem("unauthorized", "Documentation path is outside the allowed root.", 403);
	return target;
}
function boundedRead(path: string, max: number) {
	const stat = statSync(path);
	if (!stat.isFile()) throw new AppProblem("not_found", "Documentation file was not found.");
	if (stat.size > max) throw new AppProblem("unavailable", "Documentation file exceeds the read limit.");
	return readFileSync(path);
}
function titleOf(path: string, markdown: string) {
	return /^#\s+(.+)$/m.exec(markdown)?.[1]?.replace(/[`*_]/g, "") ?? path.replace(/\.md$/i, "");
}
type Indexed = { path: string; title: string; markdown: string; anchors: Set<string> };

export class DocsAdapter {
	private catalog: { pages: Map<string, Indexed>; tree: DocsTree } | undefined;
	private root: string | undefined;
	constructor(private readonly packageRoot: string = resolvePackageRoot()) {}
	private docsRoot() {
		this.root ??= contained(realpathSync(this.packageRoot), "docs");
		return this.root;
	}
	private index() {
		if (this.catalog) return this.catalog;
		const root = this.docsRoot(),
			pages = new Map<string, Indexed>(),
			visited = new Set<string>();
		let bytes = 0;
		const scan = (path: string) => {
			const directory = path ? contained(root, path) : root;
			if (visited.has(directory)) return;
			visited.add(directory);
			for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
				const name = path ? `${path}/${entry.name}` : entry.name;
				if (name === "html") continue;
				// Do not follow directory symlinks or expose symlink escapes in an inventory.
				if (entry.isDirectory()) scan(name);
				else if (entry.isFile() && /\.md$/i.test(name)) {
					const markdown = boundedRead(contained(root, name), 1024 * 1024).toString("utf8");
					bytes += Buffer.byteLength(markdown);
					if (bytes > 16 * 1024 * 1024 || pages.size >= 10_000)
						throw new AppProblem("unavailable", "Documentation index exceeds its limit.");
					pages.set(name, {
						path: name,
						title: titleOf(name, markdown),
						markdown,
						anchors: new Set(documentHeadings(marked.lexer(markdown)).values()),
					});
				}
			}
		};
		scan("");
		const groups: DocsTree["groups"] = [];
		let group: DocsTree["groups"][number] | undefined;
		for (const token of marked.lexer(pages.get("README.md")?.markdown ?? "")) {
			if (token.type === "heading" && token.depth === 2) {
				group = { title: token.text, pages: [] };
				groups.push(group);
			}
			if (token.type === "table" && group) {
				const current = group;
				marked.walkTokens([token], (child) => {
					if (child.type !== "link") return;
					const page = pages.get(posix.normalize(child.href.split("#")[0] ?? ""));
					if (page && !current.pages.some((row) => row.path === page.path))
						current.pages.push({ path: page.path, title: page.title });
				});
			}
		}
		this.catalog = {
			pages,
			tree: {
				pages: [...pages.values()].map(({ path, title }) => ({ path, title })),
				groups: groups.filter((row) => row.pages.length),
			},
		};
		return this.catalog;
	}
	private link(from: string, href: string): string | null {
		const publicDocs = /^https:\/\/github\.com\/iowarp\/clio-coder\/(?:blob|tree)\/(?:main|v048)\/docs\/(.+)$/i.exec(
			href,
		);
		if (publicDocs) href = `/${publicDocs[1]}`;
		if (/^(https?:|mailto:)/i.test(href)) return href;
		if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return null;
		let decoded: string;
		try {
			decoded = decodeURIComponent(href);
		} catch {
			return null;
		}
		if (/[\0\\]/.test(decoded)) return null;
		const [location = "", hash] = decoded.split("#", 2);
		const path = location.split("?")[0] || from;
		const normalized = posix.normalize(
			location ? (path.startsWith("/") ? path.slice(1) : posix.join(dirname(from), path)) : from,
		);
		const pagePath = this.index().pages.has(normalized) ? normalized : `${normalized.replace(/\/$/, "")}/README.md`;
		const page = this.index().pages.get(pagePath);
		if (page) {
			if (hash && !page.anchors.has(hash)) return null;
			return `/docs/${pagePath.split("/").map(encodeURIComponent).join("/")}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
		}
		// Source references outside docs remain explicit links to the public repository.
		const packagePath = posix.normalize(`docs/${normalized}`);
		try {
			contained(realpathSync(this.packageRoot), packagePath);
		} catch {
			return null;
		}
		return `https://github.com/iowarp/clio-coder/blob/main/${packagePath.split("/").map(encodeURIComponent).join("/")}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
	}
	read(input: DocsRequest): DocsTree | DocPage | { path: string; title: string; excerpt: string }[] {
		if (input.kind === "tree") return this.index().tree;
		if (input.kind === "search") {
			const terms = input.q.toLowerCase().trim().split(/\s+/).filter(Boolean);
			if (!terms.length) return [];
			return [...this.index().pages.values()]
				.map((page) => {
					const text = page.markdown.toLowerCase();
					const score = terms.reduce(
						(n, term) =>
							n +
							(page.title.toLowerCase().includes(term) ? 100 : 0) +
							(page.path.toLowerCase().includes(term) ? 50 : 0) +
							Math.min(20, text.split(term).length - 1),
						0,
					);
					const at = Math.max(0, text.indexOf(terms[0] ?? ""));
					return {
						path: page.path,
						title: page.title,
						excerpt: page.markdown.slice(Math.max(0, at - 50), at + 180).replace(/\s+/g, " "),
						score,
					};
				})
				.filter((row) => row.score > 0)
				.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
				.slice(0, 30)
				.map(({ score: _score, ...row }) => row);
		}
		if (!/\.md$/i.test(input.path)) throw new AppProblem("validation", "Only Markdown document paths are accepted.");
		const markdown = boundedRead(contained(this.docsRoot(), input.path), 1024 * 1024).toString("utf8");
		const links: Record<string, string | null> = Object.create(null);
		const tokens = marked.lexer(markdown);
		marked.walkTokens(tokens, (token: Token) => {
			if (token.type === "link") links[(token as Tokens.Link).href] = this.link(input.path, (token as Tokens.Link).href);
		});
		return {
			path: input.path,
			title: titleOf(input.path, markdown),
			markdown,
			headings: [...documentHeadings(tokens)].map(([token, id]) => ({
				id,
				title: (token as Tokens.Heading).text.replace(/<[^>]*>/g, "").replace(/[`*_~]/g, ""),
				depth: (token as Tokens.Heading).depth,
			})),
			links,
			unavailableLinks: Object.entries(links)
				.filter(([, destination]) => destination === null)
				.map(([href]) => href),
		};
	}
}
