import { ok, strictEqual, throws } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { sessionPaths } from "../../src/engine/session.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { createOverlaySessionLifecycle } from "../../src/interactive/overlay-session-lifecycle.js";
import type { OverlayTransitions } from "../../src/interactive/overlay-transitions.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

// issue #93: a failed /fork or /tree switch closed and endedAt-stamped the
// current session before the target session had actually opened. When the
// open then threw, there was no rollback: the operator was left with no
// current session while the overlay carried on and replayed the target
// anyway, so the next message created a session whose first turn was
// parented to a turn in a different session. That session could never be
// forked, so the natural recovery action reproduced the loss.
//
// Fixed by: opening the target before parking/closing the prior session
// (extension.ts resume/switchBranch, tree/fork.ts forkFromState), the
// overlay refusing to replay a target session.current() did not actually
// move to (overlay-session-lifecycle.ts), and a domain-level invariant that
// a turn can only extend the current session's own leaf (extension.ts append).

function stubContext(): DomainContext {
	return {
		bus: { emit: () => {}, on: () => () => {} } as unknown as DomainContext["bus"],
		getContract: () => undefined,
	};
}

/** Corrupt a session's meta.json so resumeSessionState/runMigrations rejects it. */
function corruptSessionFormatVersion(meta: { id: string; cwdHash: string }): void {
	const metaPath = sessionPaths(meta as Parameters<typeof sessionPaths>[0]).meta;
	const raw = JSON.parse(readFileSync(metaPath, "utf8"));
	raw.sessionFormatVersion = 2;
	writeFileSync(metaPath, JSON.stringify(raw));
}

function readEndedAt(meta: { id: string; cwdHash: string }): string | null {
	const metaPath = sessionPaths(meta as Parameters<typeof sessionPaths>[0]).meta;
	return JSON.parse(readFileSync(metaPath, "utf8")).endedAt;
}

describe("contracts/session-switch-atomicity", () => {
	let scratch: string;

	beforeEach(async () => {
		scratch = await newScratchClioHome("clio-switch-atomicity-");
	});

	afterEach(() => {
		clearScratchClioHome(scratch);
	});

	it("resume() leaves the current session open and current when the target fails to open", async () => {
		const bundle = createSessionBundle(stubContext());
		const { contract } = bundle;
		const a = contract.create({ cwd: process.cwd() });
		const bMeta = contract.create({ cwd: process.cwd() });
		// create()/resume() close the prior session by writing its own in-memory
		// meta back to disk, which would clobber a corruption written before
		// that close. Corrupt B only after its writer has already closed.
		contract.resume(a.id);
		corruptSessionFormatVersion(bMeta);

		throws(() => contract.resume(bMeta.id), /unsupported format version/);

		strictEqual(contract.current()?.id, a.id, "current session must still be A after the failed resume");
		strictEqual(readEndedAt(a), null, "A must not be stamped endedAt: its writer was never closed");

		await bundle.contract.close();
	});

	it("switchBranch() has the same open-before-close ordering as resume()", async () => {
		const bundle = createSessionBundle(stubContext());
		const { contract } = bundle;
		const a = contract.create({ cwd: process.cwd() });
		const bMeta = contract.create({ cwd: process.cwd() });
		contract.resume(a.id);
		corruptSessionFormatVersion(bMeta);

		throws(() => contract.switchBranch(bMeta.id), /unsupported format version/);

		strictEqual(contract.current()?.id, a.id);
		strictEqual(readEndedAt(a), null);

		await bundle.contract.close();
	});

	it("fork() leaves the parent session open and current when the fork point is invalid", async () => {
		const bundle = createSessionBundle(stubContext());
		const { contract } = bundle;
		const a = contract.create({ cwd: process.cwd() });
		contract.append({ parentId: null, kind: "user", payload: { text: "hello" } });

		throws(() => contract.fork("turn-that-does-not-exist"), /parent turn not found/);

		strictEqual(contract.current()?.id, a.id, "current session must still be A after the failed fork");
		strictEqual(readEndedAt(a), null, "A must not be stamped endedAt: forkFromState must not have closed it");

		await bundle.contract.close();
	});

	it("append() refuses to parent a turn onto another session's turn", async () => {
		const bundle = createSessionBundle(stubContext());
		const { contract } = bundle;
		contract.create({ cwd: process.cwd() });
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "in A" } });

		// A fresh session's leaf is null; appending with A's turn id as parent
		// must be refused even though that id is a real, existing turn id.
		contract.create({ cwd: process.cwd() });
		throws(
			() => contract.append({ parentId: u1.id, kind: "user", payload: { text: "orphan" } }),
			/is not this session's current leaf/,
		);

		await bundle.contract.close();
	});

	it("append() still allows a turn parented on the session's own current leaf (tree branching)", async () => {
		const bundle = createSessionBundle(stubContext());
		const { contract } = bundle;
		contract.create({ cwd: process.cwd() });
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "u1" } });
		const a1 = contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "a1" } });
		contract.switchTurn(u1.id);
		const branch = contract.append({ parentId: u1.id, kind: "user", payload: { text: "branch" } });
		ok(branch.id !== a1.id);

		await bundle.contract.close();
	});

	it("the overlay does not replay a resume target it did not successfully switch to", async () => {
		const bundle = createSessionBundle(stubContext());
		const { contract } = bundle;
		const a = contract.create({ cwd: process.cwd() });
		contract.append({ parentId: null, kind: "user", payload: { text: "A: hello" } });
		const bMeta = contract.create({ cwd: process.cwd() });
		const bLeaf = contract.append({ parentId: null, kind: "user", payload: { text: "B: hello" } });
		contract.resume(a.id);
		corruptSessionFormatVersion(bMeta);

		const events: string[] = [];
		let chatResetCalls = 0;
		const transitions: OverlayTransitions = {
			state: "closed",
			handle: null,
			close() {
				this.state = "closed";
			},
			showPermission(next) {
				this.state = "permission-confirm";
				this.handle = next;
				return true;
			},
		};
		const lifecycle = createOverlaySessionLifecycle({
			tui: { requestRender() {} } as never,
			transitions,
			session: contract,
			chat: {
				cancel() {},
				isStreaming: () => false,
				resetForSession(leaf: string | null, msgs?: ReadonlyArray<AgentMessage>) {
					chatResetCalls += 1;
					events.push(`chat.resetForSession(${leaf}, ${msgs?.length ?? 0})`);
				},
				whenSettled: async () => {},
			},
			chatPanel: {
				appendUser() {},
				clearFoldOverrides() {},
				applyEvent() {},
				appendReplayBlock() {},
				applyWorkerState() {},
			} as never,
			resetTranscript() {
				events.push("panel.reset");
			},
			readStructuredEntries: () => [],
			getSlashNotice: () => () => {},
			onResumeSession: (id: string) => {
				try {
					contract.resume(id);
				} catch {
					// mirrors src/entry/orchestrator.ts: swallow and stderr-log
				}
			},
			announceTaskMemorySeedOffer() {},
			refreshFooter() {},
			requestRender() {},
			stderr: (t: string) => events.push(`stderr: ${t.trim()}`),
			notify() {},
			openSessionOverlay: (_tui: unknown, deps: { onResume: (id: string) => void }) => {
				deps.onResume(bMeta.id);
				return { hide() {} } as never;
			},
		} as never);

		lifecycle.openResume();

		strictEqual(chatResetCalls, 0, "the overlay must not reset the chat leaf onto a session it did not switch to");
		strictEqual(contract.current()?.id, a.id, "current session must still be A");
		ok(!events.some((e) => e.includes(bLeaf.id)), "B's leaf must never reach the chat panel through a failed resume");

		await bundle.contract.close();
	});
});
