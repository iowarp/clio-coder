import { decodeHTMLStrict } from "entities";
import type { Token, Tokens, TokensList } from "marked";
import { Lexer, Marked } from "marked";
import type { WikiPageMetadata } from "./frontmatter.js";
import { renderFrontmatter } from "./frontmatter.js";

const options = { gfm: true, breaks: false, pedantic: false };
const markdown = new Marked(options);

export interface WikiMarkdown {
	tokens: TokensList;
	citations: Tokens.Codespan[];
	links: Array<{ token: Tokens.Link; definition?: Tokens.Def }>;
}

export function inspectWikiMarkdown(body: string): WikiMarkdown {
	const tokens = markdown.lexer(body);
	const citations: Tokens.Codespan[] = [];
	const links: WikiMarkdown["links"] = [];
	const definitions = new Map<string, Tokens.Def>();
	markdown.walkTokens(tokens, (token) => {
		if (token.type === "def" && !definitions.has(token.tag)) definitions.set(token.tag, token as Tokens.Def);
	});
	markdown.walkTokens(tokens, (token) => {
		if (token.type === "codespan") citations.push(token as Tokens.Codespan);
		if (token.type !== "link") return;
		let definition: Tokens.Def | undefined;
		const lexer = new Lexer(options);
		// Marked owns reference-label normalization and resolution, including shortcuts.
		lexer.tokens.links = new Proxy(tokens.links, {
			get(target, key: string) {
				definition = definitions.get(key);
				return target[key];
			},
		});
		lexer.inlineTokens(token.raw);
		links.push({ token: token as Tokens.Link, ...(definition ? { definition } : {}) });
	});
	return { tokens, citations, links };
}

export interface WikiMarkdownEdit {
	token: Tokens.Codespan | Tokens.Link | Tokens.Def;
	value: string;
	/** Resolved reference users whose destinations change with this definition. */
	users?: Tokens.Link[];
}

function signature(value: unknown, changes: ReadonlyMap<Token, string>): unknown {
	if (Array.isArray(value)) return value.map((item) => signature(item, changes));
	if (value === null || typeof value !== "object") return value;
	const object = value as Record<string, unknown>;
	const change = changes.get(value as Token);
	return Object.fromEntries(
		Object.entries(object)
			.filter(
				([key]) =>
					key !== "raw" && !(key === "text" && object.type !== "link" && ("tokens" in object || object.type === "table")),
			)
			.map(([key, entry]) => [
				key,
				change !== undefined && (key === "href" || (key === "text" && object.type === "codespan"))
					? change
					: signature(entry, changes),
			]),
	);
}

/** Marked normalizes source; repeated codespans require every raw occurrence to survive token verification. */
export function patchWikiMarkdown(
	body: string,
	inspection: WikiMarkdown,
	edits: WikiMarkdownEdit[],
): { body: string; diagnostics: string[] } {
	const diagnostics: string[] = [];
	if (edits.length > 512)
		return {
			body,
			diagnostics: ["Page exceeds the 512-edit Markdown repair limit; canonicalize references before retrying."],
		};
	const groups = new Map<string, WikiMarkdownEdit[]>();
	for (const edit of edits) {
		const group = groups.get(edit.token.raw) ?? [];
		group.push(edit);
		groups.set(edit.token.raw, group);
	}
	const changes = new Map<Token, string>();
	const patches: Array<{ start: number; end: number; value: string }> = [];
	const failed = (edit: WikiMarkdownEdit): void => {
		const before = edit.token.type === "codespan" ? edit.token.text : edit.token.href;
		const diagnostic = `Repair ${JSON.stringify(before)} to ${JSON.stringify(edit.value)} manually; no safe exact Markdown span.`;
		if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic);
	};
	for (const group of groups.values()) {
		const first = group[0];
		if (!first) continue;
		const { token, value } = first;
		const before = token.type === "codespan" ? token.text : token.href;
		const offset = token.raw.indexOf(before);
		const starts: number[] = [];
		for (let start = body.indexOf(token.raw); start >= 0; start = body.indexOf(token.raw, start + 1)) {
			starts.push(start);
			if (starts.length > 512) break;
		}
		if (
			!before ||
			!token.raw ||
			starts.length === 0 ||
			starts.length > 512 ||
			(token.type !== "codespan" && starts.length !== 1) ||
			offset < 0 ||
			token.raw.indexOf(before, offset + 1) !== -1 ||
			group.some((edit) => edit.value !== value || edit.token.type !== token.type)
		) {
			for (const edit of group) failed(edit);
			continue;
		}
		for (const start of starts) patches.push({ start: start + offset, end: start + offset + before.length, value });
		for (const edit of group) {
			changes.set(edit.token, value);
			for (const user of edit.users ?? []) changes.set(user, value);
		}
	}
	patches.sort((a, b) => a.start - b.start);
	if (patches.some((patch, index) => index > 0 && patch.start < (patches[index - 1]?.end ?? 0))) {
		for (const edit of edits) failed(edit);
		return { body, diagnostics };
	}
	if (patches.length === 0) return { body, diagnostics };
	let proposed = body;
	for (const patch of [...patches].reverse()) {
		proposed = proposed.slice(0, patch.start) + patch.value + proposed.slice(patch.end);
	}
	if (
		JSON.stringify(signature(inspection.tokens, changes)) !==
		JSON.stringify(signature(markdown.lexer(proposed), new Map()))
	) {
		for (const edit of edits) failed(edit);
		return { body, diagnostics };
	}
	return { body: proposed, diagnostics };
}

export function repairWikiCitations(
	body: string,
	citations: Readonly<Record<string, string>>,
): ReturnType<typeof patchWikiMarkdown> {
	if (Object.keys(citations).length === 0) return { body, diagnostics: [] };
	const inspection = inspectWikiMarkdown(body);
	return patchWikiMarkdown(
		body,
		inspection,
		inspection.citations.flatMap((token) => {
			const value = Object.hasOwn(citations, token.text) ? citations[token.text] : undefined;
			return value !== undefined && value !== token.text ? [{ token, value }] : [];
		}),
	);
}

export function decodeWikiDestination(href: string): { path: string; suffix: string } | null {
	const decoded = decodeHTMLStrict(href);
	if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(decoded)) return null;
	const separator = decoded.search(/[?#]/);
	const path = separator < 0 ? decoded : decoded.slice(0, separator);
	const suffix = separator < 0 ? "" : decoded.slice(separator);
	try {
		// Encoded separators stay literal so %2F cannot change the target namespace.
		const decodedPath = path
			.split(/(%2f|%5c)/i)
			.map((part, index) => (index % 2 === 0 ? decodeURIComponent(part) : part))
			.join("");
		return { path: decodedPath, suffix };
	} catch {
		return { path, suffix };
	}
}

/**
 * Rebuild a page from repaired metadata and its body, guaranteeing the body
 * opens with an H1 that matches the metadata title. Without the H1 the page
 * reads as a fragment and every title fallback in the codebase records the
 * filename instead of a name.
 */
export function renderWikiPage(metadata: WikiPageMetadata, body: string): string {
	const hasHeading = inspectWikiMarkdown(body).tokens.some((token) => token.type === "heading" && token.depth === 1);
	const withHeading = hasHeading ? body : `# ${metadata.title}\n\n${body}`;
	return `${renderFrontmatter(metadata)}${withHeading}`;
}
