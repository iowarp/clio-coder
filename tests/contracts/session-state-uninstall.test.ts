/**
 * `clio-coder uninstall` removed the state root and reported success; roughly two
 * minutes later the session shutdown checkpoint rebuilt the root around a
 * meta.json and a tree.json carrying `lastCheckpointReason: shutdown`. Every
 * writer under the root mkdirs its parent back (`sessionPaths` for the session
 * directory, `safeResourceWrite` for the temp file, the audit writer for
 * `<state>/audit`), so any of them landing after the removal undoes it.
 *
 * The dispatch ledger half of this guard lives in dispatch-state-uninstall.test.ts.
 */
import { ok, strictEqual } from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { rememberRecentModel, resetRecentModelsCache } from "../../src/core/recent-models.js";
import { buildSessionParkAuditRecord, openAuditWriter } from "../../src/domains/safety/audit.js";
import { performCheckpoint } from "../../src/domains/session/checkpoint.js";
import { persistSessionMeta, type SessionManagerState, startSession } from "../../src/domains/session/manager.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

describe("contracts/session state after an uninstall", () => {
	let scratch: Awaited<ReturnType<typeof isolateClioEnv>>;
	let stateDir: string;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-session-uninstall-");
		stateDir = join(scratch.dir, "state");
		resetRecentModelsCache();
	});

	afterEach(() => {
		resetRecentModelsCache();
		scratch.restore();
	});

	function openSessionState(): SessionManagerState {
		return startSession({ cwd: "/tmp/uninstall-project", model: "a-model", target: "default" });
	}

	it("does not write the shutdown checkpoint back into a state root that was removed", async () => {
		const state = openSessionState();
		await performCheckpoint(state, "manual");
		ok(existsSync(join(stateDir, "sessions")), "a checkpoint writes normally while the root is there");

		rmSync(stateDir, { recursive: true, force: true });
		await performCheckpoint(state, "shutdown");

		strictEqual(existsSync(stateDir), false, "the shutdown checkpoint must not recreate the root an uninstall removed");
	});

	it("does not write tree.json or meta.json back on close", async () => {
		const state = openSessionState();
		rmSync(stateDir, { recursive: true, force: true });

		await state.writer.close();

		strictEqual(existsSync(stateDir), false, "closing the writer must not recreate the removed state root");
	});

	it("does not write meta.json back on a metadata-only update", () => {
		const state = openSessionState();
		rmSync(stateDir, { recursive: true, force: true });

		state.meta.skillActivations = [];
		persistSessionMeta(state);

		strictEqual(existsSync(stateDir), false, "a meta update must not recreate the removed state root");
	});

	// A row written to the already-open fd lands in an unlinked inode and creates
	// nothing. The writer only mkdirs `<state>/audit` again on a date rollover,
	// so that is the case that used to rebuild the root.
	it("does not reopen an audit file, and so a state root, that was removed", async () => {
		let clock = new Date("2026-08-13T12:00:00.000Z");
		const writer = openAuditWriter({ dateFn: () => clock });
		writer.write(buildSessionParkAuditRecord({ sessionId: "before-the-uninstall", reason: "close" }));
		writer.flush();
		ok(existsSync(join(stateDir, "audit")), "audit rows are written normally while the root is there");

		rmSync(stateDir, { recursive: true, force: true });
		clock = new Date("2026-08-14T12:00:00.000Z");
		writer.write(buildSessionParkAuditRecord({ sessionId: "after-the-uninstall", reason: "shutdown" }));
		await writer.close();

		strictEqual(existsSync(stateDir), false, "an audit rollover must not recreate the removed state root");
	});

	it("does not write recent-models.json back into a removed state root", () => {
		rememberRecentModel("default/a-model", 12);
		ok(existsSync(join(stateDir, "recent-models.json")), "recents persist normally while the root is there");

		rmSync(stateDir, { recursive: true, force: true });
		const next = rememberRecentModel("default/another-model", 12);

		strictEqual(existsSync(stateDir), false, "a recents write must not recreate the removed state root");
		strictEqual(next[0], "default/another-model", "the in-process list still reflects the pick");
	});

	// The guard is about a root that is gone. The ordinary path must still write.
	it("still writes the checkpoint while the state root is present", async () => {
		const state = openSessionState();
		await performCheckpoint(state, "shutdown");

		const dir = join(stateDir, "sessions", state.meta.cwdHash, state.meta.id);
		ok(existsSync(join(dir, "meta.json")), "meta.json is written on the ordinary path");
		ok(existsSync(join(dir, "tree.json")), "tree.json is written on the ordinary path");
		strictEqual(state.meta.lastCheckpointReason, "shutdown");
	});
});
