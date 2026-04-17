import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { clioDataDir } from "../../core/xdg.js";

/**
 * NDJSON audit writer. One line per classified tool call, fsynced after each
 * write, file rotated on local-date rollover. Write errors never throw back to
 * the caller because safety must not kill the hot path; they are logged to
 * stderr with a `[clio:audit]` prefix for post-mortem review.
 */

export interface AuditRecord {
	ts: string;
	correlationId: string;
	tool: string;
	actionClass: string;
	decision: "allowed" | "blocked" | "classified";
	mode?: string;
	reasons: ReadonlyArray<string>;
	args?: unknown;
}

export interface AuditWriter {
	write(record: AuditRecord): void;
	close(): Promise<void>;
}

const REDACT_KEY_RE = /(password|token|secret|key|auth|credential)/i;
const MAX_STRING_LEN = 200;

function localDateString(d: Date): string {
	// Local-date YYYY-MM-DD. Intl.DateTimeFormat with en-CA emits ISO ordering
	// in local time, which is simpler than composing the parts manually.
	const fmt = new Intl.DateTimeFormat("en-CA", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	return fmt.format(d);
}

function newCorrelationId(): string {
	// 8 bytes -> base36 -> pad to 12 to keep the id length stable.
	const n = BigInt(`0x${randomBytes(8).toString("hex")}`);
	const raw = n.toString(36);
	if (raw.length >= 12) return raw.slice(0, 12);
	return raw.padStart(12, "0");
}

function redactString(s: string): string {
	if (s.length <= MAX_STRING_LEN) return s;
	const truncated = s.length - MAX_STRING_LEN;
	return `${s.slice(0, MAX_STRING_LEN)}… [truncated ${truncated} chars]`;
}

function redactArgs(value: unknown, depth = 0): unknown {
	if (depth > 8) return "[redacted:depth]";
	if (value == null) return value;
	if (typeof value === "string") return redactString(value);
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map((item) => redactArgs(item, depth + 1));
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (REDACT_KEY_RE.test(k)) {
				out[k] = "[redacted]";
				continue;
			}
			out[k] = redactArgs(v, depth + 1);
		}
		return out;
	}
	return String(value);
}

export function buildAuditRecord(input: {
	tool: string;
	classification: { actionClass: string; reasons: ReadonlyArray<string> };
	decision: "allowed" | "blocked" | "classified";
	mode?: string;
	args?: unknown;
	now?: Date;
}): AuditRecord {
	const now = input.now ?? new Date();
	const record: AuditRecord = {
		ts: now.toISOString(),
		correlationId: newCorrelationId(),
		tool: input.tool,
		actionClass: input.classification.actionClass,
		decision: input.decision,
		reasons: input.classification.reasons,
	};
	if (input.mode !== undefined) record.mode = input.mode;
	if (input.args !== undefined) record.args = redactArgs(input.args);
	return record;
}

interface OpenFile {
	fd: number;
	date: string;
	path: string;
}

function logAuditError(err: unknown, path?: string): void {
	const msg = err instanceof Error ? err.message : String(err);
	const where = path ? ` (${path})` : "";
	process.stderr.write(`[clio:audit] ${msg}${where}\n`);
}

export function openAuditWriter(opts?: { dateFn?: () => Date }): AuditWriter {
	const dateFn = opts?.dateFn ?? (() => new Date());
	let current: OpenFile | null = null;
	let closed = false;

	function closeCurrent(): void {
		if (current === null) return;
		try {
			fsyncSync(current.fd);
		} catch (err) {
			logAuditError(err, current.path);
		}
		try {
			closeSync(current.fd);
		} catch (err) {
			logAuditError(err, current.path);
		}
		current = null;
	}

	function ensureFor(date: string): OpenFile | null {
		if (current !== null && current.date === date) return current;
		if (current !== null) closeCurrent();
		try {
			const dir = join(clioDataDir(), "audit");
			mkdirSync(dir, { recursive: true });
			const filePath = join(dir, `${date}.jsonl`);
			const fd = openSync(filePath, "a");
			current = { fd, date, path: filePath };
			return current;
		} catch (err) {
			logAuditError(err);
			return null;
		}
	}

	return {
		write(record: AuditRecord): void {
			if (closed) return;
			try {
				const date = localDateString(dateFn());
				const handle = ensureFor(date);
				if (handle === null) return;
				const line = `${JSON.stringify(record)}\n`;
				writeSync(handle.fd, line);
				fsyncSync(handle.fd);
			} catch (err) {
				logAuditError(err, current?.path);
			}
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			closeCurrent();
		},
	};
}
