/**
 * The maintainers' private intake store for report bundles (R-20): where a pulled bundle lives, how long, and how it
 * leaves on request. The layout is the one the dataset exporter reads:
 *
 *   <store>/index.jsonl                one line per bundle: ids, hashes, consent and status; never bundle bytes
 *   <store>/exclusions.txt             report ids that never enter a dataset
 *   <store>/bundles/<reportId>.tar.gz  the verified bundle, 0600; bundles/.gitignore ignores everything in it
 *
 * The index may be kept in a private git repository; the bundle bytes never are, so deleting a file deletes the bundle.
 */
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { type BundleContent, type ConsentScope, verifyReceivedBundle } from "./bundle.js";
import { REPORT_ID } from "./draft.js";
import { bundleDeletionComment } from "./transport.js";

/** A debug-only bundle is deleted once its issue has been closed this long. */
export const INTAKE_CLOSED_RETENTION_DAYS = 90;
/** A debug-only bundle is deleted at this age whatever its issue's state. Dataset-scoped bundles are kept. */
export const INTAKE_MAX_AGE_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

export type IntakeStatus = "held" | "expired" | "forgotten";

export interface IntakeIndexLine {
	reportId: string;
	shareId: string;
	/** The issue whose block points at the bundle; null for a discussion. */
	issue: number | null;
	receivedOn: string;
	clioCoder: string;
	keyId: string;
	sha256: string;
	scopes: ConsentScope[];
	content: BundleContent;
	status: IntakeStatus;
	/** When the age rule deletes it; null for a bundle the dataset scope keeps. */
	expiresOn: string | null;
}

export type IntakeOutcome =
	| { kind: "stored"; line: IntakeIndexLine; acknowledgment: string }
	| { kind: "indexed"; line: IntakeIndexLine }
	| { kind: "excluded"; reportId: string }
	| { kind: "refused"; reason: string; resend: string };

const day = (date: Date) => date.toISOString().slice(0, 10);
const indexPath = (store: string) => join(store, "index.jsonl");
const exclusionsPath = (store: string) => join(store, "exclusions.txt");
const bundlePath = (store: string, reportId: string) => join(store, "bundles", `${reportId}.tar.gz`);

function lines(path: string): string[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** The store's directories at 0700, with bundles/ ignored by git whatever repository the store sits in. */
function ensureIntakeStore(store: string): void {
	mkdirSync(join(store, "bundles"), { recursive: true, mode: 0o700 });
	// A bundles/ made before the store existed keeps its mode; the bytes in it are private whoever made it.
	chmodSync(join(store, "bundles"), 0o700);
	const ignore = join(store, "bundles", ".gitignore");
	if (!existsSync(ignore)) writeFileSync(ignore, "# Bundle bytes never enter git (R-20).\n*\n", { mode: 0o600 });
}

export function readIntakeIndex(store: string): IntakeIndexLine[] {
	return lines(indexPath(store)).map((line) => JSON.parse(line) as IntakeIndexLine);
}

function writeIntakeIndex(store: string, index: ReadonlyArray<IntakeIndexLine>): void {
	safeResourceWrite(indexPath(store), index.map((line) => `${JSON.stringify(line)}\n`).join(""), { mode: 0o600 });
}

function exclude(store: string, reportId: string): void {
	if (!lines(exclusionsPath(store)).includes(reportId))
		appendFileSync(exclusionsPath(store), `${reportId}\n`, { mode: 0o600 });
}

/**
 * Keep a received bundle: verified from its own bytes first, then written to bundles/ at 0600 and indexed. A bundle
 * that fails a check, or whose report was forgotten, is not stored. The acknowledgment is for the maintainer to post.
 */
export function intakeReportBundle(
	store: string,
	bytes: Buffer,
	meta: { shareId: string; issue: number | null; keyId: string; now?: Date },
): IntakeOutcome {
	let envelope: ReturnType<typeof verifyReceivedBundle>;
	try {
		envelope = verifyReceivedBundle(bytes);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			kind: "refused",
			reason,
			resend: `The diagnostic bundle in ${meta.shareId} could not be verified (${reason}), so it was not kept. Please send it again.`,
		};
	}
	const reportId = envelope.reportId;
	ensureIntakeStore(store);
	if (lines(exclusionsPath(store)).includes(reportId)) return { kind: "excluded", reportId };
	const index = readIntakeIndex(store);
	const known = index.find((line) => line.reportId === reportId);
	if (known !== undefined) return { kind: "indexed", line: known };
	const now = meta.now ?? new Date();
	const scopes = envelope.consent.scopes;
	const debugOnly = scopes.length === 1 && scopes[0] === "debug";
	const line: IntakeIndexLine = {
		reportId,
		shareId: meta.shareId,
		issue: meta.issue,
		receivedOn: day(now),
		clioCoder: envelope.environment.clioCoder,
		keyId: meta.keyId,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		scopes,
		content: envelope.consent.content,
		status: "held",
		expiresOn: debugOnly ? day(new Date(now.getTime() + INTAKE_MAX_AGE_DAYS * DAY_MS)) : null,
	};
	safeResourceWrite(bundlePath(store, reportId), bytes, { mode: 0o600 });
	writeIntakeIndex(store, [...index, line]);
	return {
		kind: "stored",
		line,
		acknowledgment: `Bundle received and verified (report ${envelope.kind}, consent: ${scopes.join(", ")}). You can delete the gist now. Thank you.`,
	};
}

/**
 * Delete every held debug-only bundle whose issue was closed {@link INTAKE_CLOSED_RETENTION_DAYS} days ago or that is
 * {@link INTAKE_MAX_AGE_DAYS} days old, and mark it expired. `closedAt` maps an issue number to its ISO closing time.
 */
export function sweepIntakeStore(
	store: string,
	closedAt: ReadonlyMap<number, string>,
	now: Date = new Date(),
): string[] {
	const index = readIntakeIndex(store);
	const expired: string[] = [];
	for (const line of index) {
		if (line.status !== "held" || line.scopes.length !== 1 || line.scopes[0] !== "debug") continue;
		const closed = line.issue === null ? undefined : closedAt.get(line.issue);
		const closedFor = closed === undefined ? Number.NaN : now.getTime() - Date.parse(closed);
		const age = now.getTime() - Date.parse(`${line.receivedOn}T00:00:00Z`);
		if (closedFor >= INTAKE_CLOSED_RETENTION_DAYS * DAY_MS || age >= INTAKE_MAX_AGE_DAYS * DAY_MS) {
			rmSync(bundlePath(store, line.reportId), { force: true });
			line.status = "expired";
			expired.push(line.reportId);
		}
	}
	if (expired.length > 0) writeIntakeIndex(store, index);
	return expired;
}

/**
 * Forget a report on request: delete its bundle, mark it forgotten and exclude it from every later pull and dataset.
 * An id the store never held is excluded too. The confirmation is for the maintainer to post; nothing is posted here.
 */
export function forgetIntakeBundle(store: string, reportId: string): { held: boolean; confirmation: string } {
	if (!REPORT_ID.test(reportId)) throw new Error(`not a report id: ${reportId}`);
	ensureIntakeStore(store);
	rmSync(bundlePath(store, reportId), { force: true });
	const index = readIntakeIndex(store);
	const line = index.find((entry) => entry.reportId === reportId);
	if (line !== undefined && line.status !== "forgotten") {
		line.status = "forgotten";
		writeIntakeIndex(store, index);
	}
	exclude(store, reportId);
	return {
		held: line !== undefined,
		confirmation: `The diagnostic bundle for report ${reportId} is deleted and stays out of every dataset.`,
	};
}

/** The report id a comment asks to forget, when it is exactly the comment `report forget` posts; else null. */
export function bundleDeletionRequest(body: string): string | null {
	const text = body.trim();
	const id = /(rpt_\S+)\.$/u.exec(text)?.[1];
	return id !== undefined && REPORT_ID.test(id) && bundleDeletionComment(id) === text ? id : null;
}
