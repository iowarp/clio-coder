import { readdirSync, readFileSync, statSync } from "node:fs";
import path, { join, relative } from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { StringEnum } from "../engine/ai.js";
import { resolveRgBinary } from "./executables.js";
import { compileGlobRegex, fallbackIgnoredDirs, normalizeGlobInput, rgIgnoreArgs } from "./ignore-policy.js";
import {
	commitObservationReservation,
	finalizeObservation,
	OBSERVE_SELF_CAPS,
	type ObservationReservation,
	type ObservationUnit,
	observationBudgetExhausted,
	releaseObservation,
	reserveObservation,
} from "./observation.js";
import { resolveReadPath, toPosixPath } from "./path-utils.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "./registry.js";
import { SEARCH_SPAWN_TIMEOUT_MS, spawnLineStream, validateSearchPatternSize } from "./spawn-hygiene.js";
import { GREP_MAX_LINE_LENGTH, truncateHead, truncateLine } from "./truncate.js";

const DEFAULT_LIMIT = 100;
// Per-file read ceiling for the fallback searcher. Matches the read tool's
// file cap; anything larger is skipped rather than pulled into memory.
const FALLBACK_MAX_FILE_BYTES = 20_000_000;

type GrepMode = "content" | "files" | "count";

const MODE_UNITS: Record<GrepMode, ObservationUnit> = {
	content: "matches",
	files: "paths",
	count: "results",
};

function parseContext(value: unknown): number | null {
	if (value === undefined) return 0;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
	return Math.floor(value);
}

function formatPath(filePath: string, searchPath: string, isDirectory: boolean): string {
	if (isDirectory) {
		const relativePath = path.relative(searchPath, filePath);
		if (relativePath && !relativePath.startsWith("..")) return toPosixPath(relativePath);
	}
	return path.basename(filePath);
}

function statIsDirectory(searchPath: string): { ok: true; isDirectory: boolean } | { ok: false; message: string } {
	try {
		return { ok: true, isDirectory: statSync(searchPath).isDirectory() };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, message };
	}
}

/**
 * One rendered output line. Match lines print as `path:line: text`, context
 * lines as `path-line- text`; the flag distinguishes them so the shown match
 * count stays exact after byte-capping cuts a rendered block.
 */
interface RenderedLine {
	text: string;
	isMatch: boolean;
}

interface GrepRenderInput {
	mode: GrepMode;
	lines: RenderedLine[];
	matchCount: number;
	/** True when the search stopped at the match limit (total unknown). */
	limitHit: boolean;
	limit: number;
	linesTruncated: boolean;
	reservation: ObservationReservation;
	options: ToolInvokeOptions | undefined;
}

const NO_MATCH_OUTPUT = "No matches found";

/**
 * Shared shaping for the rg and fallback paths: byte-cap the rendered lines at
 * the reservation cap (never mid-line), recount shown items, offload the full
 * rendering when anything was cut, and close the envelope.
 */
function renderGrepResult(input: GrepRenderInput): ToolResult {
	const { mode, lines, matchCount, limitHit, limit, linesTruncated, reservation, options } = input;
	if (lines.length === 0) {
		return finalizeObservation({
			tool: ToolNames.Grep,
			unit: MODE_UNITS[mode],
			output: NO_MATCH_OUTPUT,
			shownCount: 0,
			totalCount: 0,
			truncated: false,
			reservation,
			...(options ? { options } : {}),
		});
	}
	const fullOutput = lines.map((line) => line.text).join("\n");
	const truncation = truncateHead(fullOutput, {
		maxBytes: reservation.callCapBytes,
		maxLines: Number.MAX_SAFE_INTEGER,
	});
	let shownCount: number;
	if (mode === "content") {
		shownCount = truncation.truncated
			? lines.slice(0, truncation.outputLines).filter((line) => line.isMatch).length
			: matchCount;
	} else {
		shownCount = truncation.outputLines;
	}
	const truncated = limitHit || truncation.truncated;
	const next = limitHit ? `limit=${limit * 2}` : truncation.truncated && mode === "content" ? "mode=files" : undefined;
	let output = truncation.content;
	if (linesTruncated) {
		output += `\n\n[Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read to see full lines.]`;
	}
	return finalizeObservation({
		tool: ToolNames.Grep,
		unit: MODE_UNITS[mode],
		output,
		// Offload only when the byte cap cut collected content; a bare match
		// limit continues via `next`, and the offload would duplicate the body.
		...(truncation.truncated ? { fullOutput } : {}),
		shownCount,
		totalCount: limitHit ? null : matchCount,
		truncated,
		...(next !== undefined ? { next } : {}),
		reservation,
		...(options ? { options } : {}),
	});
}

function sanitizeMatchText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
}

interface RgSearchInput {
	rgPath: string;
	mode: GrepMode;
	pattern: string;
	searchPath: string;
	isDirectory: boolean;
	glob?: string;
	ignoreCase: boolean;
	literal: boolean;
	context: number;
	limit: number;
	includeIgnored: boolean;
	reservation: ObservationReservation;
	options: ToolInvokeOptions | undefined;
}

function buildRgArgs(input: RgSearchInput): string[] {
	const args: string[] = [];
	if (input.mode === "content") {
		args.push("--json", "--line-number");
		if (input.context > 0) args.push("-C", String(input.context));
	} else if (input.mode === "files") {
		args.push("--files-with-matches");
	} else {
		args.push("--count");
	}
	args.push("--color=never", ...rgIgnoreArgs(input.searchPath, input.includeIgnored));
	if (input.ignoreCase) args.push("--ignore-case");
	if (input.literal) args.push("--fixed-strings");
	if (input.glob) args.push("--glob", input.glob);
	args.push("--", input.pattern, input.searchPath);
	return args;
}

async function runRipgrep(input: RgSearchInput): Promise<ToolResult> {
	const rendered: RenderedLine[] = [];
	let matchCount = 0;
	let limitHit = false;
	let linesTruncated = false;
	const relPath = (filePath: string): string => formatPath(filePath, input.searchPath, input.isDirectory);

	const onContentLine = (line: string, stop: () => void): void => {
		if (line.length === 0) return;
		let event: unknown;
		try {
			event = JSON.parse(line) as unknown;
		} catch {
			return;
		}
		if (!event || typeof event !== "object") return;
		const type = (event as { type?: unknown }).type;
		if (type !== "match" && type !== "context") return;
		const data = (event as { data?: Record<string, unknown> }).data;
		const filePath = (data?.path as { text?: unknown } | undefined)?.text;
		const lineNumber = data?.line_number;
		const lineText = (data?.lines as { text?: unknown } | undefined)?.text;
		if (typeof filePath !== "string" || typeof lineNumber !== "number" || typeof lineText !== "string") return;
		const { text, wasTruncated } = truncateLine(sanitizeMatchText(lineText));
		if (wasTruncated) linesTruncated = true;
		const isMatch = type === "match";
		rendered.push({
			text: isMatch ? `${relPath(filePath)}:${lineNumber}: ${text}` : `${relPath(filePath)}-${lineNumber}- ${text}`,
			isMatch,
		});
		if (isMatch) {
			matchCount += 1;
			if (matchCount >= input.limit) {
				limitHit = true;
				stop();
			}
		}
	};

	const onListLine = (line: string, stop: () => void): void => {
		const trimmed = line.replace(/\r$/, "");
		if (trimmed.length === 0) return;
		let text: string;
		if (input.mode === "count") {
			const sep = trimmed.lastIndexOf(":");
			text = sep > 0 ? `${relPath(trimmed.slice(0, sep))}:${trimmed.slice(sep + 1)}` : trimmed;
		} else {
			text = relPath(trimmed);
		}
		rendered.push({ text, isMatch: true });
		matchCount += 1;
		if (matchCount >= input.limit) {
			limitHit = true;
			stop();
		}
	};

	const result = await spawnLineStream(input.rgPath, buildRgArgs(input), {
		...(input.options?.signal ? { signal: input.options.signal } : {}),
		onLine: input.mode === "content" ? onContentLine : onListLine,
	});
	if (result.aborted) return { kind: "error", message: "grep: operation aborted" };
	if (result.timedOut) {
		return {
			kind: "error",
			message: `grep: rg timed out after ${SEARCH_SPAWN_TIMEOUT_MS / 1000}s. Narrow the pattern, path, or glob, lower context, or use mode=files.`,
		};
	}
	if (result.spawnError !== null) return { kind: "error", message: `grep: failed to run rg: ${result.spawnError}` };
	if (!result.stoppedEarly && result.exitCode !== 0 && result.exitCode !== 1) {
		return { kind: "error", message: `grep: ${result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`}` };
	}
	return renderGrepResult({
		mode: input.mode,
		lines: rendered,
		matchCount,
		limitHit,
		limit: input.limit,
		linesTruncated,
		reservation: input.reservation,
		options: input.options,
	});
}

function buildMatchRegex(
	pattern: string,
	literal: boolean,
	ignoreCase: boolean,
): { ok: true; regex: RegExp } | { ok: false; message: string } {
	const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
	try {
		return { ok: true, regex: new RegExp(source, ignoreCase ? "i" : "") };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, message: `grep: invalid pattern: ${message}` };
	}
}

function looksBinary(buffer: Buffer): boolean {
	const probe = Math.min(buffer.length, 1024);
	for (let i = 0; i < probe; i += 1) {
		if (buffer[i] === 0) return true;
	}
	return false;
}

interface FallbackSearchInput {
	mode: GrepMode;
	pattern: string;
	searchPath: string;
	isDirectory: boolean;
	glob?: string;
	ignoreCase: boolean;
	literal: boolean;
	context: number;
	limit: number;
	includeIgnored: boolean;
	reservation: ObservationReservation;
	options: ToolInvokeOptions | undefined;
}

/**
 * Pure-Node content search used when ripgrep is not on PATH (offline/weak
 * nodes). Bounded: skips the shared ignored-dir set, files over 20MB, and
 * binary files; stops at the match limit. Context lines come from the
 * already-in-memory file content, never a second read. Aggregates the same
 * three mode shapes as the rg path.
 */
function fallbackGrep(input: FallbackSearchInput): ToolResult {
	const built = buildMatchRegex(input.pattern, input.literal, input.ignoreCase);
	if (!built.ok) return { kind: "error", message: built.message };
	const regex = built.regex;
	let globMatcher: RegExp | null = null;
	if (input.glob) {
		const normalized = input.glob.includes("/") ? input.glob : `**/${input.glob}`;
		try {
			globMatcher = compileGlobRegex(normalized);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `grep: ${message}` };
		}
	}
	const ignored = fallbackIgnoredDirs(input.includeIgnored);
	const rendered: RenderedLine[] = [];
	let matchCount = 0;
	let limitHit = false;
	let linesTruncated = false;
	const signal = input.options?.signal;

	const pushLine = (text: string, isMatch: boolean): void => {
		const truncatedLine = truncateLine(text);
		if (truncatedLine.wasTruncated) linesTruncated = true;
		rendered.push({ text: truncatedLine.text, isMatch });
	};

	const searchFile = (filePath: string): void => {
		if (limitHit) return;
		let buffer: Buffer;
		try {
			const stat = statSync(filePath);
			if (!stat.isFile() || stat.size > FALLBACK_MAX_FILE_BYTES) return;
			buffer = readFileSync(filePath);
		} catch {
			return;
		}
		if (looksBinary(buffer)) return;
		const lines = buffer.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
		const rel = formatPath(filePath, input.searchPath, input.isDirectory);
		let fileMatches = 0;
		for (let i = 0; i < lines.length; i += 1) {
			const lineText = lines[i] ?? "";
			regex.lastIndex = 0;
			if (!regex.test(lineText)) continue;
			fileMatches += 1;
			if (input.mode === "files") {
				rendered.push({ text: rel, isMatch: true });
				matchCount += 1;
				if (matchCount >= input.limit) limitHit = true;
				return;
			}
			if (input.mode === "content") {
				const start = input.context > 0 ? Math.max(1, i + 1 - input.context) : i + 1;
				const end = input.context > 0 ? Math.min(lines.length, i + 1 + input.context) : i + 1;
				for (let current = start; current <= end; current += 1) {
					const text = lines[current - 1] ?? "";
					if (current === i + 1) pushLine(`${rel}:${current}: ${text}`, true);
					else pushLine(`${rel}-${current}- ${text}`, false);
				}
				matchCount += 1;
				if (matchCount >= input.limit) {
					limitHit = true;
					return;
				}
			}
		}
		if (input.mode === "count" && fileMatches > 0) {
			rendered.push({ text: `${rel}:${fileMatches}`, isMatch: true });
			matchCount += 1;
			if (matchCount >= input.limit) limitHit = true;
		}
	};

	const walk = (dir: string): void => {
		if (limitHit || signal?.aborted) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			return;
		}
		for (const entry of entries) {
			if (limitHit || signal?.aborted) return;
			const absPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (ignored.has(entry.name)) continue;
				walk(absPath);
				continue;
			}
			if (!entry.isFile()) continue;
			if (globMatcher) {
				const relPath = normalizeGlobInput(relative(input.searchPath, absPath));
				if (!globMatcher.test(relPath)) continue;
			}
			searchFile(absPath);
		}
	};

	if (input.isDirectory) walk(input.searchPath);
	else searchFile(input.searchPath);
	if (signal?.aborted) return { kind: "error", message: "grep: operation aborted" };
	return renderGrepResult({
		mode: input.mode,
		lines: rendered,
		matchCount,
		limitHit,
		limit: input.limit,
		linesTruncated,
		reservation: input.reservation,
		options: input.options,
	});
}

export const grepTool: ToolSpec = {
	name: ToolNames.Grep,
	description: `Search file contents with ripgrep. mode=content (default) returns matching lines with paths and line numbers, mode=files returns only matching file paths, mode=count returns per-file match counts. Respects .gitignore and skips generated dirs unless include_ignored=true. Capped at ${DEFAULT_LIMIT} matches by default; truncated results say how to continue and where the full output was saved.`,
	parameters: Type.Object({
		pattern: Type.String({ description: "Search pattern (regex by default)." }),
		path: Type.Optional(Type.String({ description: "Directory or file to search." })),
		mode: Type.Optional(StringEnum(["content", "files", "count"], { description: "Output mode (default content)." })),
		glob: Type.Optional(Type.String({ description: "Filter files by glob, e.g. '*.ts'." })),
		ignore_case: Type.Optional(Type.Boolean({ description: "Case-insensitive search." })),
		literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal text." })),
		context: Type.Optional(Type.Number({ description: "Context lines per match (mode=content)." })),
		limit: Type.Optional(Type.Number({ description: `Max matches (default ${DEFAULT_LIMIT}).` })),
		include_ignored: Type.Optional(Type.Boolean({ description: "Search gitignored and generated paths too." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args, options): Promise<ToolResult> {
		const pattern = typeof args.pattern === "string" && args.pattern.length > 0 ? args.pattern : null;
		if (!pattern) return { kind: "error", message: "grep: missing pattern argument" };
		// Reject an oversized pattern before spawning rg or compiling a fallback
		// regex; an over-MAX_ARG_STRLEN argv entry would otherwise throw spawn E2BIG.
		const patternSize = validateSearchPatternSize(pattern);
		if (!patternSize.ok) return { kind: "error", message: `grep: ${patternSize.message}` };
		const mode: GrepMode = args.mode === "files" || args.mode === "count" ? args.mode : "content";
		if (args.mode !== undefined && args.mode !== "content" && args.mode !== "files" && args.mode !== "count") {
			return { kind: "error", message: `grep: mode must be content, files, or count; got '${String(args.mode)}'` };
		}
		const context = parseContext(args.context);
		if (context === null) return { kind: "error", message: "grep: context must be a non-negative number" };
		const searchPath = resolveReadPath(typeof args.path === "string" && args.path.length > 0 ? args.path : ".");
		const stat = statIsDirectory(searchPath);
		if (!stat.ok) return { kind: "error", message: `grep: ${stat.message}` };
		const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_LIMIT;
		const glob = typeof args.glob === "string" && args.glob.length > 0 ? args.glob : undefined;
		const ignoreCase = args.ignore_case === true;
		const literal = args.literal === true;
		const includeIgnored = args.include_ignored === true;
		const selfCap = mode === "content" ? OBSERVE_SELF_CAPS.grepContent : OBSERVE_SELF_CAPS.grepFilesCount;
		const reservation = reserveObservation(selfCap, options);
		if (reservation.exhausted) {
			return observationBudgetExhausted({
				tool: ToolNames.Grep,
				unit: MODE_UNITS[mode],
				reservation,
				subject: `pattern '${pattern}'`,
				hint: "Use a narrower pattern, mode=files, or continue in a follow-up turn.",
			});
		}
		const shared = {
			mode,
			pattern,
			searchPath,
			isDirectory: stat.isDirectory,
			...(glob !== undefined ? { glob } : {}),
			ignoreCase,
			literal,
			context,
			limit,
			includeIgnored,
			reservation,
			options,
		};
		// grep yields on the rg subprocess below, so charge the shared turn pool
		// up front and refund the unused slice at finalize; a concurrent OBSERVE
		// sibling that reserves mid-search must see this spend.
		commitObservationReservation(reservation);
		try {
			const rgPath = resolveRgBinary();
			// `return await` so the finally refund runs only after the search has
			// finalized (or errored), never while its promise is still pending.
			if (rgPath) return await runRipgrep({ rgPath, ...shared });
			// rg absent (offline/weak node): degrade to a bounded pure-Node search
			// instead of failing content search outright.
			return fallbackGrep(shared);
		} finally {
			releaseObservation(reservation);
		}
	},
};
