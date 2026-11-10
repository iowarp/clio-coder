import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { REPORT_ID } from "./draft.js";
import { reportsDirectory } from "./store.js";
import type { ReportKind } from "./vocabulary.js";

export const OUTBOX_STATES = ["draft", "sending", "sent", "opened", "written", "withdrawn"] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

export interface OutboxEntry {
	kind: ReportKind;
	title: string;
	route: "issue" | "discussion" | "security";
	transport: "gh" | "browser" | "file";
	state: OutboxState;
	url: string | null;
	number: number | null;
	sentAt: string | null;
	consent: string;
	bundle: string | null;
	credit: boolean;
	replyCheck: string | null;
	lastSeen: { state: string; comments: number; at: string } | null;
	thanked: boolean;
}

interface OutboxDocument {
	version: 1;
	reports: Record<string, OutboxEntry>;
}

/** Sends past which the caller warns; GitHub's own abuse limits are far higher, these protect the maintainers. */
export const REPORT_RATE_LIMITS = { day: 3, month: 10 } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export function reportOutboxPath(stateDir: string): string {
	return join(reportsDirectory(stateDir), "outbox.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOutbox(text: string): OutboxDocument {
	const value: unknown = JSON.parse(text);
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.reports))
		throw new Error("expected {version: 1, reports: {...}}");
	for (const [id, entry] of Object.entries(value.reports)) {
		if (
			!REPORT_ID.test(id) ||
			!isRecord(entry) ||
			typeof entry.title !== "string" ||
			!(OUTBOX_STATES as ReadonlyArray<unknown>).includes(entry.state)
		)
			throw new Error(`invalid outbox entry ${id}`);
	}
	return value as unknown as OutboxDocument;
}

function readDocument(path: string): OutboxDocument | null {
	try {
		return parseOutbox(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** Every entry, keyed by report id. A damaged outbox throws: it records what was filed and is not overwritten. */
export function readOutbox(stateDir: string): Record<string, OutboxEntry> {
	return readDocument(reportOutboxPath(stateDir))?.reports ?? {};
}

export function outboxEntry(stateDir: string, id: string): OutboxEntry | null {
	return readOutbox(stateDir)[id] ?? null;
}

function defaults(kind: ReportKind, title: string): OutboxEntry {
	return {
		kind,
		title,
		route: kind === "question" ? "discussion" : "issue",
		transport: "file",
		state: "draft",
		url: null,
		number: null,
		sentAt: null,
		consent: "none",
		bundle: null,
		credit: false,
		replyCheck: null,
		lastSeen: null,
		thanked: false,
	};
}

/** Writes one entry under the store's lock; fields not named keep their value. */
export function updateOutbox(
	stateDir: string,
	id: string,
	patch: Partial<OutboxEntry> & Pick<OutboxEntry, "kind" | "title">,
): OutboxEntry {
	if (!REPORT_ID.test(id)) throw new Error(`not a report id: ${id}`);
	const path = reportOutboxPath(stateDir);
	return withStateFileLockSync(path, () => {
		const document = readDocument(path) ?? { version: 1, reports: {} };
		const entry: OutboxEntry = { ...defaults(patch.kind, patch.title), ...document.reports[id], ...patch };
		document.reports[id] = entry;
		safeResourceWrite(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
		return entry;
	});
}

export interface RecentSends {
	day: number;
	month: number;
	/** Set when the next send would pass a limit; the caller shows it and the reporter decides. */
	warning: string | null;
}

/** Reports filed or opened for filing recently. A warning, never a refusal. */
export function recentSends(stateDir: string, now = new Date()): RecentSends {
	let day = 0;
	let month = 0;
	for (const entry of Object.values(readOutbox(stateDir))) {
		if (entry.sentAt === null || (entry.state !== "sent" && entry.state !== "opened")) continue;
		const age = now.getTime() - Date.parse(entry.sentAt);
		if (!(age >= 0)) continue;
		if (age < DAY_MS) day += 1;
		if (age < 30 * DAY_MS) month += 1;
	}
	const warning =
		day >= REPORT_RATE_LIMITS.day
			? `${day} reports sent in the last 24 hours. Consider adding to one of them instead.`
			: month >= REPORT_RATE_LIMITS.month
				? `${month} reports sent in the last 30 days. Consider adding to one of them instead.`
				: null;
	return { day, month, warning };
}
