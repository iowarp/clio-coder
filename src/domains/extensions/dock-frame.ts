import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { visibleWidth } from "../../engine/tui-primitives.js";

/** What the host writes; the viewer trusts only validated, bounded frames. */
export interface ExtensionDockFrame {
	version: 1;
	seq: number;
	extensionId: string;
	title: string;
	width: number;
	lines: string[];
	targets: Array<{ row: number; col: number; width: number; action: string; key?: string; hotkey?: string }>;
}

export type ExtensionDockTap =
	| { kind: "press"; action: string; key?: string; seq: number }
	| { kind: "size"; width: number; rows: number }
	| { kind: "hide" };

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CELLS = 4096;
// C0, DEL, C1 and Unicode line separators cannot be terminal data here.
// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject terminal controls at the frame boundary.
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR is the only allowed terminal escape.
const SGR = /\x1b\[[\d;:]*m/g;

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function plain(value: unknown, max: number, empty = false): value is string {
	return typeof value === "string" && (empty || value.length > 0) && value.length <= max && !CONTROL.test(value);
}
function fields(value: Record<string, unknown>, names: string[]): boolean {
	return Object.keys(value).every((key) => names.includes(key));
}
function frameValid(value: unknown): value is ExtensionDockFrame {
	if (!object(value) || !fields(value, ["version", "seq", "extensionId", "title", "width", "lines", "targets"]))
		return false;
	if (
		value.version !== 1 ||
		!integer(value.seq, 1, Number.MAX_SAFE_INTEGER) ||
		!plain(value.extensionId, 120) ||
		!plain(value.title, 200, true) ||
		!integer(value.width, 1, MAX_CELLS)
	)
		return false;
	if (
		!Array.isArray(value.lines) ||
		value.lines.length > 400 ||
		!Array.isArray(value.targets) ||
		value.targets.length > 40000
	)
		return false;
	const width = value.width;
	const lines = value.lines;
	if (
		!lines.every(
			(line: unknown) =>
				typeof line === "string" &&
				line.length <= 16384 &&
				!CONTROL.test(line.replace(SGR, "")) &&
				visibleWidth(line) <= width,
		)
	)
		return false;
	return value.targets.every(
		(target: unknown) =>
			object(target) &&
			fields(target, ["row", "col", "width", "action", "key", "hotkey"]) &&
			integer(target.row, 0, lines.length - 1) &&
			integer(target.col, 0, width - 1) &&
			integer(target.width, 1, width - target.col) &&
			plain(target.action, 120) &&
			(target.key === undefined || plain(target.key, 120)) &&
			(target.hotkey === undefined || plain(target.hotkey, 32)) &&
			JSON.stringify({ kind: "press", action: target.action, key: target.key, seq: Number.MAX_SAFE_INTEGER }).length <=
				512,
	);
}

/** Hash session ids so they cannot escape the dock directory; null has its own namespace. */
export function extensionDockPaths(stateDir: string, sessionId: string | null): { frameFile: string; tapFile: string } {
	const stem = createHash("sha256").update(JSON.stringify(sessionId)).digest("hex");
	const dir = join(stateDir, "extensions", ".dock");
	return { frameFile: join(dir, `${stem}.json`), tapFile: join(dir, `${stem}.taps`) };
}

export function writeExtensionDockFrame(file: string, frame: ExtensionDockFrame): void {
	if (!frameValid(frame)) throw new Error("invalid extension dock frame");
	const encoded = `${JSON.stringify(frame)}\n`;
	if (Buffer.byteLength(encoded) > MAX_FILE_BYTES) throw new Error("extension dock frame exceeds 8 MiB");
	const previous = readExtensionDockFrame(file);
	if (previous.ok && frame.seq <= previous.frame.seq) throw new Error("extension dock frame sequence must increase");
	safeResourceWrite(file, encoded);
}

export function readExtensionDockFrame(
	file: string,
): { ok: true; frame: ExtensionDockFrame } | { ok: false; reason: string } {
	try {
		if (statSync(file).size > MAX_FILE_BYTES) return { ok: false, reason: "extension dock frame exceeds 8 MiB" };
		const encoded = readFileSync(file);
		if (encoded.length > MAX_FILE_BYTES) return { ok: false, reason: "extension dock frame exceeds 8 MiB" };
		const value: unknown = JSON.parse(encoded.toString("utf8"));
		return frameValid(value) ? { ok: true, frame: value } : { ok: false, reason: "invalid extension dock frame" };
	} catch {
		return { ok: false, reason: "extension dock frame is missing or unreadable" };
	}
}

export function decodeDockTap(line: string): ExtensionDockTap | null {
	if (line.length > 512) return null;
	try {
		const tap: unknown = JSON.parse(line);
		if (!object(tap)) return null;
		if (tap.kind === "hide" && fields(tap, ["kind"])) return { kind: "hide" };
		if (
			tap.kind === "size" &&
			fields(tap, ["kind", "width", "rows"]) &&
			integer(tap.width, 1, MAX_CELLS) &&
			integer(tap.rows, 1, MAX_CELLS)
		)
			return { kind: "size", width: tap.width, rows: tap.rows };
		if (
			tap.kind === "press" &&
			fields(tap, ["kind", "action", "key", "seq"]) &&
			plain(tap.action, 120) &&
			integer(tap.seq, 1, Number.MAX_SAFE_INTEGER) &&
			(tap.key === undefined || plain(tap.key, 120))
		) {
			return { kind: "press", action: tap.action, seq: tap.seq, ...(tap.key === undefined ? {} : { key: tap.key }) };
		}
	} catch {
		// A partial append or foreign write is not a tap.
	}
	return null;
}

/** One JSON line, including its terminating newline. */
export function encodeDockTap(tap: ExtensionDockTap): string {
	const encoded = JSON.stringify(tap);
	if (decodeDockTap(encoded) === null) throw new Error("invalid extension dock tap");
	return `${encoded}\n`;
}
