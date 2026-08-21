import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clioStateDir } from "../../src/core/xdg.js";
import { listSessionsForCwd } from "../../src/domains/session/history.js";
import { resumeSessionState } from "../../src/domains/session/manager.js";
import { runMigrations } from "../../src/domains/session/migrations/index.js";
import {
	CURRENT_SESSION_FORMAT_VERSION,
	createSession,
	openSession,
	resumeSession,
	sessionPaths,
} from "../../src/engine/session.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

// BUG-013: session ids are identifiers, not paths. findSessionDir joined a
// caller id into each sessions/<cwdHash>/ directory and trusted the result, so a
// traversal id resolved a directory outside the sessions root. Both openSession
// and resumeSession now reject unsafe ids before any filesystem read.

describe("contracts/session-boundary", () => {
	let scratch: string;
	beforeEach(async () => {
		scratch = await newScratchClioHome("clio-session-boundary-");
	});
	afterEach(() => clearScratchClioHome(scratch));

	it("rejects traversal session ids before resolving outside the sessions root", () => {
		const stateDir = clioStateDir();
		// The resolver iterates sessions/<cwdHash>/; seed one anchor so the loop
		// would run, plus a valid session directory outside sessions/ that a
		// regression would resolve and load.
		mkdirSync(join(stateDir, "sessions", "hash"), { recursive: true });
		const outside = join(stateDir, "outside-session");
		mkdirSync(outside, { recursive: true });
		const createdAt = "2026-07-01T00:00:00.000Z";
		const meta = {
			id: "outside-session",
			cwd: scratch,
			cwdHash: "hash",
			createdAt,
			endedAt: null,
			model: null,
			target: null,
			clioVersion: "0.2.7",
			piMonoVersion: "0.0.0",
			platform: process.platform,
			nodeVersion: process.version,
			sessionFormatVersion: 3,
		};
		writeFileSync(join(outside, "meta.json"), JSON.stringify(meta));
		writeFileSync(
			join(outside, "current.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "outside-session", timestamp: createdAt, cwd: scratch })}\n`,
		);
		writeFileSync(join(outside, "tree.json"), "[]\n");

		for (const id of ["../../outside-session", "../hash/outside-session", "/tmp/outside-session"]) {
			throws(() => openSession(id), /invalid session id|session not found/);
			throws(() => resumeSession(id), /invalid session id|session not found/);
		}
	});

	it("still opens and resumes a valid session id", () => {
		const { meta } = createSession({ cwd: scratch });
		strictEqual(openSession(meta.id).meta().id, meta.id);
		strictEqual(resumeSession(meta.id).meta.id, meta.id);
	});

	it("derives session history from structured user messages", async () => {
		const { meta, writer } = createSession({ cwd: scratch });
		writer.appendEntry(
			{
				kind: "message",
				turnId: "user-1",
				parentTurnId: null,
				timestamp: "2026-07-26T00:00:00.000Z",
				role: "user",
				payload: { text: "structured history prompt" },
			},
			{ treeNode: { id: "user-1", parentId: null, at: "2026-07-26T00:00:00.000Z", kind: "user" } },
		);
		await writer.close();

		const history = listSessionsForCwd(scratch);
		strictEqual(history[0]?.id, meta.id);
		strictEqual(history[0]?.firstMessagePreview, "structured history prompt");
		strictEqual(history[0]?.messageCount, 1);
	});

	it("rejects removed turn records instead of normalizing session history", async () => {
		const { meta, writer } = createSession({ cwd: scratch });
		await writer.close();
		const currentPath = sessionPaths(meta).current;
		const header = readFileSync(currentPath, "utf8");
		writeFileSync(
			currentPath,
			`${header}${JSON.stringify({
				id: "old-user-1",
				parentId: null,
				at: "2026-07-26T00:00:00.000Z",
				kind: "user",
				payload: { text: "removed record" },
			})}\n`,
		);

		throws(() => listSessionsForCwd(scratch), {
			message: `session ledger contains an unreadable entry (missing kind discriminant): ${currentPath}. Remove or compact the session to reset.`,
		});
	});

	for (const version of [1, 2] as const) {
		it(`rejects session format version ${version} with an operator remedy`, async () => {
			const { meta, writer } = createSession({ cwd: scratch });
			await writer.close();
			const paths = sessionPaths(meta);
			writeFileSync(paths.meta, JSON.stringify({ ...meta, sessionFormatVersion: version }));

			throws(() => resumeSessionState(meta.id), {
				message: `session metadata has an unsupported format version (expected version ${CURRENT_SESSION_FORMAT_VERSION}, got ${version}): ${paths.meta}. Remove the session directory to start a new session.`,
			});
		});
	}

	// A newer Clio may have written kinds this build does not know. Reading the
	// file anyway would drop them silently, and the next append would write that
	// truncated reading back over the operator's session.
	it("rejects a session written by a newer Clio instead of downgrading it", async () => {
		const { meta, writer } = createSession({ cwd: scratch });
		await writer.close();
		const paths = sessionPaths(meta);
		const newer = CURRENT_SESSION_FORMAT_VERSION + 1;
		writeFileSync(paths.meta, JSON.stringify({ ...meta, sessionFormatVersion: newer }));

		throws(() => resumeSessionState(meta.id), {
			message: `session was written by a newer Clio (format version ${newer}, this build reads version ${CURRENT_SESSION_FORMAT_VERSION}): ${paths.meta}. Upgrade clio-coder to resume this session.`,
		});
	});

	// Version 4 only added the working-set kinds; a version-3 ledger is readable
	// as-is, so an upgrade must not strand every session the operator has.
	it("resumes a version-3 session as a no-op migration and restamps the metadata", async () => {
		const { meta, writer } = createSession({ cwd: scratch });
		await writer.close();
		const paths = sessionPaths(meta);
		writeFileSync(paths.meta, JSON.stringify({ ...meta, sessionFormatVersion: 3 }));

		deepStrictEqual(runMigrations({ ...meta, sessionFormatVersion: 3 } as never, paths.meta), {
			migrated: true,
			from: 3,
			to: CURRENT_SESSION_FORMAT_VERSION,
		});
		const resumed = resumeSessionState(meta.id);
		strictEqual(resumed.state.meta.sessionFormatVersion, CURRENT_SESSION_FORMAT_VERSION);
		strictEqual(JSON.parse(readFileSync(paths.meta, "utf8")).sessionFormatVersion, CURRENT_SESSION_FORMAT_VERSION);
		await resumed.state.writer.close();
		// A second resume sees the current version and migrates nothing.
		deepStrictEqual(runMigrations(resumed.state.meta, paths.meta), {
			migrated: false,
			from: CURRENT_SESSION_FORMAT_VERSION,
			to: CURRENT_SESSION_FORMAT_VERSION,
		});
	});

	it("stamps the current format version on a new session", () => {
		const { meta } = createSession({ cwd: scratch });
		strictEqual(meta.sessionFormatVersion, CURRENT_SESSION_FORMAT_VERSION);
		strictEqual(CURRENT_SESSION_FORMAT_VERSION, 4);
	});
});
