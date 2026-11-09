/** Release ownership lock and durable receipt, kept in the clone's git common directory. */
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";

export class LockHeld extends Error {
	constructor(holder) {
		super(
			`Another release command owns this clone: ${holder.user}@${holder.host} pid ${holder.pid}, \`${holder.command}\` in ${holder.cwd} since ${holder.startedAt}. Let it finish, or stop it there.`,
		);
		this.holder = holder;
	}
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

/**
 * One owner per clone (item 7 of the 0.7.0 release). The record is written to a private
 * file and hard-linked into place, so a reader never sees a half-written lock.
 */
export function acquireLock(
	directory,
	command,
	{ pid = process.pid, host = hostname(), isAlive = alive, inherit = false, env = process.env } = {},
) {
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "lock");
	// A step the orchestrator spawns runs under the orchestrator's lock instead of contending for it.
	if (inherit && env.CLIO_RELEASE_LOCK_PID !== undefined) {
		const holder = readJson(path);
		if (holder !== null && holder.host === host && String(holder.pid) === env.CLIO_RELEASE_LOCK_PID)
			return { record: holder, takeover: null, release() {} };
	}
	const record = {
		user: userInfo().username,
		host,
		pid,
		cwd: process.cwd(),
		command,
		startedAt: new Date().toISOString(),
	};
	const draft = join(directory, `lock.${pid}`);
	const fd = openSync(draft, "w");
	writeSync(fd, `${JSON.stringify(record)}\n`);
	closeSync(fd);
	let takeover = null;
	try {
		for (;;) {
			try {
				linkSync(draft, path);
				break;
			} catch (error) {
				if (error.code !== "EEXIST") throw error;
			}
			const holder = readJson(path);
			if (holder === null) continue;
			if (holder.host !== host || isAlive(holder.pid)) throw new LockHeld(holder);
			// The holder died on this host without releasing; its receipt events say how far it got.
			if (takeover !== null) throw new LockHeld(holder);
			takeover = takeOver(directory, path, draft, holder);
		}
	} finally {
		rmSync(draft, { force: true });
	}
	return {
		record,
		takeover,
		release() {
			if (readJson(path)?.pid === pid) rmSync(path, { force: true });
		},
	};
}

const sameHolder = (a, b) => a?.host === b.host && a?.pid === b.pid && a?.startedAt === b.startedAt;

/**
 * Replaces a dead holder's lock. Two operators can both see it dead, so takeovers are serialized
 * by an exclusive `lock.takeover` link and the holder is re-read inside it: only the operator
 * that still finds the same dead record removes it. Returns that holder, or null if it changed.
 */
function takeOver(directory, path, draft, holder) {
	const guard = join(directory, "lock.takeover");
	try {
		linkSync(draft, guard);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		// Another takeover is in its few-millisecond window, or it died there; never guess which.
		throw new LockHeld({ ...(readJson(guard) ?? holder), command: `taking over the lock (remove ${guard} if stale)` });
	}
	try {
		if (!sameHolder(readJson(path), holder)) return null;
		rmSync(path, { force: true });
		return holder;
	} finally {
		rmSync(guard, { force: true });
	}
}

export const receiptPath = (directory, version) => join(directory, `v${version}.json`);

export function loadReceipt(directory, version) {
	return readJson(receiptPath(directory, version));
}

export function newReceipt({ version, commit, branch, nonce, owner }) {
	return {
		schema: 1,
		version,
		commit,
		branch,
		nonce,
		owner,
		scratch: [],
		ciRun: null,
		releaseRun: null,
		draftId: null,
		npm: null,
		rehearsal: null,
		post: {},
		events: [],
	};
}

export function saveReceipt(directory, receipt) {
	mkdirSync(directory, { recursive: true });
	const path = receiptPath(directory, receipt.version);
	const temporary = `${path}.${process.pid}`;
	const fd = openSync(temporary, "w");
	writeSync(fd, `${JSON.stringify(receipt, null, 2)}\n`);
	closeSync(fd);
	renameSync(temporary, path);
}

/** Append-only history: the receipt doubles as the release's audit trail. */
export function recordEvent(receipt, step, outcome, detail = {}) {
	receipt.events.push({ at: new Date().toISOString(), step, outcome, ...detail });
}
