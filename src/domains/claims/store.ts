import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { clioProjectRoot } from "../../core/project-root.js";
import { fsyncDirectory } from "../../core/safe-resource-write.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";
import { claimRecordId } from "./capture.js";
import { CLAIM_KINDS, CLAIM_RECORD_VERSION, type ClaimRecord } from "./types.js";

/**
 * The claims log: `<stateDir>/claims/<sha256(project root)>.jsonl`, one record per line, append-only (#406).
 *
 * The project root is the realpath of the enclosing repository root, the key workspace trust already uses
 * (`clioProjectRoot` over the realpath), so a session in a subdirectory reads and writes the same log and no fourth
 * project key exists. The log lives in Clio's state directory rather than the repository, so a cloned repository
 * cannot ship claims, the same reason trust records and session ledgers live there.
 *
 * A line is appended in place under the file's state lock and fsynced, the way the fleet event journal appends. A
 * whole-file `safeResourceWrite` per claim would make every capture cost the size of the log; an append cannot lose an
 * earlier line, and a line torn by a crash is skipped on read and closed off by the next append.
 */

export function claimsProjectRoot(cwd: string): string {
	const absolute = resolve(cwd);
	let physical = absolute;
	try {
		physical = realpathSync(absolute);
	} catch {
		// A cwd that no longer resolves keeps its lexical form; it still keys one log consistently.
	}
	return clioProjectRoot(physical);
}

export function claimsLogPath(projectRoot: string): string {
	return join(clioStateDir(), "claims", `${createHash("sha256").update(projectRoot, "utf8").digest("hex")}.jsonl`);
}

/** Whether the file's last byte is a newline, so an append after a torn line starts a line of its own. */
function endsWithNewline(fd: number): boolean {
	const size = fstatSync(fd).size;
	if (size === 0) return true;
	const last = Buffer.alloc(1);
	readSync(fd, last, 0, 1, size - 1);
	return last[0] === 0x0a;
}

/** Append records to their project's log. Records for several projects are grouped per log. */
export async function appendClaims(records: ReadonlyArray<ClaimRecord>): Promise<void> {
	const byProject = new Map<string, ClaimRecord[]>();
	for (const record of records) byProject.set(record.project, [...(byProject.get(record.project) ?? []), record]);
	for (const [project, group] of byProject) {
		const path = claimsLogPath(project);
		const dir = dirname(path);
		const created = !existsSync(dir);
		mkdirSync(dir, { recursive: true });
		await withStateFileLock(path, () => {
			const fd = openSync(path, "a+", 0o600);
			try {
				const prefix = endsWithNewline(fd) ? "" : "\n";
				writeSync(fd, `${prefix}${group.map((record) => JSON.stringify(record)).join("\n")}\n`);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		});
		if (created) fsyncDirectory(dir);
	}
}

export interface ClaimsLogRead {
	project: string;
	path: string;
	records: ClaimRecord[];
	/** Lines that are not a JSON object, such as a line torn by a crash. */
	unreadable: number;
	/** Records whose id does not match their content, or that name another project: edited after capture. */
	mismatched: number;
	/** Records of a version this build does not read. */
	unknownVersion: number;
}

function isClaimRecord(value: Record<string, unknown>): boolean {
	return (
		value.type === "claim" &&
		typeof value.id === "string" &&
		typeof value.at === "string" &&
		typeof value.text === "string" &&
		typeof value.subject === "string" &&
		CLAIM_KINDS.some((kind) => kind === value.kind) &&
		(value.verdict === "agrees" || value.verdict === "disagrees") &&
		typeof value.conditions === "object" &&
		value.conditions !== null &&
		typeof value.source === "object" &&
		value.source !== null &&
		typeof value.keys === "object" &&
		value.keys !== null
	);
}

/** Every claim in a project's log, oldest first. A missing log reads as empty. */
export function readClaims(projectRoot: string): ClaimsLogRead {
	const path = claimsLogPath(projectRoot);
	const read: ClaimsLogRead = {
		project: projectRoot,
		path,
		records: [],
		unreadable: 0,
		mismatched: 0,
		unknownVersion: 0,
	};
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return read;
		throw error;
	}
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			read.unreadable += 1;
			continue;
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			read.unreadable += 1;
			continue;
		}
		const record = value as Record<string, unknown>;
		if (record.v !== CLAIM_RECORD_VERSION) {
			read.unknownVersion += 1;
			continue;
		}
		if (!isClaimRecord(record)) {
			read.unreadable += 1;
			continue;
		}
		const claim = record as unknown as ClaimRecord;
		if (claim.project !== projectRoot || claimRecordId(claim) !== claim.id) {
			read.mismatched += 1;
			continue;
		}
		read.records.push(claim);
	}
	return read;
}
