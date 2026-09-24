import { lexMarkdown, type MarkdownToken } from "./markdown-model.js";

/**
 * A collapsible section from `<details><summary>…</summary>` source. Only this one construct is
 * recognised. The raw HTML is never rendered: its text is read for a summary line and an `open`
 * flag, and every other attribute is dropped. Everything between the tags is ordinary Markdown.
 */
export interface DetailsNode {
	readonly kind: "details";
	/** The opening HTML token; it gives the node a stable identity. */
	readonly key: MarkdownToken;
	/** The summary line as written, possibly with tags. Callers reduce it to text. */
	readonly summary: string | undefined;
	readonly open: boolean;
	readonly children: readonly BlockNode[];
}
export type BlockNode = MarkdownToken | DetailsNode;

const OPEN = /^\s*<details\b([^>]*)>/i;
const SUMMARY = /^\s*<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i;
const CLOSE_ONLY = /^\s*<\/details\s*>\s*$/i;
const CLOSE_TAIL = /<\/details\s*>\s*$/i;

interface Opening {
	readonly open: boolean;
	readonly summary: string | undefined;
	/** Markdown that shares the HTML block with the tags, up to the closing tag if it is here too. */
	readonly rest: string;
	/** The closing tag is in the same token, so nothing follows to be consumed. */
	readonly complete: boolean;
}

function opening(text: string): Opening | null {
	const tag = OPEN.exec(text);
	if (!tag) return null;
	let rest = text.slice(tag[0].length);
	const summary = SUMMARY.exec(rest);
	if (summary) rest = rest.slice(summary[0].length);
	const tail = CLOSE_TAIL.exec(rest);
	if (tail) rest = rest.slice(0, tail.index);
	return {
		open: /(?:^|\s)open(?:\s|=|$)/i.test(tag[1] ?? ""),
		summary: summary?.[1],
		rest,
		complete: tail !== null,
	};
}

/**
 * Folds the flat token stream, where `<details>` and `</details>` are HTML blocks with the Markdown
 * between them, into nested sections. Tokens inside keep their identity, so heading anchors
 * computed over the flat stream still find them. An unclosed section runs to the end, as on GitHub.
 */
export function groupDetails(tokens: readonly MarkdownToken[]): readonly BlockNode[] {
	const out: BlockNode[] = [];
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index] as MarkdownToken;
		const head = token.type === "html" ? opening((token as MarkdownToken & { text: string }).text) : null;
		if (!head) {
			out.push(token);
			index += 1;
			continue;
		}
		const body: MarkdownToken[] = head.rest.trim() ? [...lexMarkdown(head.rest)] : [];
		let end = index + 1;
		if (!head.complete) {
			let depth = 1;
			for (; end < tokens.length; end += 1) {
				const inner = tokens[end] as MarkdownToken;
				if (inner.type === "html") {
					const text = (inner as MarkdownToken & { text: string }).text;
					if (CLOSE_ONLY.test(text)) {
						depth -= 1;
						if (depth === 0) break;
					} else if (opening(text)?.complete === false) depth += 1;
				}
				body.push(inner);
			}
		}
		out.push({ kind: "details", key: token, summary: head.summary, open: head.open, children: groupDetails(body) });
		index = head.complete ? index + 1 : end + 1;
	}
	return out;
}

export function isDetails(node: BlockNode): node is DetailsNode {
	return "kind" in node && node.kind === "details";
}

/** The summary as one line of plain text: tags removed, the caller decodes entities. */
export function summaryText(raw: string | undefined): string {
	const text = (raw ?? "")
		.replace(/<[^>]*>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return text || "Details";
}

/** The part of an element the reveal needs, so it runs against the DOM and against a plain fixture. */
export interface RevealTarget {
	readonly tagName: string;
	readonly parentElement: RevealTarget | null;
	open?: boolean;
}

/** Opens every collapsed section that encloses `target`, so a link to a heading inside one lands on it. */
export function openEnclosingDetails(target: RevealTarget | null): number {
	let opened = 0;
	for (let node = target?.parentElement ?? null; node; node = node.parentElement) {
		if (node.tagName.toUpperCase() === "DETAILS" && node.open === false) {
			node.open = true;
			opened += 1;
		}
	}
	return opened;
}
