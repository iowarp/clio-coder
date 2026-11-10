import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { withStateFileLockSync } from "../../../core/state-file-lock.js";
import { reportsDirectory } from "../store.js";
import { SHARE_ID, type ShareKind } from "./seal.js";

/** Clio deletes the gists of its own shares this long after sending them. */
export const SHARE_RETENTION_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One upload this machine made: enough to list it, point at it and delete it. Never any share content. */
export interface ShareReceipt {
	kind: ShareKind;
	gistId: string;
	sentAt: string;
	consent: string;
	profile: string;
	reportId?: string;
	url?: string;
	deletedAt: string | null;
}

interface ShareReceiptsDocument {
	version: 1;
	shares: Record<string, ShareReceipt>;
}

export function shareReceiptsPath(stateDir: string): string {
	return join(reportsDirectory(stateDir), "shares.json");
}

function readDocument(path: string): ShareReceiptsDocument | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const value = JSON.parse(text) as Partial<ShareReceiptsDocument>;
	if (value.version !== 1 || typeof value.shares !== "object" || value.shares === null)
		throw new Error(`${path}: expected {version: 1, shares: {...}}`);
	return value as ShareReceiptsDocument;
}

/** Every share this machine sent, keyed by share id. A damaged file throws: it is the only record of what to delete. */
export function readShareReceipts(stateDir: string): Record<string, ShareReceipt> {
	return readDocument(shareReceiptsPath(stateDir))?.shares ?? {};
}

export function updateShareReceipt(stateDir: string, shareId: string, patch: Partial<ShareReceipt>): ShareReceipt {
	if (!SHARE_ID.test(shareId)) throw new Error(`not a share id: ${shareId}`);
	const path = shareReceiptsPath(stateDir);
	return withStateFileLockSync(path, () => {
		const document = readDocument(path) ?? { version: 1, shares: {} };
		const previous = document.shares[shareId];
		if (previous === undefined && (patch.kind === undefined || patch.gistId === undefined || patch.sentAt === undefined))
			throw new Error(`no share ${shareId}`);
		const receipt = {
			consent: "debug",
			profile: "report",
			deletedAt: null,
			...previous,
			...patch,
		} as ShareReceipt;
		document.shares[shareId] = receipt;
		safeResourceWrite(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
		return receipt;
	});
}

/** The live share a report carries, if any. */
export function reportShare(stateDir: string, reportId: string): { shareId: string; receipt: ShareReceipt } | null {
	for (const [shareId, receipt] of Object.entries(readShareReceipts(stateDir)))
		if (receipt.reportId === reportId && receipt.deletedAt === null) return { shareId, receipt };
	return null;
}

/** Live shares sent more than {@link SHARE_RETENTION_DAYS} ago. */
export function expiredShares(stateDir: string, now = new Date()): string[] {
	const cutoff = now.getTime() - SHARE_RETENTION_DAYS * DAY_MS;
	return Object.entries(readShareReceipts(stateDir))
		.filter(([, receipt]) => receipt.deletedAt === null && Date.parse(receipt.sentAt) < cutoff)
		.map(([shareId]) => shareId);
}
