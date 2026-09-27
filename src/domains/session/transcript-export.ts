/**
 * A session transcript as a file a person can read without a terminal.
 *
 * The terminal's `/export` renders through its chat panel and converts the
 * panel's ANSI frame, which a host with no terminal cannot do. This renderer
 * reads the ledger directly: the active branch the session is on (issue #107,
 * #109), each request, reply, tool call and result, compaction summaries and
 * handoff records, in order. Reasoning is summarized as present rather than
 * copied, since it is not part of the answer. Everything is escaped; the HTML
 * carries no script and loads nothing.
 */

import { isAbsolute, join, relative, resolve } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { displayToolCall } from "../../tools/gateway-display.js";
import { expandChainMessages } from "../../tools/surface.js";
import type { MessageEntry, SessionEntry } from "./entries.js";
import { HANDOFF_NOTE_CUSTOM_TYPE, HANDOFF_SEED_CUSTOM_TYPE, isHandoffNoteData, isHandoffSeedData } from "./handoff.js";
import { filterEntriesToActivePath } from "./tree/active-path.js";

const MAX_ARGS_CHARS = 4000;
const MAX_RESULT_CHARS = 8000;

export type TranscriptBlock =
	| { kind: "request"; text: string }
	| { kind: "response"; text: string; reasoning: boolean }
	| { kind: "tool"; name: string; args: string; viaGateway: boolean }
	| { kind: "result"; name: string; text: string; failed: boolean; viaGateway: boolean }
	| { kind: "note"; title: string; text: string };

export interface TranscriptExportInput {
	sessionId: string;
	/** ISO instant, the machine-readable half of when the export ran. */
	exportedAt: string;
	entries: ReadonlyArray<SessionEntry>;
	/** The leaf the session is on; null replays the whole file. */
	leafTurnId: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… ${text.length - max} more characters`;
}

function messageText(entry: MessageEntry): { text: string; reasoning: boolean } {
	const payload = entry.payload;
	if (typeof payload === "string") return { text: payload, reasoning: false };
	if (!isRecord(payload)) return { text: "", reasoning: false };
	if (entry.role === "user" && typeof payload.operatorText === "string")
		return { text: payload.operatorText, reasoning: false };
	let reasoning = false;
	if (Array.isArray(payload.content) && payload.content.length > 0) {
		const parts: string[] = [];
		for (const block of payload.content) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
			if (block.type === "thinking") reasoning = true;
		}
		return { text: parts.join("\n\n"), reasoning };
	}
	return { text: typeof payload.text === "string" ? payload.text : "", reasoning };
}

function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (isRecord(result) && Array.isArray(result.content)) {
		return result.content
			.flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
			.join("\n");
	}
	if (isRecord(result) && typeof result.output === "string") return result.output;
	return result === undefined ? "" : JSON.stringify(result, null, 2);
}

/**
 * The branch the session is on, as blocks a renderer lays out. A gateway
 * op=call reads as the capability it ran, marked as reached through the
 * gateway, and a chain's settled steps follow its aggregate result as their own
 * call and result. The ledger keeps the wire record; only the reading changes.
 */
function transcriptBlocks(input: TranscriptExportInput): { blocks: TranscriptBlock[]; turns: number } {
	const blocks: TranscriptBlock[] = [];
	let turns = 0;
	// A refused capability's result carries no capability name of its own, so
	// a result takes the name its call was shown under.
	const shownCalls = new Map<string, { name: string; viaGateway: boolean }>();
	const branch = filterEntriesToActivePath(input.entries, input.leafTurnId ?? undefined);
	const recorded = new Set<SessionEntry>(branch);
	for (const entry of expandChainMessages(branch)) {
		if (entry.kind === "compactionSummary") {
			blocks.push({ kind: "note", title: "Earlier turns were compacted", text: entry.summary });
			continue;
		}
		if (entry.kind === "custom") {
			const custom = entry as SessionEntry & { customType?: string; data?: unknown };
			if (custom.customType === HANDOFF_SEED_CUSTOM_TYPE && isHandoffSeedData(custom.data))
				blocks.push({
					kind: "note",
					title: `Handed off from session ${custom.data.fromSessionId}`,
					text: custom.data.document,
				});
			if (custom.customType === HANDOFF_NOTE_CUSTOM_TYPE && isHandoffNoteData(custom.data))
				blocks.push({
					kind: "note",
					title: "Handed off",
					text: `The work continued in session ${custom.data.toSessionId}: ${custom.data.goal}`,
				});
			continue;
		}
		if (entry.kind !== "message") continue;
		const payload = isRecord(entry.payload) ? entry.payload : null;
		if (entry.role === "user") {
			// Middleware continuations are provider context, not the operator's words.
			if (payload?.synthetic === true) continue;
			turns += 1;
			blocks.push({ kind: "request", text: messageText(entry).text });
			continue;
		}
		if (entry.role === "assistant") {
			const { text, reasoning } = messageText(entry);
			if (text.trim().length > 0 || reasoning) blocks.push({ kind: "response", text, reasoning });
			continue;
		}
		const toolCallId = typeof payload?.toolCallId === "string" ? payload.toolCallId : null;
		// An entry the ledger never recorded is a chain step expanded after its aggregate.
		const chainStep = !recorded.has(entry);
		if (entry.role === "tool_call") {
			const wireName =
				typeof payload?.name === "string"
					? payload.name
					: typeof payload?.toolName === "string"
						? payload.toolName
						: "tool";
			const call = displayToolCall(wireName, payload?.args);
			const shown = { name: call.toolName, viaGateway: call.viaGateway || chainStep };
			if (toolCallId !== null) shownCalls.set(toolCallId, shown);
			blocks.push({
				kind: "tool",
				...shown,
				args: clip(JSON.stringify((call.viaGateway ? call.args : payload?.args) ?? {}, null, 2), MAX_ARGS_CHARS),
			});
			continue;
		}
		if (entry.role === "tool_result") {
			const result = isRecord(payload?.result) ? payload.result : undefined;
			const wireName = typeof payload?.toolName === "string" ? payload.toolName : "tool";
			const call = displayToolCall(wireName, undefined, result?.details);
			const shown = (toolCallId === null ? undefined : shownCalls.get(toolCallId)) ?? {
				name: call.toolName,
				viaGateway: call.viaGateway || chainStep,
			};
			const failed = payload?.isError === true || payload?.outcome === "error" || payload?.outcome === "blocked";
			blocks.push({ kind: "result", ...shown, text: clip(resultText(payload?.result), MAX_RESULT_CHARS), failed });
		}
	}
	return { blocks, turns };
}

function longestBacktickRun(text: string): number {
	let longest = 0;
	for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
	return longest;
}

function fenced(text: string, info = ""): string {
	const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
	return `${fence}${info}\n${text}\n${fence}`;
}

function renderTranscriptMarkdown(input: TranscriptExportInput): { text: string; turns: number } {
	const { blocks, turns } = transcriptBlocks(input);
	const lines = [`# Clio Coder session ${input.sessionId}`, "", `Exported ${input.exportedAt}`, ""];
	for (const block of blocks) {
		if (block.kind === "request") lines.push("## Request", "", fenced(block.text, "text"), "");
		if (block.kind === "response") {
			lines.push("## Clio Coder", "");
			if (block.reasoning) lines.push("_Reasoning was reported for this reply and is not included._", "");
			if (block.text.trim().length > 0) lines.push(block.text, "");
		}
		const via = (block.kind === "tool" || block.kind === "result") && block.viaGateway ? " via gateway" : "";
		if (block.kind === "tool") lines.push(`**Tool call:** \`${block.name}\`${via}`, "", fenced(block.args, "json"), "");
		if (block.kind === "result")
			lines.push(`**${block.failed ? "Failed" : "Result"}:** \`${block.name}\`${via}`, "", fenced(block.text, "text"), "");
		if (block.kind === "note") lines.push(`> **${block.title}**`, "", fenced(block.text, "text"), "");
	}
	return { text: `${lines.join("\n")}\n`, turns };
}

const escapeHtml = (text: string): string =>
	text.replace(/[&<>"']/g, (character) =>
		character === "&"
			? "&amp;"
			: character === "<"
				? "&lt;"
				: character === ">"
					? "&gt;"
					: character === '"'
						? "&quot;"
						: "&#39;",
	);

const HTML_STYLE = `
:root{color-scheme:light dark;--paper:#f7f3ea;--ink:#1d1b17;--muted:#6b645a;--line:#d8d0c2;--well:#efe8da;--fail:#8c3a32}
@media (prefers-color-scheme:dark){:root{--paper:#111;--ink:#ece6da;--muted:#a59d90;--line:#3a352e;--well:#1c1a17;--fail:#e0897f}}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main,header{max-width:52rem;margin:0 auto;padding:1.5rem 1rem}
header{border-bottom:1px solid var(--line)}
h1{font-size:1.4rem;margin:0 0 .25rem}h2{font-size:1rem;margin:1.5rem 0 .5rem}
.meta,.note-title,.tool-name{color:var(--muted);font-size:.85rem}
pre{background:var(--well);border:1px solid var(--line);border-radius:6px;padding:.75rem;overflow-x:auto;white-space:pre-wrap;font:13px/1.45 ui-monospace,"Cascadia Code",Consolas,monospace}
.request{background:var(--well);border-radius:10px;padding:.75rem 1rem;white-space:pre-wrap}
.response{white-space:pre-wrap}.failed{color:var(--fail)}
details{margin:.5rem 0}summary{cursor:pointer;color:var(--muted);font-size:.9rem}
`;

function renderTranscriptHtml(input: TranscriptExportInput): { text: string; turns: number } {
	const { blocks, turns } = transcriptBlocks(input);
	const body: string[] = [];
	for (const block of blocks) {
		if (block.kind === "request") body.push(`<h2>Request</h2><div class="request">${escapeHtml(block.text)}</div>`);
		if (block.kind === "response") {
			body.push("<h2>Clio Coder</h2>");
			if (block.reasoning) body.push('<p class="meta">Reasoning was reported for this reply and is not included.</p>');
			if (block.text.trim().length > 0) body.push(`<div class="response">${escapeHtml(block.text)}</div>`);
		}
		const via =
			(block.kind === "tool" || block.kind === "result") && block.viaGateway
				? ' <span class="tool-name">via gateway</span>'
				: "";
		if (block.kind === "tool")
			body.push(
				`<details><summary>Tool call · <span class="tool-name">${escapeHtml(block.name)}</span>${via}</summary><pre>${escapeHtml(block.args)}</pre></details>`,
			);
		if (block.kind === "result")
			body.push(
				`<details${block.failed ? " open" : ""}><summary class="${block.failed ? "failed" : ""}">${block.failed ? "Failed" : "Result"} · <span class="tool-name">${escapeHtml(block.name)}</span>${via}</summary><pre>${escapeHtml(block.text)}</pre></details>`,
			);
		if (block.kind === "note")
			body.push(`<p class="note-title">${escapeHtml(block.title)}</p><pre>${escapeHtml(block.text)}</pre>`);
	}
	const title = `Clio Coder session ${escapeHtml(input.sessionId)}`;
	const text = [
		"<!doctype html>",
		'<html lang="en">',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${title}</title>`,
		`<style>${HTML_STYLE}</style>`,
		`<header><h1>${title}</h1><p class="meta">Exported ${escapeHtml(input.exportedAt)} · ${turns} ${turns === 1 ? "request" : "requests"}</p></header>`,
		`<main>${body.join("\n")}</main>`,
		"</html>",
		"",
	].join("\n");
	return { text, turns };
}

/**
 * `/export` for a host with no terminal: render the branch the session is on
 * and write it where the terminal writes it, `.clio-coder/exports/<id>-<date>.html`
 * unless a path is named, and Markdown when that path ends in `.md`. The date
 * is the operator's calendar date; the file carries the ISO instant.
 */
export function writeTranscriptExport(input: {
	sessionId: string | null;
	leafTurnId: (sessionId: string) => string | null;
	readEntries: (sessionId: string) => ReadonlyArray<SessionEntry>;
	cwd: string;
	path?: string;
	now?: () => Date;
}): { level: "success" | "error"; text: string } {
	const { sessionId } = input;
	if (sessionId === null) return { level: "error", text: "no active session to export" };
	const exportedAt = input.now?.() ?? new Date();
	const date = [
		exportedAt.getFullYear(),
		String(exportedAt.getMonth() + 1).padStart(2, "0"),
		String(exportedAt.getDate()).padStart(2, "0"),
	].join("-");
	const requested = input.path?.trim() ?? "";
	const target = resolve(
		input.cwd,
		requested.length > 0 ? requested : join(".clio-coder", "exports", `${sessionId}-${date}.html`),
	);
	const source = {
		sessionId,
		exportedAt: exportedAt.toISOString(),
		entries: input.readEntries(sessionId),
		leafTurnId: input.leafTurnId(sessionId),
	};
	const rendered = target.toLowerCase().endsWith(".md")
		? renderTranscriptMarkdown(source)
		: renderTranscriptHtml(source);
	safeResourceWrite(target, rendered.text, { encoding: "utf8" });
	const shown = relative(input.cwd, target);
	return {
		level: "success",
		text: `wrote ${rendered.turns} ${rendered.turns === 1 ? "request" : "requests"} to ${
			shown.startsWith("..") || isAbsolute(shown) ? target : shown
		}`,
	};
}
