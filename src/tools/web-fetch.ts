import { neutralizeFraming } from "../core/reminder-framing.js";
import { UNTRUSTED_CONTENT_BANNER } from "../core/untrusted-content.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { truncateUtf8 } from "./truncate-utf8.js";
import type { WebFetchNetworkDependencies } from "./web-fetch-network.js";
import { fetchWebUrl } from "./web-fetch-network.js";
import { webFetchToolSurface, webReadToolSurface } from "./web-fetch-surface.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_BYTES = 600_000;
const HARD_MAX_BYTES = 5_000_000;
const ERROR_PREVIEW_BYTES = 8_000;
const TRUNCATION_MARKER = "\n[output truncated]";
const HTML_SAMPLE_BYTES = 4096;

const DEFAULT_HEADERS: Record<string, string> = {
	"User-Agent":
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 clio-coder-web-fetch/1.0",
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/markdown,text/plain;q=0.8,*/*;q=0.5",
	"Accept-Language": "en-US,en;q=0.9",
};

interface ReadResult {
	text: string;
	bytesRead: number;
	truncated: boolean;
}

interface ExtractedContent {
	format: "markdown" | "text" | "raw";
	title?: string;
	description?: string;
	canonical?: string;
	content: string;
}

function parseHeaders(raw: unknown): Record<string, string> | null {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object" || Array.isArray(raw)) return null;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value !== "string") return null;
		out[key] = value;
	}
	return out;
}

function truncate(text: string, maxBytes: number): string {
	return truncateUtf8(text, maxBytes, TRUNCATION_MARKER);
}

function capOutput(text: string, maxBytes: number): { output: string; truncated: boolean } {
	const safe = neutralizeFraming(text);
	const output = truncate(safe, maxBytes);
	return { output, truncated: output !== safe };
}

async function readResponseText(response: Response, maxBytes: number): Promise<ReadResult> {
	if (!response.body) return { text: "", bytesRead: 0, truncated: false };
	const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/i.exec(
		response.headers.get("content-type") ?? "",
	);
	const encoding = (charset?.[1] ?? charset?.[2] ?? charset?.[3] ?? "").trim() || "utf-8";
	let decoder: InstanceType<typeof TextDecoder>;
	try {
		decoder = new TextDecoder(encoding);
	} catch {
		if (
			response.status < 200 ||
			response.status >= 300 ||
			isProbablyBinary(response.headers.get("content-type") ?? "", "")
		) {
			decoder = new TextDecoder("utf-8");
		} else {
			await response.body.cancel();
			throw new Error(`unsupported text encoding: ${JSON.stringify(encoding)}`);
		}
	}
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	let truncated = false;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;

			const chunk = Buffer.from(value);
			const remaining = maxBytes + 4 - totalBytes;
			if (remaining > 0) {
				const kept = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
				chunks.push(kept);
				totalBytes += kept.byteLength;
			}

			if (totalBytes > maxBytes || chunk.byteLength > remaining) {
				truncated = true;
				await reader.cancel();
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = Buffer.concat(chunks, totalBytes);
	if (truncated || bytes.byteLength > maxBytes) {
		return {
			text: `${decoder.decode(bytes.subarray(0, maxBytes), { stream: true })}${TRUNCATION_MARKER}`,
			bytesRead: bytes.byteLength,
			truncated: true,
		};
	}
	return { text: decoder.decode(bytes), bytesRead: bytes.byteLength, truncated: false };
}

function headerValue(response: Response, name: string): string {
	return response.headers.get(name) ?? "";
}

function looksLikeHtml(text: string): boolean {
	return /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<article[\s>]|<main[\s>]/i.test(
		text.slice(0, HTML_SAMPLE_BYTES),
	);
}

function isProbablyBinary(contentType: string, text: string): boolean {
	if (/^(image|audio|video)\//i.test(contentType)) return true;
	if (/application\/(pdf|zip|octet-stream|x-tar|gzip)/i.test(contentType)) return true;
	return text.includes("\0");
}

// String.fromCodePoint throws RangeError for values above U+10FFFF; a single
// malformed numeric entity (e.g. &#1114112;) must not fail the whole fetch, so
// out-of-range code points fall back to their original escape text.
function safeFromCodePoint(code: number, original: string): string {
	return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : original;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	nbsp: " ",
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

// One pass, so a decoded `&` never starts another entity: `&amp;lt;` reads as `&lt;`, not `<`.
function decodeEntities(value: string): string {
	return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(nbsp|amp|lt|gt|quot|apos));/gi, (m, dec, hex, named) => {
		if (dec !== undefined) return safeFromCodePoint(Number(dec), m);
		if (hex !== undefined) return safeFromCodePoint(Number.parseInt(hex, 16), m);
		return NAMED_ENTITIES[String(named).toLowerCase()] ?? m;
	});
}

// A fetched page is matched with forward scans, never with a lazy `[\s\S]*?` or a
// `[^>]*` run from every opener: an opener with no closer would rescan to the end of
// the page from each copy, quadratic in the body and synchronous on the event loop,
// where the fetch timeout and the interrupt key wait behind it. Each scan below
// matches what the regular expression it replaced matched.

// Lowering ASCII letters alone keeps every index, which toLowerCase does not, and
// folds exactly what a non-unicode `/i` pattern of ASCII literals folds.
function asciiLower(value: string): string {
	return value.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/** Whether `\b` holds after a name that ends in a word character. */
function boundaryAt(value: string, index: number): boolean {
	return index >= value.length || !/[A-Za-z0-9_]/.test(value.charAt(index));
}

/** The first `>` at or after `from`, remembering the last `>`-free stretch scanned. */
function gtFinder(lower: string): (from: number) => number {
	let scannedFrom = -1;
	let found = -1;
	return (from) => {
		if (scannedFrom >= 0 && from >= scannedFrom && (found < 0 || from <= found)) return found;
		scannedFrom = from;
		found = lower.indexOf(">", from);
		return found;
	};
}

/** Every index of `text` in `lower`, ascending, and the first one at or after `from`. */
function occurrences(lower: string, text: string): (from: number) => number {
	const found: number[] = [];
	for (let at = lower.indexOf(text); at >= 0; at = lower.indexOf(text, at + 1)) found.push(at);
	return (from) => {
		let lo = 0;
		let hi = found.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if ((found[mid] ?? 0) < from) lo = mid + 1;
			else hi = mid;
		}
		return found[lo] ?? -1;
	};
}

interface TagPair {
	start: number;
	contentStart: number;
	contentEnd: number;
	end: number;
}

interface TagPairShape {
	/** Finds an opener in the lowered page; group 1, when present, picks its closer. */
	opener: RegExp;
	/** The opener ends at a word boundary, as `<tag\b`. */
	boundary: boolean;
	/** The content starts after the opener's first `>`, as `<tag\b[^>]*>`, else right after the opener. */
	toGt: boolean;
	closer: (key: string) => string;
	/** The closer runs on to its first `>` after a word boundary, as `<\/tag\b[^>]*>`. */
	closerToGt: boolean;
}

/**
 * The matches of `opener…closer` with a lazy body, left to right and not
 * overlapping. An opener whose closer is missing has no closer after any later
 * opener either, so its kind is dropped instead of rescanned.
 */
function* tagPairs(lower: string, shape: TagPairShape): Generator<TagPair> {
	const opener = new RegExp(shape.opener.source, "g");
	const dead = new Set<string>();
	let from = 0;
	for (;;) {
		opener.lastIndex = from;
		const open = opener.exec(lower);
		if (open === null) return;
		const start = open.index;
		const key = open[1] ?? "";
		let contentStart = start + open[0].length;
		if (dead.has(key) || (shape.boundary && !boundaryAt(lower, contentStart))) {
			from = start + 1;
			continue;
		}
		if (shape.toGt) {
			const gt = lower.indexOf(">", contentStart);
			if (gt < 0) return;
			contentStart = gt + 1;
		}
		const closer = shape.closer(key);
		let end = -1;
		let at = lower.indexOf(closer, contentStart);
		while (at >= 0) {
			const after = at + closer.length;
			if (!shape.closerToGt) {
				end = after;
				break;
			}
			if (boundaryAt(lower, after)) {
				end = lower.indexOf(">", after) + 1;
				break;
			}
			at = lower.indexOf(closer, at + 1);
		}
		if (at < 0 || end <= 0) {
			dead.add(key);
			from = start + 1;
			continue;
		}
		yield { start, contentStart, contentEnd: at, end };
		from = end;
	}
}

function pairedTag(name: string): TagPairShape {
	return { opener: new RegExp(`<${name}`), boundary: true, toGt: true, closer: () => `</${name}>`, closerToGt: false };
}

function replaceTagPairs(page: string, shape: TagPairShape, replace: (content: string) => string): string {
	let out = "";
	let last = 0;
	for (const pair of tagPairs(asciiLower(page), shape)) {
		out += page.slice(last, pair.start) + replace(page.slice(pair.contentStart, pair.contentEnd));
		last = pair.end;
	}
	return last === 0 ? page : out + page.slice(last);
}

function firstTagContent(page: string, shape: TagPairShape): string | undefined {
	for (const pair of tagPairs(asciiLower(page), shape)) return page.slice(pair.contentStart, pair.contentEnd);
	return undefined;
}

/**
 * A global replace of a pattern that ends in `>` and cannot cross one, such as
 * `<[^>]+>`: no match ends past the last `>`, and before it every attempt reaches
 * a `>`, so the text after the last `>` is never scanned again and again.
 */
function replaceBeforeLastGt(value: string, regex: RegExp, replace: (tag: string) => string): string {
	const end = value.lastIndexOf(">") + 1;
	return end === 0 ? value : value.slice(0, end).replace(regex, replace) + value.slice(end);
}

function stripTags(value: string): string {
	return decodeEntities(
		replaceBeforeLastGt(value, /<[^>]+>/g, () => " ")
			.replace(/\s+/g, " ")
			.trim(),
	);
}

// Like stripTags but keeps newlines/indentation so fenced code blocks survive.
function stripCodeTags(value: string): string {
	return decodeEntities(replaceBeforeLastGt(value, /<[^>]+>/g, () => ""));
}

/** The first `<name\b[^>]*>` tag whose text holds `attribute`, as `<name\b[^>]*ATTR[^>]*>` matches it. */
function firstTagWith(page: string, name: string, attribute: RegExp): string | undefined {
	const lower = asciiLower(page);
	const opener = new RegExp(`<${name}`, "g");
	for (let open = opener.exec(lower); open !== null; open = opener.exec(lower)) {
		const tagStart = open.index + open[0].length;
		if (!boundaryAt(lower, tagStart)) {
			opener.lastIndex = open.index + 1;
			continue;
		}
		const gt = lower.indexOf(">", tagStart);
		if (gt < 0) return undefined;
		// A later opener before this `>` reads a tail of the same text, so it cannot match either.
		if (attribute.test(lower.slice(tagStart, gt))) return page.slice(open.index, gt + 1);
		opener.lastIndex = gt;
	}
	return undefined;
}

/** A quoted value's end, as `(.*?)\1` finds it: the same quote, before any line break. */
function quotedValueEnd(lower: string, quote: string, valueStart: number): number {
	const run = quote === '"' ? /[^"\n\r\u2028\u2029]*/y : /[^'\n\r\u2028\u2029]*/y;
	run.lastIndex = valueStart;
	run.exec(lower);
	return lower.charAt(run.lastIndex) === quote ? run.lastIndex : -1;
}

function attrValue(tag: string, attr: string): string | undefined {
	const lower = asciiLower(tag);
	const attribute = new RegExp(`${attr}\\s*=\\s*(["'])`, "g");
	for (const found of lower.matchAll(attribute)) {
		const valueStart = found.index + found[0].length;
		const valueEnd = quotedValueEnd(lower, found[1] ?? '"', valueStart);
		if (valueEnd < 0) continue;
		const value = tag.slice(valueStart, valueEnd);
		return value ? decodeEntities(value.trim()) : undefined;
	}
	return undefined;
}

function absolutizeUrl(href: string, baseUrl: string): string {
	try {
		return new URL(href, baseUrl).toString();
	} catch {
		return href;
	}
}

const COMMENT_SHAPE: TagPairShape = {
	opener: /<!--/,
	boundary: false,
	toGt: false,
	closer: () => "-->",
	closerToGt: false,
};

/** `<name\b[\s\S]*?<\/name\b[^>]*>` */
function boilerplateTag(name: string): TagPairShape {
	return { opener: new RegExp(`<${name}`), boundary: true, toGt: false, closer: () => `</${name}`, closerToGt: true };
}

const BOILERPLATE_SHAPES: readonly TagPairShape[] = [
	COMMENT_SHAPE,
	...["script", "style", "noscript", "template", "svg", "canvas", "iframe", "form"].map(boilerplateTag),
];

function removeBoilerplate(html: string): string {
	let out = html;
	for (const shape of BOILERPLATE_SHAPES) out = replaceTagPairs(out, shape, () => " ");
	return out;
}

/**
 * Element tags whose id or class names main content, with their contents, as
 * `<div\b[^>]*(?:id|class)=["'][^"']*(?:WORD)[^"']*["'][^>]*>([\s\S]*?)<\/div>`
 * matches them. The greedy `[^>]*` tries the rightmost such attribute first, and
 * its quoted value may run past the tag's first `>`.
 */
function contentDivs(page: string): string[] {
	const lower = asciiLower(page);
	const nextGt = gtFinder(lower);
	const nextClose = occurrences(lower, "</div>");
	const contents: string[] = [];
	const opener = /<div/g;
	for (let open = opener.exec(lower); open !== null; open = opener.exec(lower)) {
		const tagStart = open.index + open[0].length;
		if (!boundaryAt(lower, tagStart)) {
			opener.lastIndex = open.index + 1;
			continue;
		}
		const gt = nextGt(tagStart);
		if (gt < 0) break;
		const attributes = Array.from(lower.slice(tagStart, gt).matchAll(/(?:id|class)=["']/g));
		let matched = false;
		for (let index = attributes.length - 1; index >= 0 && !matched; index--) {
			const found = attributes[index];
			if (found === undefined) continue;
			const valueStart = tagStart + found.index + found[0].length;
			const quoteRun = /[^"']*/y;
			quoteRun.lastIndex = valueStart;
			quoteRun.exec(lower);
			const valueEnd = quoteRun.lastIndex;
			if (valueEnd >= lower.length) continue;
			if (!/content|main|post|article|entry|docs|markdown/.test(lower.slice(valueStart, valueEnd))) continue;
			const tagEnd = valueEnd < gt ? gt : nextGt(valueEnd + 1);
			if (tagEnd < 0) continue;
			const close = nextClose(tagEnd + 1);
			if (close < 0) continue;
			contents.push(page.slice(tagEnd + 1, close));
			opener.lastIndex = close + "</div>".length;
			matched = true;
		}
		// What decides a match is the attribute's place, and a later opener before
		// this `>` sees only some of the same attributes.
		if (!matched) opener.lastIndex = gt;
	}
	return contents;
}

function scoreContent(fragment: string): number {
	const text = stripTags(fragment);
	const links = (fragment.match(/<a\b/gi) ?? []).length;
	const paragraphs = (fragment.match(/<p\b|<li\b|<h[1-6]\b/gi) ?? []).length;
	return text.length + paragraphs * 80 - links * 20;
}

function extractMainHtml(html: string): string {
	const cleaned = removeBoilerplate(html);
	const lower = asciiLower(cleaned);
	const candidates: string[] = [];
	for (const shape of [pairedTag("main"), pairedTag("article")]) {
		for (const pair of tagPairs(lower, shape)) {
			if (pair.contentEnd > pair.contentStart) candidates.push(cleaned.slice(pair.contentStart, pair.contentEnd));
		}
	}
	for (const content of contentDivs(cleaned)) if (content) candidates.push(content);
	if (candidates.length === 0) return firstTagContent(cleaned, pairedTag("body")) ?? cleaned;
	return candidates.sort((a, b) => scoreContent(b) - scoreContent(a))[0] ?? cleaned;
}

/**
 * Links, as `<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>` replaces
 * them: the rightmost href before the tag's first `>` that closes is tried first.
 */
function replaceLinks(page: string, replace: (href: string, text: string) => string): string {
	const lower = asciiLower(page);
	const nextGt = gtFinder(lower);
	const nextClose = occurrences(lower, "</a>");
	const opener = /<a/g;
	let out = "";
	let last = 0;
	for (let open = opener.exec(lower); open !== null; open = opener.exec(lower)) {
		const tagStart = open.index + open[0].length;
		if (!boundaryAt(lower, tagStart)) {
			opener.lastIndex = open.index + 1;
			continue;
		}
		const gt = nextGt(tagStart);
		if (gt < 0) break;
		const hrefs = Array.from(lower.slice(tagStart, gt).matchAll(/href\s*=\s*(["'])/g));
		let matched = false;
		for (let index = hrefs.length - 1; index >= 0 && !matched; index--) {
			const found = hrefs[index];
			if (found === undefined) continue;
			const valueStart = tagStart + found.index + found[0].length;
			const valueEnd = quotedValueEnd(lower, found[1] ?? '"', valueStart);
			if (valueEnd < 0) continue;
			const tagEnd = valueEnd < gt ? gt : nextGt(valueEnd + 1);
			if (tagEnd < 0) continue;
			const close = nextClose(tagEnd + 1);
			if (close < 0) continue;
			out += page.slice(last, open.index) + replace(page.slice(valueStart, valueEnd), page.slice(tagEnd + 1, close));
			last = close + "</a>".length;
			opener.lastIndex = last;
			matched = true;
		}
		if (!matched) opener.lastIndex = gt;
	}
	return last === 0 ? page : out + page.slice(last);
}

const HEADING_SHAPE: TagPairShape = {
	opener: /<h([1-6])/,
	boundary: true,
	toGt: true,
	closer: (level) => `</h${level}>`,
	closerToGt: false,
};

function htmlToMarkdown(html: string, baseUrl: string): string {
	let out = html;
	const codeBlocks: string[] = [];
	out = replaceTagPairs(out, pairedTag("pre"), (code: string) => {
		const placeholder = `\n\n@@CLIO_CODE_${codeBlocks.length}@@\n\n`;
		codeBlocks.push(`\n\n\`\`\`\n${stripCodeTags(code).replace(/^\n+|\n+$/g, "")}\n\`\`\`\n\n`);
		return placeholder;
	});
	out = out.replace(/<br\s*\/?>/gi, "\n");
	{
		// The level is needed per match, so the shared scan runs here with the original text at hand.
		const lower = asciiLower(out);
		let rebuilt = "";
		let last = 0;
		for (const pair of tagPairs(lower, HEADING_SHAPE)) {
			const level = Number(lower.charAt(pair.start + 2));
			rebuilt += `${out.slice(last, pair.start)}\n\n${"#".repeat(level)} ${stripTags(out.slice(pair.contentStart, pair.contentEnd))}\n\n`;
			last = pair.end;
		}
		if (last > 0) out = rebuilt + out.slice(last);
	}
	out = replaceTagPairs(out, pairedTag("blockquote"), (text: string) => `\n\n> ${stripTags(text)}\n\n`);
	out = replaceTagPairs(out, pairedTag("li"), (text: string) => `\n- ${stripTags(text)}`);
	out = replaceLinks(out, (href: string, text: string) => {
		const label = stripTags(text);
		if (!label) return "";
		const url = absolutizeUrl(decodeEntities(href), baseUrl);
		return label === url ? url : `[${label}](${url})`;
	});
	out = replaceBeforeLastGt(out, /<img\b[^>]*>/gi, (tag: string) => {
		const alt = attrValue(tag, "alt");
		const src = attrValue(tag, "src");
		if (!alt && !src) return " ";
		if (!alt) return " ";
		return src ? `![${alt}](${absolutizeUrl(src, baseUrl)})` : alt;
	});
	out = out.replace(/<\/(p|div|section|article|main|tr|table|ul|ol)>/gi, "\n\n");
	out = out.replace(/<\/(td|th)>/gi, " | ");
	out = replaceBeforeLastGt(out, /<[^>]+>/g, () => " ");
	out = decodeEntities(out);
	// One pass restores every block at the first copy of its placeholder; a replace
	// per block would rescan the page once per block. The replacer is a function
	// because a block is page-derived and may contain $&, $1, ...
	const restored = new Set<number>();
	out = out.replace(/@@CLIO_CODE_(\d+)@@/g, (placeholder: string, digits: string) => {
		const index = Number(digits);
		const block = codeBlocks[index];
		if (block === undefined || restored.has(index) || String(index) !== digits) return placeholder;
		restored.add(index);
		return block;
	});
	return out
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^[ \t]+|[ \t]+$/g, "")
		.trim();
}

function extractWebFetchContent(
	rawText: string,
	contentType: string,
	finalUrl: string,
	format: string,
): ExtractedContent {
	const wantsRaw = format === "raw";
	const isHtml = /\bhtml\b/i.test(contentType) || looksLikeHtml(rawText);
	if (wantsRaw || !isHtml) {
		return { format: wantsRaw ? "raw" : "text", content: rawText.trim() };
	}

	const titleText = firstTagContent(rawText, pairedTag("title"));
	const title = titleText ? stripTags(titleText) : undefined;
	const descriptionTag = firstTagWith(rawText, "meta", /(?:name|property)=["'](?:description|og:description)["']/);
	const canonicalTag = firstTagWith(rawText, "link", /rel=["']canonical["']/);
	const description = descriptionTag ? attrValue(descriptionTag, "content") : undefined;
	const canonical = canonicalTag ? attrValue(canonicalTag, "href") : undefined;
	const extracted: ExtractedContent = {
		format: "markdown",
		content: htmlToMarkdown(extractMainHtml(rawText), finalUrl),
	};
	if (title) extracted.title = title;
	if (description) extracted.description = description;
	if (canonical) extracted.canonical = absolutizeUrl(canonical, finalUrl);
	return extracted;
}

interface ArxivPaper {
	id: string;
	title?: string;
	authors: string[];
	published?: string;
	updated?: string;
	categories: string[];
	abstract?: string;
	alphaxivOverview?: string;
}

function arxivIdFromUrl(url: URL): string | null {
	if (url.hostname === "arxiv.org" || url.hostname === "www.arxiv.org") {
		const match = /^\/(?:abs|pdf|html)\/([^/?#]+?)(?:\.pdf)?$/i.exec(url.pathname);
		return match?.[1]?.replace(/v\d+$/i, "") ?? null;
	}
	if (url.hostname === "alphaxiv.org" || url.hostname === "www.alphaxiv.org") {
		const match = /^\/(?:abs|overview)\/([^/?#]+?)(?:\.md)?$/i.exec(url.pathname);
		return match?.[1]?.replace(/v\d+$/i, "") ?? null;
	}
	if (url.hostname === "ar5iv.labs.arxiv.org") {
		const match = /^\/html\/([^/?#]+)$/i.exec(url.pathname);
		return match?.[1]?.replace(/v\d+$/i, "") ?? null;
	}
	return null;
}

function xmlText(xml: string, tag: string): string | undefined {
	const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
	return match?.[1]
		? decodeEntities(
				match[1]
					.replace(/<[^>]+>/g, " ")
					.replace(/\s+/g, " ")
					.trim(),
			)
		: undefined;
}

function xmlTexts(xml: string, tag: string): string[] {
	const out: string[] = [];
	const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
	for (const match of xml.matchAll(regex)) {
		if (match[1])
			out.push(
				decodeEntities(
					match[1]
						.replace(/<[^>]+>/g, " ")
						.replace(/\s+/g, " ")
						.trim(),
				),
			);
	}
	return out;
}

function arxivCategories(entryXml: string): string[] {
	const categories: string[] = [];
	for (const match of entryXml.matchAll(/<category\b[^>]*term=["']([^"']+)["'][^>]*>/gi)) {
		if (match[1] && !categories.includes(match[1])) categories.push(match[1]);
	}
	return categories;
}

function parseArxivEntry(entry: string, fallbackId: string): ArxivPaper {
	const idUrl = xmlText(entry, "id");
	const parsedId = idUrl ? /\/abs\/([^/?#]+)/i.exec(idUrl)?.[1]?.replace(/v\d+$/i, "") : undefined;
	const paper: ArxivPaper = {
		id: parsedId ?? fallbackId,
		authors: xmlTexts(entry, "name"),
		categories: arxivCategories(entry),
	};
	const title = xmlText(entry, "title");
	const published = xmlText(entry, "published");
	const updated = xmlText(entry, "updated");
	const abstract = xmlText(entry, "summary");
	if (title) paper.title = title;
	if (published) paper.published = published;
	if (updated) paper.updated = updated;
	if (abstract) paper.abstract = abstract;
	return paper;
}

async function fetchArxivPaperSummary(
	paperId: string,
	init: Parameters<typeof fetch>[1],
	maxBytes: number,
	network: WebFetchNetworkDependencies,
): Promise<ToolResult | null> {
	const metadataUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(paperId)}`;
	const response = await fetchWebUrl(metadataUrl, init, network);
	if (response.status < 200 || response.status >= 300) return null;
	const read = await readResponseText(response, Math.min(120_000, maxBytes));
	const entry = /<entry\b[^>]*>([\s\S]*?)<\/entry>/i.exec(read.text)?.[1];
	if (!entry) return null;
	const paper = parseArxivEntry(entry, paperId);

	let alphaxivRead: ReadResult | null = null;
	const alphaUrl = `https://alphaxiv.org/overview/${encodeURIComponent(paperId)}.md`;
	try {
		const alpha = await fetchWebUrl(alphaUrl, init, network);
		if (alpha.status >= 200 && alpha.status < 300) {
			alphaxivRead = await readResponseText(alpha, Math.min(80_000, Math.max(0, maxBytes - read.bytesRead)));
			if (alphaxivRead.text.trim().length > 0) paper.alphaxivOverview = alphaxivRead.text.trim();
		}
	} catch (error) {
		if (init?.signal?.aborted) throw error;
		// AlphaXiv is opportunistic; arXiv metadata is the source of truth.
	}

	const lines = [
		`URL: https://arxiv.org/abs/${paper.id}`,
		"Status: 200",
		"Format: arxiv-paper",
		`Paper ID: ${paper.id}`,
	];
	if (paper.title) lines.push(`Title: ${paper.title}`);
	if (paper.authors.length > 0) lines.push(`Authors: ${paper.authors.join(", ")}`);
	if (paper.published) lines.push(`Published: ${paper.published}`);
	if (paper.updated) lines.push(`Updated: ${paper.updated}`);
	if (paper.categories.length > 0) lines.push(`Categories: ${paper.categories.join(", ")}`);
	lines.push(
		"Links:",
		`- arXiv: https://arxiv.org/abs/${paper.id}`,
		`- PDF: https://arxiv.org/pdf/${paper.id}`,
		`- AlphaXiv: https://alphaxiv.org/abs/${paper.id}`,
		`- ar5iv HTML: https://ar5iv.labs.arxiv.org/html/${paper.id}`,
	);
	if (paper.abstract) lines.push("", "Abstract:", paper.abstract);
	if (paper.alphaxivOverview) lines.push("", "AlphaXiv overview:", paper.alphaxivOverview);
	const bytesRead = read.bytesRead + (alphaxivRead?.bytesRead ?? 0);
	const formatted = capOutput(`${UNTRUSTED_CONTENT_BANNER}\n${lines.join("\n")}`, maxBytes);
	return {
		kind: "ok",
		output: formatted.output,
		details: {
			url: `https://arxiv.org/abs/${paper.id}`,
			status: 200,
			contentType: "application/atom+xml",
			format: "arxiv-paper",
			bytesRead,
			truncated: read.truncated || (alphaxivRead?.truncated ?? false) || formatted.truncated,
		},
	};
}

function arxivApiUrl(url: URL): boolean {
	return url.hostname === "export.arxiv.org" && url.pathname === "/api/query";
}

async function fetchArxivApiSummary(
	url: URL,
	init: Parameters<typeof fetch>[1],
	maxBytes: number,
	network: WebFetchNetworkDependencies,
): Promise<ToolResult | null> {
	const response = await fetchWebUrl(url, init, network);
	if (response.status < 200 || response.status >= 300) return null;
	const read = await readResponseText(response, Math.min(240_000, maxBytes));
	const entries = Array.from(read.text.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi))
		.map((match, index) => (match[1] ? parseArxivEntry(match[1], `entry-${index + 1}`) : null))
		.filter((entry): entry is ArxivPaper => entry !== null);
	if (entries.length === 0) return null;
	const total = xmlText(read.text, "opensearch:totalResults") ?? String(entries.length);
	const query = url.searchParams.get("search_query") ?? url.searchParams.get("id_list") ?? "arxiv query";
	const lines = [
		`URL: ${url.toString()}`,
		"Status: 200",
		"Format: arxiv-search-results",
		`Query: ${query}`,
		`Returned: ${entries.length}`,
		`Total results: ${total}`,
		"",
		"Papers:",
	];
	let truncated = read.truncated;
	for (const [index, paper] of entries.entries()) {
		lines.push("", `## ${index + 1}. ${paper.title ?? paper.id}`);
		lines.push(`Paper ID: ${paper.id}`);
		if (paper.authors.length > 0)
			lines.push(`Authors: ${paper.authors.slice(0, 8).join(", ")}${paper.authors.length > 8 ? ", et al." : ""}`);
		if (paper.published) lines.push(`Published: ${paper.published}`);
		if (paper.updated) lines.push(`Updated: ${paper.updated}`);
		if (paper.categories.length > 0) lines.push(`Categories: ${paper.categories.join(", ")}`);
		lines.push(`Links: https://arxiv.org/abs/${paper.id} | https://arxiv.org/pdf/${paper.id}`);
		if (paper.abstract) {
			const abstract = capOutput(paper.abstract, 1600);
			lines.push("Abstract:", abstract.output);
			truncated ||= abstract.truncated;
		}
	}
	const formatted = capOutput(`${UNTRUSTED_CONTENT_BANNER}\n${lines.join("\n")}`, maxBytes);
	return {
		kind: "ok",
		output: formatted.output,
		details: {
			url: url.toString(),
			status: 200,
			contentType: "application/atom+xml",
			format: "arxiv-search-results",
			bytesRead: read.bytesRead,
			truncated: truncated || formatted.truncated,
		},
	};
}

interface RepoTreeTarget {
	kind: "github" | "gitlab";
	apiUrl: string;
	rawBaseUrl: string;
	label: string;
}

function repoTreeTarget(url: URL): RepoTreeTarget | null {
	const parts = url.pathname.split("/").filter(Boolean);
	if (url.hostname === "github.com" && parts.length >= 5 && parts[2] === "tree") {
		const [owner, repo, , branch, ...pathParts] = parts;
		const pathPart = pathParts.join("/");
		return {
			kind: "github",
			apiUrl: `https://api.github.com/repos/${owner}/${repo}/contents/${pathPart}?ref=${branch}`,
			rawBaseUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${pathPart}`.replace(/\/$/, ""),
			label: `${owner}/${repo}/${pathPart}`,
		};
	}
	if (url.hostname.includes("gitlab") && parts.length >= 5) {
		const treeIndex = parts.findIndex((part, index) => part === "tree" && parts[index - 1] === "-");
		if (treeIndex >= 2) {
			const project = parts.slice(0, treeIndex - 1).join("/");
			const branch = parts[treeIndex + 1];
			if (!branch) return null;
			const pathPart = parts.slice(treeIndex + 2).join("/");
			const encodedProject = encodeURIComponent(project);
			return {
				kind: "gitlab",
				apiUrl: `${url.origin}/api/v4/projects/${encodedProject}/repository/tree?path=${encodeURIComponent(pathPart)}&ref=${encodeURIComponent(branch)}&per_page=100`,
				rawBaseUrl: `${url.origin}/${project}/-/raw/${branch}/${pathPart}`.replace(/\/$/, ""),
				label: `${project}/${pathPart}`,
			};
		}
	}
	return null;
}

function repoEntryName(entry: unknown): string | null {
	if (!entry || typeof entry !== "object") return null;
	const record = entry as Record<string, unknown>;
	return typeof record.name === "string" ? record.name : null;
}

function repoEntryIsFile(entry: unknown): boolean {
	if (!entry || typeof entry !== "object") return false;
	const record = entry as Record<string, unknown>;
	return record.type === "file" || record.type === "blob";
}

function importantRepoFiles(entries: unknown[]): string[] {
	const priority = [/^README\.md$/i, /^SKILL\.md$/i, /^INSTALL\.md$/i, /^VERIFY\.md$/i, /\.md$/i];
	const names = entries
		.filter(repoEntryIsFile)
		.map(repoEntryName)
		.filter((name): name is string => name !== null);
	const selected: string[] = [];
	for (const pattern of priority) {
		for (const name of names) {
			if (selected.includes(name) || !pattern.test(name)) continue;
			selected.push(name);
			if (selected.length >= 6) return selected;
		}
	}
	return selected;
}

async function fetchRepoTreeSummary(
	target: RepoTreeTarget,
	init: Parameters<typeof fetch>[1],
	maxBytes: number,
	network: WebFetchNetworkDependencies,
): Promise<ToolResult | null> {
	const apiResponse = await fetchWebUrl(target.apiUrl, init, network);
	if (apiResponse.status < 200 || apiResponse.status >= 300) return null;
	const apiRead = await readResponseText(apiResponse, Math.min(200_000, maxBytes));
	let entries: unknown[];
	try {
		const parsed = JSON.parse(apiRead.text) as unknown;
		entries = Array.isArray(parsed) ? parsed : [];
	} catch {
		return null;
	}
	const files = importantRepoFiles(entries);
	const allNames = entries
		.map(repoEntryName)
		.filter((name): name is string => name !== null)
		.slice(0, 60);
	const sections = [
		`URL: ${target.apiUrl}`,
		"Status: 200",
		`Format: repository-${target.kind}-tree-summary`,
		`Repository path: ${target.label}`,
		"",
		"Directory entries:",
		...allNames.map((name) => `- ${name}`),
	];
	let remaining = maxBytes - Buffer.byteLength(sections.join("\n"));
	let truncated = apiRead.truncated;
	for (const file of files) {
		if (remaining <= 2000) break;
		const rawUrl = `${target.rawBaseUrl}/${file}`;
		const rawResponse = await fetchWebUrl(rawUrl, init, network);
		if (rawResponse.status < 200 || rawResponse.status >= 300) continue;
		const rawRead = await readResponseText(rawResponse, Math.min(80_000, remaining));
		truncated ||= rawRead.truncated;
		sections.push("", `--- ${file} ---`, rawRead.text.trim());
		remaining -= Buffer.byteLength(rawRead.text);
	}
	const formatted = capOutput(`${UNTRUSTED_CONTENT_BANNER}\n${sections.join("\n")}`, maxBytes);
	return {
		kind: "ok",
		output: formatted.output,
		details: {
			url: target.apiUrl,
			status: 200,
			contentType: "application/json",
			format: `repository-${target.kind}-tree-summary`,
			bytesRead: apiRead.bytesRead,
			truncated: truncated || formatted.truncated,
		},
	};
}

function formatOutput(args: {
	url: string;
	status: number;
	contentType: string;
	bytesRead: number;
	truncated: boolean;
	extracted: ExtractedContent;
	maxBytes: number;
}): { output: string; truncated: boolean } {
	const lines = [
		`URL: ${args.url}`,
		`Status: ${args.status}`,
		`Content-Type: ${args.contentType || "unknown"}`,
		`Format: ${args.extracted.format}`,
		`Bytes read: ${args.bytesRead}${args.truncated ? " (truncated)" : ""}`,
	];
	if (args.extracted.title) lines.push(`Title: ${args.extracted.title}`);
	if (args.extracted.description) lines.push(`Description: ${args.extracted.description}`);
	if (args.extracted.canonical) lines.push(`Canonical: ${args.extracted.canonical}`);
	lines.push("", "Content:", args.extracted.content || "[empty]");
	return capOutput(`${UNTRUSTED_CONTENT_BANNER}\n${lines.join("\n")}`, args.maxBytes);
}

export const webFetchTool: ToolSpec = {
	...webFetchToolSurface,
	async run(args, options): Promise<ToolResult> {
		const urlArg = typeof args.url === "string" ? args.url : null;
		if (!urlArg) return { kind: "error", message: "web_fetch: missing url argument" };

		let parsed: URL;
		try {
			parsed = new URL(urlArg);
		} catch {
			return { kind: "error", message: `web_fetch: invalid url: ${urlArg}` };
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return { kind: "error", message: `web_fetch: unsupported scheme ${parsed.protocol} (must be http or https)` };
		}

		const method = typeof args.method === "string" && args.method.length > 0 ? args.method.toUpperCase() : "GET";
		const userHeaders = parseHeaders(args.headers);
		if (userHeaders === null) {
			return { kind: "error", message: "web_fetch: headers must be a Record<string,string>" };
		}
		const headers = { ...DEFAULT_HEADERS, ...userHeaders };
		const hasBody = typeof args.body === "string";
		const body = hasBody ? (args.body as string) : undefined;
		// A delay past 2^31-1 ms makes setTimeout fire after 1 ms, so a huge timeout_ms is clamped.
		const timeoutMs =
			typeof args.timeout_ms === "number" && args.timeout_ms > 0
				? Math.min(Math.floor(args.timeout_ms), MAX_TIMEOUT_MS)
				: DEFAULT_TIMEOUT_MS;
		const requestedMaxBytes =
			typeof args.max_bytes === "number" && args.max_bytes > 0 ? args.max_bytes : DEFAULT_MAX_BYTES;
		const maxBytes = Math.min(Math.floor(requestedMaxBytes), HARD_MAX_BYTES);
		const format = typeof args.format === "string" ? args.format.toLowerCase() : "auto";
		if (!["auto", "markdown", "raw"].includes(format)) {
			return { kind: "error", message: "web_fetch: format must be one of auto, markdown, raw" };
		}

		const externalSignal = options?.signal;
		const controller = new AbortController();
		let externalAborted = false;
		let timedOut = false;

		const onExternalAbort = (): void => {
			externalAborted = true;
			controller.abort();
		};

		if (externalSignal?.aborted) {
			onExternalAbort();
		} else {
			externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
		}

		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);

		try {
			const init: Parameters<typeof fetch>[1] = {
				method,
				headers,
				signal: controller.signal,
				redirect: "manual",
			};
			if (body !== undefined) init.body = body;
			// Every hop, helper URLs included, is judged by the session's
			// information-flow restrictions when the registry supplied the check.
			const network: WebFetchNetworkDependencies = {
				...(options?.flowAdmitsUrl !== undefined
					? {
							admitHop: (hopUrl: URL) => {
								const admits = options.flowAdmitsUrl;
								return admits === undefined ? null : admits(hopUrl.toString());
							},
						}
					: {}),
			};
			if (method === "GET" && body === undefined && format !== "raw" && Object.keys(userHeaders).length === 0) {
				if (arxivApiUrl(parsed)) {
					const arxivApiSummary = await fetchArxivApiSummary(parsed, init, maxBytes, network);
					if (arxivApiSummary) return arxivApiSummary;
				}
				const arxivId = arxivIdFromUrl(parsed);
				if (arxivId) {
					const arxivSummary = await fetchArxivPaperSummary(arxivId, init, maxBytes, network);
					if (arxivSummary) return arxivSummary;
				}
				const repoTarget = repoTreeTarget(parsed);
				if (repoTarget) {
					const repoSummary = await fetchRepoTreeSummary(repoTarget, init, maxBytes, network);
					if (repoSummary) return repoSummary;
				}
			}
			const response = await fetchWebUrl(parsed, init, network);
			const contentType = headerValue(response, "content-type");
			const readLimit =
				response.status >= 200 && response.status < 300 ? maxBytes : Math.min(ERROR_PREVIEW_BYTES, maxBytes);
			const read = await readResponseText(response, readLimit);
			if (response.status < 200 || response.status >= 300) {
				const preview = extractWebFetchContent(read.text, contentType, response.url || parsed.toString(), "auto").content;
				return {
					kind: "error",
					// The status text is the server's, so it follows the banner with the preview.
					message: `web_fetch: HTTP ${response.status}\n${UNTRUSTED_CONTENT_BANNER}\nStatus text: ${truncate(neutralizeFraming(response.statusText), 200)}${preview ? `\nPreview:\n${truncate(neutralizeFraming(preview), ERROR_PREVIEW_BYTES)}` : ""}`,
				};
			}
			if (isProbablyBinary(contentType, read.text)) {
				return {
					kind: "error",
					message: `web_fetch: binary or unsupported content type\n${UNTRUSTED_CONTENT_BANNER}\nContent-Type: ${truncate(neutralizeFraming(contentType || "unknown"), 200)}`,
				};
			}
			const finalUrl = response.url || parsed.toString();
			const extracted = extractWebFetchContent(read.text, contentType, finalUrl, format);
			const formatted = formatOutput({
				url: finalUrl,
				status: response.status,
				contentType,
				bytesRead: read.bytesRead,
				truncated: read.truncated,
				extracted,
				maxBytes,
			});
			return {
				kind: "ok",
				output: formatted.output,
				details: {
					url: finalUrl,
					status: response.status,
					contentType,
					format: extracted.format,
					bytesRead: read.bytesRead,
					truncated: read.truncated || formatted.truncated,
				},
			};
		} catch (err) {
			if (externalAborted) {
				return { kind: "error", message: "web_fetch: request aborted" };
			}
			if (timedOut) {
				return { kind: "error", message: `web_fetch: timeout after ${timeoutMs}ms` };
			}
			if (err instanceof Error && err.name === "AbortError") {
				return { kind: "error", message: "web_fetch: request aborted" };
			}
			const errors: unknown[] = err instanceof AggregateError ? err.errors : [err];
			const msg = errors.map((error) => (error instanceof Error ? error.message || error.name : String(error))).join("; ");
			return { kind: "error", message: `web_fetch: ${msg || "request failed"}` };
		} finally {
			clearTimeout(timer);
			externalSignal?.removeEventListener("abort", onExternalAbort);
		}
	},
};

/** The GET-only arguments web_read forwards; method, headers, and body cannot reach the request. */
const WEB_READ_ARGUMENT_KEYS = ["url", "timeout_ms", "max_bytes", "format"] as const;

/**
 * web_read is web_fetch with the request shape fixed to a plain GET. One
 * implementation: the arguments are projected onto the read-only subset and
 * the same fetch, summaries, binary refusal, private-network gate, and byte
 * caps apply. Only the message prefix changes, so an error names the tool
 * that was called.
 */
export const webReadTool: ToolSpec = {
	...webReadToolSurface,
	async run(args, options): Promise<ToolResult> {
		const projected: Record<string, unknown> = {};
		for (const key of WEB_READ_ARGUMENT_KEYS) {
			if (args[key] !== undefined) projected[key] = args[key];
		}
		const result = await webFetchTool.run(projected, options);
		if (result.kind === "error") {
			return { ...result, message: result.message.replace(/^web_fetch:/u, "web_read:") };
		}
		return result;
	},
};
