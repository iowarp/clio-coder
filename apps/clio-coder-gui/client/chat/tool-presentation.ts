/**
 * The tool-call taxonomy: which card a timeline item gets, what its one-line
 * headline says, and which facts the card states. Pure by design. The app has
 * no DOM test environment, so every decision that could be wrong lives here
 * where `node:test` can reach it, and `tool-cards.tsx` is a switch over the
 * result.
 *
 * Keyed on `item.title`, which the ACP server sets to the canonical Clio tool
 * name (src/engine/acp/server.ts). `item.toolKind` is a five-value UI hint whose
 * mapping is lossy (git, dispatch and steer all become `other`; read, ls,
 * context and monitor all become `read`), so it is only the fallback for MCP and
 * dynamic tools.
 */

import type { TimelineItem } from "../../contracts/sessions.js";
import type { StatusTone } from "../design/status.js";
import { type DiffPanel, diffPanel } from "./diff.js";

/** Ported from the workbench's clio-host.ts generic-label table. */
export const SAFE_TOOL_TITLES: Readonly<Record<string, string>> = {
	read: "Read project content",
	edit: "Edit project content",
	delete: "Delete project content",
	move: "Move project content",
	search: "Search project content",
	execute: "Run a project command",
	think: "Reason about the task",
	fetch: "Fetch external content",
	switch_mode: "Change work mode",
	other: "Use a Clio Coder tool",
};

/** App.tsx:1156. A tool running longer than this is called out without expanding. */
export const LONG_RUNNING_TOOL_SECONDS = 30;
/** Headline budget. A headline is one line in a dense row, never a paragraph. */
export const HEADLINE_MAX_CHARS = 72;
/** clio-host.ts presentable-title budget, in UTF-8 bytes. */
export const PRESENTABLE_MAX_BYTES = 511;
/** DOM bound on the match list. The wire is already bounded; this bounds paint. */
export const MAX_RENDERED_MATCHES = 200;
/** supervisor.ts caps `partialOutput` at this many UTF-16 units. */
export const PARTIAL_OUTPUT_LIMIT = 16_384;

export type ToolBody = "diff" | "terminal" | "matches" | "file" | "fetch" | "dispatch" | "ask" | "json";

export interface ToolFact {
	readonly label: string;
	readonly value: string;
	readonly tone?: StatusTone;
}

export interface ToolLocation {
	readonly path: string;
	readonly line: number | null;
}

export interface MatchGroup {
	readonly path: string;
	readonly rows: ReadonlyArray<{ readonly id: string; readonly line: number | null; readonly text: string }>;
	readonly total: number;
}

/**
 * The live output pane. `source` says where the text came from and never
 * doubles as a completion signal: a running call can carry a full 16 KiB
 * snapshot and still be running.
 */
export interface OutputPane {
	readonly source: "partial" | "final" | "none";
	readonly text: string;
	readonly running: boolean;
	/** The producer cut the text short, so it is a tail or a head, not the whole. */
	readonly truncated: boolean;
	/** Shown when `source` is "none" so the pane's DOM node exists from frame one. */
	readonly placeholder: string | null;
}

export interface ToolPresentation {
	/** Short lowercase kind chip. */
	readonly chip: string;
	/** Plain-language verb for the collapsed row. The exact tool name stays in `name`. */
	readonly verb: string;
	/** The one fact worth reading on the collapsed row: an exit code, a line count, a change count. */
	readonly digest: string | null;
	/** Tone of the digest when it carries a judgement, such as a nonzero exit code. */
	readonly digestTone: StatusTone | null;
	/** Canonical tool name, or the kind hint when the name is missing. */
	readonly name: string;
	/** One line, always visible, never JSON. */
	readonly headline: string;
	readonly body: ToolBody;
	readonly tone: StatusTone;
	readonly statusLabel: string;
	readonly settled: boolean;
	readonly failed: boolean;
	readonly facts: readonly ToolFact[];
	/** A truthful sentence about a cap, a block or a skipped diff. Never model prose. */
	readonly note: string | null;
	readonly locations: readonly ToolLocation[];
	readonly output: OutputPane;
	/** Present only for a `diff` body. */
	readonly diff: DiffPanel | null;
	/** Present only for a `matches` body. */
	readonly matches: readonly MatchGroup[];
	readonly matchesDropped: number;
	/** True when the wire replaced an oversized rawInput/rawOutput with a snippet. */
	readonly rawTruncated: boolean;
}

/* ---------------------------------------------------------------- helpers */

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control code points is this function's whole job.
const CONTROL = /[\u0000-\u001f\u007f]/g;

function encoder(): TextEncoder {
	return new TextEncoder();
}

/**
 * Port of `presentableToolTitle`: strip control code points, fold the workspace
 * root down to `[project]`, trim, and cap at 511 UTF-8 bytes with a trailing
 * ellipsis. A path that survives nothing falls back to the caller's label.
 */
export function presentable(value: string, workspaceRoot?: string): string {
	let text = value.replace(CONTROL, "");
	if (workspaceRoot !== undefined && workspaceRoot.length > 0) text = text.split(workspaceRoot).join("[project]");
	text = text.trim();
	const bytes = encoder().encode(text);
	if (bytes.byteLength <= PRESENTABLE_MAX_BYTES) return text;
	// Cut on a code-point boundary, not a byte boundary.
	let cut = text.length;
	while (cut > 0 && encoder().encode(text.slice(0, cut)).byteLength > PRESENTABLE_MAX_BYTES - 3) cut -= 1;
	return `${text.slice(0, cut)}…`;
}

export function truncateHeadline(value: string, limit = HEADLINE_MAX_CHARS): string {
	const single = value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
	return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`;
}

export function basename(path: string): string {
	const trimmed = path.replace(/[/\\]+$/, "");
	const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(value: number | null | undefined): string {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "unknown size";
	let size = value;
	let unit = 0;
	while (size >= 1024 && unit < UNITS.length - 1) {
		size /= 1024;
		unit += 1;
	}
	return `${unit === 0 ? size : size.toFixed(size < 10 ? 1 : 0)} ${UNITS[unit]}`;
}

export function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "0s";
	const whole = Math.floor(seconds);
	if (whole < 60) return `${whole}s`;
	const minutes = Math.floor(whole / 60);
	if (minutes < 60) return `${minutes}m ${whole % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------- wire unwrapping */

export interface ToolWire {
	readonly input: Record<string, unknown>;
	readonly result: Record<string, unknown> | undefined;
	readonly details: Record<string, unknown> | undefined;
	readonly resultText: string | null;
	readonly isError: boolean;
	readonly rawTruncated: boolean;
}

/** Text carried by an ACP content array, used when a terminal frame had no rawOutput. */
function contentText(value: unknown): string | null {
	if (!Array.isArray(value)) return null;
	const parts: string[] = [];
	for (const entry of value) {
		const outer = record(entry);
		if (outer === undefined) continue;
		const inner = record(outer.content) ?? outer;
		const text = str(inner.text);
		if (text !== null) parts.push(text);
	}
	return parts.length === 0 ? null : parts.join("");
}

/**
 * The operator copy of a result. Clio Coder shapes what the model reads into a bounded context text with
 * a `[tool-result …]` header, and keeps the plain output for people in
 * `details.resultDisposition.presentation.content` (src/tools/result-disposition.ts,
 * `toolResultPresentationText`). The terminal reads that copy, so the GUI does too.
 */
function operatorText(details: Record<string, unknown> | undefined): string | null {
	const presentation = record(record(details?.resultDisposition)?.presentation);
	return typeof presentation?.content === "string" ? presentation.content : null;
}

const ENVELOPE_FIELD = /^(kind|retrieve|followUp|summary|fallback|facts)=/;

/**
 * Removes the model-facing `[tool-result <mode>]` header and `[tool-result metadata]` trailer when a result
 * carries no operator copy. Only a block made entirely of the known `key=` lines is removed, so ordinary
 * output that happens to start with a bracket stays intact.
 */
export function stripResultEnvelope(text: string): string {
	let body = text;
	if (/^\[tool-result [a-z-]+\]\n/.test(body)) {
		const lines = body.split("\n");
		let index = 1;
		while (index < lines.length && ENVELOPE_FIELD.test(lines[index] ?? "")) index += 1;
		if (index > 1) body = lines.slice(index).join("\n");
	}
	const trailer = body.lastIndexOf("[tool-result metadata]\n");
	if (trailer >= 0 && (trailer === 0 || body[trailer - 1] === "\n")) {
		const rest = body.slice(trailer + "[tool-result metadata]\n".length).split("\n");
		if (rest.every((line) => line === "" || ENVELOPE_FIELD.test(line)))
			body = body.slice(0, trailer).replace(/\n+$/, "\n");
	}
	return body;
}

/**
 * Unwrap `rawInput`/`rawOutput` into the shapes the taxonomy reads.
 *
 * Three real shapes have to survive here:
 *   - `{result, isError}`, what the ACP server sends (server.ts:1152);
 *   - `{content: [...]}`, what the GUI supervisor substitutes when a terminal
 *     frame carried content but no rawOutput (supervisor.ts:394);
 *   - `{truncated: true, snippet}`, what the supervisor substitutes for a
 *     record over 32 KiB (supervisor.ts:410).
 *
 * A failed tool returns `{kind:"error", message}` with no `output` field, so the
 * result text is read from `message` as well as `output`.
 */
export function readWire(item: Pick<TimelineItem, "rawInput" | "rawOutput">): ToolWire {
	const input = record(item.rawInput) ?? {};
	const output = record(item.rawOutput);
	const inputTruncated = item.rawInput !== undefined && record(item.rawInput)?.truncated === true;
	if (output === undefined)
		return {
			input,
			result: undefined,
			details: undefined,
			resultText: null,
			isError: false,
			rawTruncated: inputTruncated,
		};
	if (output.truncated === true && typeof output.snippet === "string")
		return {
			input,
			result: undefined,
			details: undefined,
			resultText: output.snippet,
			isError: false,
			rawTruncated: true,
		};
	const result = record(output.result);
	const details = record(result?.details);
	const operator = operatorText(details);
	const modelText =
		str(result?.output) ?? str(result?.message) ?? contentText(output.content) ?? contentText(result?.content) ?? null;
	const resultText = operator ?? (modelText === null ? null : stripResultEnvelope(modelText));
	return {
		input,
		result,
		details,
		resultText,
		isError: output.isError === true || result?.kind === "error",
		rawTruncated: inputTruncated,
	};
}

/* ------------------------------------------------------------ live output */

/**
 * A progress frame carries the tool's WHOLE output so far, so a new frame
 * REPLACES the previous snapshot. Appending would duplicate every byte each
 * time two frames land close together. This function exists so that rule is
 * testable rather than buried in a reducer.
 */
export function applyPartialFrame(_previous: string | undefined, frame: string | undefined): string | undefined {
	return frame;
}

export function isSettledStatus(status: string): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * The output pane for one item. The presence of `partialOutput` says the call is
 * RUNNING, never that it finished; `running` is derived from `status` alone.
 */
export function outputPane(item: Pick<TimelineItem, "status" | "partialOutput">, wire: ToolWire): OutputPane {
	const running = !isSettledStatus(item.status);
	if (running) {
		const partial = item.partialOutput;
		if (partial !== undefined && partial.length > 0)
			return {
				source: "partial",
				text: partial,
				running: true,
				truncated: partial.length >= PARTIAL_OUTPUT_LIMIT,
				placeholder: null,
			};
		return {
			source: "none",
			text: "",
			running: true,
			truncated: false,
			placeholder: "Running. No output yet.",
		};
	}
	const text = wire.resultText;
	if (text === null || text.length === 0)
		return { source: "none", text: "", running: false, truncated: false, placeholder: "No output." };
	return {
		source: "final",
		text,
		running: false,
		truncated:
			record(wire.details?.observation)?.truncated === true ||
			record(wire.details?.resultDisposition)?.presentationTruncated === true,
		placeholder: null,
	};
}

/* ----------------------------------------------------------------- matches */

const MATCH_ROW = /^(.+?):(\d+):(.*)$/;

/** Parse `path:line:text` rows into per-file groups, bounded for paint. */
export function parseMatches(output: string | null): { groups: MatchGroup[]; dropped: number } {
	if (output === null || output.length === 0) return { groups: [], dropped: 0 };
	const grouped = new Map<string, Array<{ id: string; line: number | null; text: string }>>();
	let seen = 0;
	let kept = 0;
	for (const line of output.split("\n")) {
		if (line.length === 0) continue;
		// The observation envelope appends bracketed notices; they are not matches.
		if (line.startsWith("[")) continue;
		const match = MATCH_ROW.exec(line);
		const path = match === null ? line : (match[1] ?? line);
		const number = match === null ? null : Number(match[2]);
		const text = match === null ? "" : (match[3] ?? "");
		seen += 1;
		if (kept >= MAX_RENDERED_MATCHES) continue;
		const rows = grouped.get(path) ?? [];
		// A match row has no identity on the wire, so ordinal position is its
		// identity and it is assigned here rather than in the renderer.
		rows.push({ id: `m${kept}`, line: number, text });
		kept += 1;
		grouped.set(path, rows);
	}
	const groups = [...grouped].map(([path, rows]) => ({ path, rows, total: rows.length }));
	return { groups, dropped: Math.max(0, seen - kept) };
}

/* ------------------------------------------------------------ fact strips */

function searchFacts(details: Record<string, unknown> | undefined): ToolFact[] {
	const facts: ToolFact[] = [];
	const observation = record(details?.observation);
	const shown = num(observation?.shownCount);
	const total = num(observation?.totalCount);
	const unit = str(observation?.unit) ?? "results";
	if (shown !== null)
		facts.push({
			label: unit,
			value: total !== null && total !== shown ? `${shown} of ${total}` : String(shown),
		});
	if (observation?.truncated === true)
		facts.push({ label: "bounded", value: "Clio Coder cut this result", tone: "warn" });
	const search = record(details?.search);
	if (search !== undefined && search.complete === false) {
		const reason = str(search.reason) ?? "unknown";
		facts.push({ label: "coverage", value: `incomplete (${reason})`, tone: "warn" });
	}
	const skipped = record(search?.skipped);
	const skippedCount = num(skipped?.count);
	if (skippedCount !== null && skippedCount > 0)
		facts.push({ label: "skipped", value: `${skippedCount} paths`, tone: "warn" });
	return facts;
}

function terminalFacts(details: Record<string, unknown> | undefined): ToolFact[] {
	if (details === undefined) return [];
	const facts: ToolFact[] = [];
	const exitCode = num(details.exitCode);
	if (exitCode !== null)
		facts.push({ label: "exit", value: String(exitCode), tone: exitCode === 0 ? "success" : "fail" });
	const signal = str(details.signal);
	if (signal !== null) facts.push({ label: "signal", value: signal, tone: "fail" });
	const stdout = num(details.stdoutBytes);
	const stderr = num(details.stderrBytes);
	if (stdout !== null) facts.push({ label: "stdout", value: formatBytes(stdout) });
	if (stderr !== null && stderr > 0) facts.push({ label: "stderr", value: formatBytes(stderr) });
	const outcome = str(details.outcome);
	if (outcome !== null && outcome !== "success")
		facts.push({ label: "outcome", value: outcome, tone: outcome === "nonzero" ? "fail" : "warn" });
	return facts;
}

function terminalNote(details: Record<string, unknown> | undefined): string | null {
	if (details === undefined) return null;
	if (details.timedOut === true) return "The command timed out and was stopped.";
	if (details.aborted === true) return "The command was cancelled before it finished.";
	if (details.outputCapped === true) return "Output hit the byte cap and the command was stopped.";
	return null;
}

function fileFacts(details: Record<string, unknown> | undefined): ToolFact[] {
	const facts: ToolFact[] = [];
	const file = record(details?.file);
	const bytes = num(file?.bytes);
	if (bytes !== null) facts.push({ label: "size", value: formatBytes(bytes) });
	facts.push(...searchFacts(details));
	return facts;
}

function fileNote(details: Record<string, unknown> | undefined): string | null {
	if (details?.code !== "read_past_eof") return null;
	const total = num(details.totalLines);
	return total === null
		? "The requested range starts past the end of the file."
		: `The requested range starts past the end of the file (${total} lines).`;
}

function fetchFacts(details: Record<string, unknown> | undefined): ToolFact[] {
	if (details === undefined) return [];
	const facts: ToolFact[] = [];
	const status = num(details.status);
	if (status !== null) facts.push({ label: "status", value: String(status), tone: status < 400 ? "success" : "fail" });
	const contentType = str(details.contentType);
	if (contentType !== null) facts.push({ label: "type", value: contentType });
	const bytes = num(details.bytesRead) ?? num(details.bytes);
	if (bytes !== null) facts.push({ label: "read", value: formatBytes(bytes) });
	const format = str(details.format);
	if (format !== null) facts.push({ label: "shape", value: format });
	return facts;
}

/* ----------------------------------------------------------- the taxonomy */

interface Kind {
	readonly chip: string;
	readonly body: ToolBody;
}

const KINDS: Readonly<Record<string, Kind>> = {
	read: { chip: "read", body: "file" },
	ls: { chip: "list", body: "file" },
	edit: { chip: "edit", body: "diff" },
	write: { chip: "write", body: "diff" },
	artifact: { chip: "edit", body: "diff" },
	bash: { chip: "bash", body: "terminal" },
	run_script: { chip: "run", body: "terminal" },
	verify: { chip: "run", body: "terminal" },
	safe_exec: { chip: "run", body: "terminal" },
	git: { chip: "git", body: "terminal" },
	grep: { chip: "grep", body: "matches" },
	find: { chip: "find", body: "matches" },
	code_nav: { chip: "nav", body: "matches" },
	web_fetch: { chip: "fetch", body: "fetch" },
	dispatch: { chip: "dispatch", body: "dispatch" },
	monitor: { chip: "control", body: "json" },
	steer: { chip: "control", body: "json" },
	panes: { chip: "control", body: "json" },
	context: { chip: "context", body: "json" },
	ask_user: { chip: "ask", body: "ask" },
	decide: { chip: "ask", body: "ask" },
	evidence: { chip: "evidence", body: "json" },
	ledger: { chip: "ledger", body: "json" },
	task: { chip: "task", body: "json" },
};

/** What a collapsed row says the call did. Someone who has never used a shell reads these first. */
const VERBS: Readonly<Record<string, string>> = {
	read: "Read",
	list: "List",
	edit: "Edit",
	write: "Write",
	bash: "Run",
	run: "Run",
	git: "Git",
	grep: "Search",
	find: "Find",
	nav: "Look up",
	fetch: "Fetch",
	dispatch: "Delegate",
	control: "Control",
	context: "Context",
	ask: "Ask",
	evidence: "Evidence",
	ledger: "Ledger",
	task: "Task",
	search: "Search",
	think: "Think",
	delete: "Delete",
	move: "Move",
	tool: "Tool",
};

/** Longest failure excerpt a folded row carries; the full text is one click away. */
export const FAILURE_EXCERPT_MAX = 96;

/** The last non-empty line a failed call printed, as Clio Coder's terminal shows it on the folded row. */
export function failureExcerpt(text: string): string | null {
	const line = text
		.split("\n")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.at(-1);
	if (line === undefined) return null;
	return line.length > FAILURE_EXCERPT_MAX ? `${line.slice(0, FAILURE_EXCERPT_MAX - 1)}…` : line;
}

/** "1 entries" reads as a bug. Observation units are plain English plurals, so this covers them. */
function singular(unit: string): string {
	if (unit.endsWith("ies")) return `${unit.slice(0, -3)}y`;
	if (unit.endsWith("ches") || unit.endsWith("shes")) return unit.slice(0, -2);
	return unit.endsWith("s") ? unit.slice(0, -1) : unit;
}

function digestFor(
	body: ToolBody,
	facts: readonly ToolFact[],
	diff: DiffPanel | null,
	matches: readonly MatchGroup[],
	settled: boolean,
): { text: string | null; tone: StatusTone | null } {
	const fact = (label: string) => facts.find((entry) => entry.label === label);
	switch (body) {
		case "terminal": {
			const exit = fact("exit");
			if (exit !== undefined) return { text: `exit ${exit.value}`, tone: exit.tone ?? null };
			const signal = fact("signal");
			return signal === undefined ? { text: null, tone: null } : { text: signal.value, tone: "fail" };
		}
		case "file": {
			const counted = facts.find((entry) => entry.label !== "size" && entry.tone === undefined);
			if (counted !== undefined)
				return { text: `${counted.value} ${counted.value === "1" ? singular(counted.label) : counted.label}`, tone: null };
			const size = fact("size");
			return { text: size?.value ?? null, tone: null };
		}
		case "diff":
			return diff?.diff ? { text: `+${diff.diff.adds} −${diff.diff.dels}`, tone: null } : { text: null, tone: null };
		case "matches": {
			if (!settled) return { text: null, tone: null };
			const rows = matches.reduce((total, group) => total + group.total, 0);
			return {
				text:
					rows === 0
						? "no matches"
						: `${rows.toLocaleString("en-US")} ${rows === 1 ? "match" : "matches"}${matches.length > 1 ? ` in ${matches.length} files` : ""}`,
				tone: null,
			};
		}
		case "fetch": {
			const status = fact("status");
			return status === undefined ? { text: null, tone: null } : { text: status.value, tone: status.tone ?? null };
		}
		case "dispatch":
			return { text: fact("agent")?.value ?? null, tone: null };
		default:
			return { text: null, tone: null };
	}
}

/** The five-value ACP hint, used only when the canonical name is unknown. */
const KIND_HINT: Readonly<Record<string, Kind>> = {
	read: { chip: "read", body: "file" },
	edit: { chip: "edit", body: "diff" },
	search: { chip: "search", body: "matches" },
	execute: { chip: "run", body: "terminal" },
	fetch: { chip: "fetch", body: "fetch" },
	think: { chip: "think", body: "json" },
	delete: { chip: "delete", body: "json" },
	move: { chip: "move", body: "json" },
	other: { chip: "tool", body: "json" },
};

function range(input: Record<string, unknown>): string {
	const offset = num(input.offset);
	const limit = num(input.limit);
	const tail = num(input.tail);
	if (tail !== null) return ` · last ${tail} lines`;
	if (offset === null && limit === null) return "";
	const start = offset ?? 1;
	return limit === null ? ` · from line ${start}` : ` · lines ${start}–${start + limit - 1}`;
}

function headlineFor(name: string, input: Record<string, unknown>, fallback: string): string {
	const path = str(input.path);
	switch (name) {
		case "read":
			return path === null ? fallback : `${basename(path)}${range(input)}`;
		case "ls":
			return path ?? ".";
		case "edit": {
			const edits = Array.isArray(input.edits) ? input.edits.length : 1;
			return path === null ? fallback : `${basename(path)} · ${edits} replacement${edits === 1 ? "" : "s"}`;
		}
		case "write":
			return path === null ? fallback : basename(path);
		case "artifact":
			return `${str(input.op) ?? "artifact"} ${path === null ? "" : basename(path)}`.trim();
		case "bash":
			return str(input.command)?.split("\n", 1)[0] ?? fallback;
		case "run_script":
		case "verify":
		case "safe_exec":
			return str(input.script) ?? str(input.id) ?? str(input.op) ?? str(input.command) ?? fallback;
		case "git":
			return `git ${str(input.op) ?? str(input.subcommand) ?? ""}`.trim();
		case "grep": {
			const pattern = str(input.pattern) ?? "";
			const glob = str(input.glob);
			return `/${pattern}/ in ${path ?? "."}${glob === null ? "" : ` (${glob})`}`;
		}
		case "find":
			return str(input.pattern) ?? str(input.glob) ?? fallback;
		case "code_nav":
			return `${str(input.op) ?? "nav"} ${str(input.symbol) ?? path ?? ""}`.trim();
		case "web_fetch": {
			const url = str(input.url);
			if (url === null) return fallback;
			try {
				const parsed = new URL(url);
				return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
			} catch {
				return url;
			}
		}
		case "dispatch": {
			const agent = str(input.agent) ?? str(input.recipe) ?? "worker";
			const task = str(input.task);
			return `${agent} · ${task ?? "no task preview"}`;
		}
		case "monitor":
		case "steer":
		case "panes":
		case "context":
			return str(input.op) ?? fallback;
		case "ask_user":
		case "decide":
			return str(input.question) ?? str(input.prompt) ?? fallback;
		default:
			return fallback;
	}
}

const STATUS_LABEL: Readonly<Record<string, string>> = {
	pending: "Queued",
	in_progress: "Running",
	completed: "Done",
	failed: "Failed",
	cancelled: "Cancelled",
};

function toneFor(status: string, isError: boolean): StatusTone {
	if (isError || status === "failed") return "fail";
	if (status === "cancelled") return "fail";
	if (status === "completed") return "success";
	if (status === "in_progress") return "running";
	return "warn";
}

export interface PresentOptions {
	/** Workspace root, folded to `[project]` in every path this card prints. */
	readonly workspaceRoot?: string;
	/** Shared clock, in ms. Only used to mark a long-running call. */
	readonly nowMs?: number;
	/** When the call started, in ms. Only used to mark a long-running call. */
	readonly startedAtMs?: number;
}

/** The whole card, derived from one timeline item. Never throws. */
export function presentTool(item: TimelineItem, options: PresentOptions = {}): ToolPresentation {
	const wire = readWire(item);
	const name = item.title ?? item.toolKind ?? "tool";
	const kind = KINDS[name] ?? KIND_HINT[item.toolKind ?? "other"] ?? { chip: item.toolKind ?? "tool", body: "json" };
	const fallback = SAFE_TOOL_TITLES[name] ?? SAFE_TOOL_TITLES[item.toolKind ?? "other"] ?? SAFE_TOOL_TITLES.other;
	const rawHeadline = headlineFor(name, wire.input, item.text.length > 0 ? item.text : (fallback as string));
	const headline = truncateHeadline(presentable(rawHeadline, options.workspaceRoot)) || (fallback as string);
	const settled = isSettledStatus(item.status);
	const failed = item.status === "failed" || wire.isError;

	const facts: ToolFact[] = [];
	let note: string | null = null;
	let matches: MatchGroup[] = [];
	let matchesDropped = 0;
	let diff: DiffPanel | null = null;

	switch (kind.body) {
		case "diff":
			diff = diffPanel({
				rawInput: wire.input,
				result: wire.result,
				resultText: wire.resultText,
				status: item.status,
				isError: wire.isError,
			});
			// The diff panel prints its own note and +/- counts. Repeating them as card facts said
			// everything twice and painted "removed 0" as a failure.
			if (diff.diff?.truncated === true) facts.push({ label: "diff", value: "cut short by a cap", tone: "warn" });
			break;
		case "terminal":
			facts.push(...terminalFacts(wire.details));
			note = terminalNote(wire.details);
			break;
		case "matches": {
			const parsed = parseMatches(wire.resultText);
			matches = parsed.groups;
			matchesDropped = parsed.dropped;
			facts.push(...searchFacts(wire.details));
			if (matchesDropped > 0)
				note = `${matchesDropped} more rows arrived than this view draws; open the raw result to see them all.`;
			break;
		}
		case "file":
			facts.push(...fileFacts(wire.details));
			note = fileNote(wire.details);
			break;
		case "fetch":
			facts.push(...fetchFacts(wire.details));
			if (wire.details?.truncated === true) note = "The fetched body was cut at the byte cap.";
			break;
		case "dispatch": {
			const runId = str(wire.details?.runId) ?? str(wire.input.runId);
			if (runId !== null) facts.push({ label: "run", value: runId });
			const agent = str(wire.input.agent) ?? str(wire.input.recipe);
			if (agent !== null) facts.push({ label: "agent", value: agent });
			break;
		}
		default:
			break;
	}

	if (wire.rawTruncated)
		note = note ?? "This call's raw record was larger than the 32 KiB wire limit, so only a snippet reached the browser.";

	const elapsedSeconds =
		options.nowMs !== undefined && options.startedAtMs !== undefined
			? Math.max(0, Math.floor((options.nowMs - options.startedAtMs) / 1000))
			: null;
	if (!settled && elapsedSeconds !== null && elapsedSeconds >= LONG_RUNNING_TOOL_SECONDS)
		facts.push({ label: "still running", value: formatDuration(elapsedSeconds), tone: "warn" });

	const output = outputPane(item, wire);
	const excerpt = failed ? failureExcerpt(output.text) : null;
	const digest =
		excerpt === null ? digestFor(kind.body, facts, diff, matches, settled) : { text: excerpt, tone: "fail" as const };
	return {
		chip: kind.chip,
		verb: VERBS[kind.chip] ?? "Tool",
		digest: digest.text,
		digestTone: digest.tone,
		name,
		headline,
		body: kind.body,
		tone: toneFor(item.status, wire.isError),
		// A result that reports an error is a failure even when its frame said completed.
		statusLabel: wire.isError && item.status === "completed" ? "Failed" : (STATUS_LABEL[item.status] ?? item.status),
		settled,
		failed,
		facts,
		note,
		locations: (item.locations ?? []).map((location) => ({
			path: presentable(location.path, options.workspaceRoot),
			line: typeof location.line === "number" ? location.line : null,
		})),
		output,
		diff,
		matches,
		matchesDropped,
		rawTruncated: wire.rawTruncated,
	};
}

/**
 * Which rows start open, mirroring Clio Coder's own presentation policy (src/tools/presentation.ts):
 * every call folds to its one line, a change keeps its diff visible under that line, and a failure
 * carries its last output line on the folded row instead of opening. Two additions follow a live run:
 * a command observed while it runs shows its output as it arrives, and a question shows itself.
 */
export function toolOpensAtMount(card: Pick<ToolPresentation, "body" | "settled">): boolean {
	if (card.body === "diff") return true;
	if (card.settled) return false;
	return card.body === "terminal" || card.body === "ask";
}

/**
 * One line naming what a call is doing, for a live status or a collapsed group: "Run python3 analyze.py"
 * instead of the bare tool name. Never throws, like `presentTool`.
 */
export function describeTool(item: TimelineItem, workspaceRoot?: string): string {
	const card = presentTool(item, workspaceRoot === undefined ? {} : { workspaceRoot });
	return `${card.verb} ${card.headline}`;
}

/** `path:12`, with the ACP zero-based line turned into an editor line. */
export function formatLocation(location: ToolLocation): string {
	return location.line === null ? location.path : `${location.path}:${location.line + 1}`;
}
