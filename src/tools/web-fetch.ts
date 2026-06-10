import { Type } from "typebox";
import { fetch } from "undici";
import { ToolNames } from "../core/tool-names.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { truncateUtf8 } from "./truncate-utf8.js";

const DEFAULT_TIMEOUT_MS = 30_000;
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

function decodeUtf8Prefix(bytes: Buffer, maxBytes: number): string {
	let cut = Math.min(maxBytes, bytes.byteLength);
	while (cut > 0) {
		const nextByte = bytes[cut];
		if (nextByte === undefined || (nextByte & 0xc0) !== 0x80) break;
		cut -= 1;
	}
	return bytes.subarray(0, cut).toString("utf8");
}

async function readResponseText(response: Response, maxBytes: number): Promise<ReadResult> {
	if (!response.body) return { text: "", bytesRead: 0, truncated: false };
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
			text: `${decodeUtf8Prefix(bytes, maxBytes)}${TRUNCATION_MARKER}`,
			bytesRead: bytes.byteLength,
			truncated: true,
		};
	}
	return { text: bytes.toString("utf8"), bytesRead: bytes.byteLength, truncated: false };
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

function decodeEntities(value: string): string {
	return value
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'");
}

function stripTags(value: string): string {
	return decodeEntities(
		value
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim(),
	);
}

function firstMatch(html: string, regex: RegExp): string | undefined {
	const match = regex.exec(html);
	return match?.[1] ? stripTags(match[1]) : undefined;
}

function attrValue(tag: string, attr: string): string | undefined {
	const regex = new RegExp(`${attr}\\s*=\\s*(["'])(.*?)\\1`, "i");
	const match = regex.exec(tag);
	return match?.[2] ? decodeEntities(match[2].trim()) : undefined;
}

function absolutizeUrl(href: string, baseUrl: string): string {
	try {
		return new URL(href, baseUrl).toString();
	} catch {
		return href;
	}
}

function removeBoilerplate(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<template\b[\s\S]*?<\/template>/gi, " ")
		.replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
		.replace(/<canvas\b[\s\S]*?<\/canvas>/gi, " ")
		.replace(/<iframe\b[\s\S]*?<\/iframe>/gi, " ")
		.replace(/<form\b[\s\S]*?<\/form>/gi, " ");
}

function scoreContent(fragment: string): number {
	const text = stripTags(fragment);
	const links = (fragment.match(/<a\b/gi) ?? []).length;
	const paragraphs = (fragment.match(/<p\b|<li\b|<h[1-6]\b/gi) ?? []).length;
	return text.length + paragraphs * 80 - links * 20;
}

function extractMainHtml(html: string): string {
	const cleaned = removeBoilerplate(html);
	const candidates: string[] = [];
	for (const regex of [
		/<main\b[^>]*>([\s\S]*?)<\/main>/gi,
		/<article\b[^>]*>([\s\S]*?)<\/article>/gi,
		/<div\b[^>]*(?:id|class)=["'][^"']*(?:content|main|post|article|entry|docs|markdown)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
	]) {
		for (const match of cleaned.matchAll(regex)) {
			if (match[1]) candidates.push(match[1]);
		}
	}
	if (candidates.length === 0) {
		return firstMatch(cleaned, /<body\b[^>]*>([\s\S]*?)<\/body>/i)
			? (/<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(cleaned)?.[1] ?? cleaned)
			: cleaned;
	}
	return candidates.sort((a, b) => scoreContent(b) - scoreContent(a))[0] ?? cleaned;
}

function htmlToMarkdown(html: string, baseUrl: string): string {
	let out = html;
	const codeBlocks: string[] = [];
	out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => {
		const placeholder = `\n\n@@CLIO_CODE_${codeBlocks.length}@@\n\n`;
		codeBlocks.push(`\n\n\`\`\`\n${stripTags(code).replace(/^\n+|\n+$/g, "")}\n\`\`\`\n\n`);
		return placeholder;
	});
	out = out.replace(/<br\s*\/?>/gi, "\n");
	out = out.replace(
		/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
		(_, level: string, text: string) => `\n\n${"#".repeat(Number(level))} ${stripTags(text)}\n\n`,
	);
	out = out.replace(
		/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi,
		(_, text: string) => `\n\n> ${stripTags(text)}\n\n`,
	);
	out = out.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, text: string) => `\n- ${stripTags(text)}`);
	out = out.replace(
		/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
		(_, _q: string, href: string, text: string) => {
			const label = stripTags(text);
			if (!label) return "";
			const url = absolutizeUrl(decodeEntities(href), baseUrl);
			return label === url ? url : `[${label}](${url})`;
		},
	);
	out = out.replace(/<img\b[^>]*>/gi, (tag: string) => {
		const alt = attrValue(tag, "alt");
		const src = attrValue(tag, "src");
		if (!alt && !src) return " ";
		if (!alt) return " ";
		return src ? `![${alt}](${absolutizeUrl(src, baseUrl)})` : alt;
	});
	out = out.replace(/<\/(p|div|section|article|main|tr|table|ul|ol)>/gi, "\n\n");
	out = out.replace(/<\/(td|th)>/gi, " | ");
	out = out.replace(/<[^>]+>/g, " ");
	out = decodeEntities(out);
	for (const [index, block] of codeBlocks.entries()) {
		out = out.replace(`@@CLIO_CODE_${index}@@`, block);
	}
	return out
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^[ \t]+|[ \t]+$/g, "")
		.trim();
}

export function extractWebFetchContent(
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

	const title = firstMatch(rawText, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
	const descriptionTag = /<meta\b[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*>/i.exec(
		rawText,
	)?.[0];
	const canonicalTag = /<link\b[^>]*rel=["']canonical["'][^>]*>/i.exec(rawText)?.[0];
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
): Promise<ToolResult | null> {
	const metadataUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(paperId)}`;
	const response = await fetch(metadataUrl, init);
	if (response.status < 200 || response.status >= 300) return null;
	const read = await readResponseText(response, Math.min(120_000, maxBytes));
	const entry = /<entry\b[^>]*>([\s\S]*?)<\/entry>/i.exec(read.text)?.[1];
	if (!entry) return null;
	const paper = parseArxivEntry(entry, paperId);

	let alphaxivRead: ReadResult | null = null;
	const alphaUrl = `https://alphaxiv.org/overview/${encodeURIComponent(paperId)}.md`;
	try {
		const alpha = await fetch(alphaUrl, init);
		if (alpha.status >= 200 && alpha.status < 300) {
			alphaxivRead = await readResponseText(alpha, Math.min(80_000, Math.max(0, maxBytes - read.bytesRead)));
			if (alphaxivRead.text.trim().length > 0) paper.alphaxivOverview = alphaxivRead.text.trim();
		}
	} catch {
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
	return {
		kind: "ok",
		output: truncate(lines.join("\n"), maxBytes),
		details: {
			url: `https://arxiv.org/abs/${paper.id}`,
			status: 200,
			contentType: "application/atom+xml",
			format: "arxiv-paper",
			bytesRead,
			truncated: read.truncated || (alphaxivRead?.truncated ?? false),
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
): Promise<ToolResult | null> {
	const response = await fetch(url, init);
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
	for (const [index, paper] of entries.entries()) {
		lines.push("", `## ${index + 1}. ${paper.title ?? paper.id}`);
		lines.push(`Paper ID: ${paper.id}`);
		if (paper.authors.length > 0)
			lines.push(`Authors: ${paper.authors.slice(0, 8).join(", ")}${paper.authors.length > 8 ? ", et al." : ""}`);
		if (paper.published) lines.push(`Published: ${paper.published}`);
		if (paper.updated) lines.push(`Updated: ${paper.updated}`);
		if (paper.categories.length > 0) lines.push(`Categories: ${paper.categories.join(", ")}`);
		lines.push(`Links: https://arxiv.org/abs/${paper.id} | https://arxiv.org/pdf/${paper.id}`);
		if (paper.abstract) lines.push("Abstract:", truncate(paper.abstract, 1600));
	}
	return {
		kind: "ok",
		output: truncate(lines.join("\n"), maxBytes),
		details: {
			url: url.toString(),
			status: 200,
			contentType: "application/atom+xml",
			format: "arxiv-search-results",
			bytesRead: read.bytesRead,
			truncated: read.truncated,
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
): Promise<ToolResult | null> {
	const apiResponse = await fetch(target.apiUrl, init);
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
	for (const file of files) {
		if (remaining <= 2000) break;
		const rawUrl = `${target.rawBaseUrl}/${file}`;
		const rawResponse = await fetch(rawUrl, init);
		if (rawResponse.status < 200 || rawResponse.status >= 300) continue;
		const rawRead = await readResponseText(rawResponse, Math.min(80_000, remaining));
		sections.push("", `--- ${file} ---`, rawRead.text.trim());
		remaining -= Buffer.byteLength(rawRead.text);
	}
	return {
		kind: "ok",
		output: truncate(sections.join("\n"), maxBytes),
		details: {
			url: target.apiUrl,
			status: 200,
			contentType: "application/json",
			format: `repository-${target.kind}-tree-summary`,
			bytesRead: apiRead.bytesRead,
			truncated: apiRead.truncated,
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
}): string {
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
	return truncate(lines.join("\n"), args.maxBytes);
}

export const webFetchTool: ToolSpec = {
	name: ToolNames.WebFetch,
	description:
		"Fetch a URL over HTTP(S) and return token-efficient content. HTML is cleaned, boilerplate/script/style removed, main content converted to Markdown, and metadata included. Non-2xx is an error with a short body preview. Body is truncated at max_bytes (default 600 KB).",
	parameters: Type.Object({
		url: Type.String({ description: "Fully-qualified http:// or https:// URL." }),
		method: Type.Optional(Type.String({ description: "HTTP method. Defaults to GET. Case-insensitive." })),
		headers: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description: "Request headers as a string→string map. Browser-like defaults are supplied unless overridden.",
			}),
		),
		body: Type.Optional(Type.String({ description: "Request body as a UTF-8 string (used with POST/PUT/etc.)." })),
		timeout_ms: Type.Optional(Type.Number({ description: "Abort after this many milliseconds. Defaults to 30000." })),
		max_bytes: Type.Optional(
			Type.Number({
				description: "Maximum bytes to read and return after extraction. Defaults to 600000; hard-capped at 5000000.",
			}),
		),
		format: Type.Optional(
			Type.String({
				description: "Output mode: auto (default, HTML→Markdown), markdown (same as auto for HTML), or raw.",
			}),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
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
		const timeoutMs = typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
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
				redirect: "follow",
			};
			if (body !== undefined) init.body = body;
			if (method === "GET" && body === undefined && format !== "raw") {
				if (arxivApiUrl(parsed)) {
					const arxivApiSummary = await fetchArxivApiSummary(parsed, init, maxBytes);
					if (arxivApiSummary) return arxivApiSummary;
				}
				const arxivId = arxivIdFromUrl(parsed);
				if (arxivId) {
					const arxivSummary = await fetchArxivPaperSummary(arxivId, init, maxBytes);
					if (arxivSummary) return arxivSummary;
				}
				const repoTarget = repoTreeTarget(parsed);
				if (repoTarget) {
					const repoSummary = await fetchRepoTreeSummary(repoTarget, init, maxBytes);
					if (repoSummary) return repoSummary;
				}
			}
			const response = await fetch(parsed, init);
			const contentType = headerValue(response, "content-type");
			const readLimit =
				response.status >= 200 && response.status < 300 ? maxBytes : Math.min(ERROR_PREVIEW_BYTES, maxBytes);
			const read = await readResponseText(response, readLimit);
			if (response.status < 200 || response.status >= 300) {
				const preview = extractWebFetchContent(read.text, contentType, response.url || parsed.toString(), "auto").content;
				return {
					kind: "error",
					message: `web_fetch: HTTP ${response.status}: ${response.statusText}${preview ? `\nPreview:\n${truncate(preview, ERROR_PREVIEW_BYTES)}` : ""}`,
				};
			}
			if (isProbablyBinary(contentType, read.text)) {
				return { kind: "error", message: `web_fetch: binary or unsupported content type: ${contentType || "unknown"}` };
			}
			const finalUrl = response.url || parsed.toString();
			const extracted = extractWebFetchContent(read.text, contentType, finalUrl, format);
			return {
				kind: "ok",
				output: formatOutput({
					url: finalUrl,
					status: response.status,
					contentType,
					bytesRead: read.bytesRead,
					truncated: read.truncated,
					extracted,
					maxBytes,
				}),
				details: {
					url: finalUrl,
					status: response.status,
					contentType,
					format: extracted.format,
					bytesRead: read.bytesRead,
					truncated: read.truncated,
				},
			};
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				if (externalAborted) {
					return { kind: "error", message: "web_fetch: request aborted" };
				}
				if (timedOut) {
					return { kind: "error", message: `web_fetch: timeout after ${timeoutMs}ms` };
				}
				return { kind: "error", message: "web_fetch: request aborted" };
			}
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `web_fetch: ${msg}` };
		} finally {
			clearTimeout(timer);
			externalSignal?.removeEventListener("abort", onExternalAbort);
		}
	},
};
