import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { sessionPaths } from "../../src/engine/session.js";
import type { TUI } from "../../src/engine/tui.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import type { OverlaySessionLifecycleDeps } from "../../src/interactive/overlay-session-lifecycle.js";
import { createOverlaySessionLifecycle } from "../../src/interactive/overlay-session-lifecycle.js";
import type { SlashCommandContext } from "../../src/session-control/slash-commands.js";
import { dispatchSlashCommand, parseSlashCommand } from "../../src/session-control/slash-commands.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("/branch session isolation", () => {
	let scratch: IsolatedClioEnv;
	let session: SessionContract;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-branch-");
		session = createSessionBundle({ bus: { emit() {} } } as unknown as DomainContext).contract;
	});

	afterEach(async () => {
		await session.close();
		scratch.restore();
	});

	function append(id: string, parentId: string | null, kind: "user" | "assistant", payload = { text: id }) {
		session.append({ id, parentId, kind, payload });
	}

	function harness(overrides: Partial<OverlaySessionLifecycleDeps> = {}) {
		const notices: string[] = [];
		const forks: string[] = [];
		let replayLeaf: string | null = null;
		const lifecycle = createOverlaySessionLifecycle({
			tui: {} as TUI,
			transitions: { state: "closed", handle: null, showPermission: () => false, close() {} },
			session,
			chat: {
				cancel() {},
				isStreaming: () => false,
				whenSettled: async () => {},
				resetForSession: (leaf) => {
					replayLeaf = leaf;
				},
				extractHandoff: async () => ({ status: "aborted", text: "" }),
			},
			chatPanel: createChatPanel(),
			resetTranscript() {},
			readStructuredEntries: () => [...session.readEntries()],
			getSlashNotice: () => (_level, text) => {
				notices.push(text);
			},
			onForkSession: (parent) => {
				forks.push(parent);
				session.fork(parent);
			},
			announceTaskMemorySeedOffer() {},
			refreshFooter() {},
			requestRender() {},
			stderr: (text) => {
				throw new Error(text);
			},
			notify() {},
			openMessagePickerOverlay: () => {
				throw new Error("/branch must skip the picker");
			},
			...overrides,
		});
		return { lifecycle, notices, forks, replayLeaf: () => replayLeaf };
	}

	for (const name of [undefined, "alternate approach"]) {
		it(`branches ${name ? "with a saved name" : "without a name"} and keeps the parent transcript resumable and unchanged`, async () => {
			const parent = session.create({ cwd: scratch.dir, model: "model", target: "target" });
			append("u1", null, "user");
			append("a1", "u1", "assistant");
			const transcript = sessionPaths(parent).current;
			const before = readFileSync(transcript, "utf8");
			const workspaceFile = join(scratch.dir, "work.txt");
			writeFileSync(workspaceFile, "existing edits");
			const h = harness();
			const parsed = parseSlashCommand(name ? `/branch "${name}"` : "/branch");
			deepStrictEqual(parsed, name ? { kind: "branch", name } : { kind: "branch" });
			if (name) deepStrictEqual(parseSlashCommand(`/branch ${name}`), parsed);
			dispatchSlashCommand(parsed, { startBranch: h.lifecycle.startBranch } as SlashCommandContext);
			const child = session.current();
			ok(child);
			notStrictEqual(child.id, parent.id);
			deepStrictEqual(h.forks, ["a1"]);
			strictEqual(h.replayLeaf(), "a1");
			strictEqual(child.parentSessionId, parent.id);
			strictEqual(child.parentTurnId, "a1");
			deepStrictEqual([child.cwd, child.model, child.target], [parent.cwd, parent.model, parent.target]);
			append("child-u", "a1", "user");
			append("child-a", "child-u", "assistant");
			await session.checkpoint();
			strictEqual(readFileSync(transcript, "utf8"), before);
			strictEqual(readFileSync(workspaceFile, "utf8"), "existing edits");
			const history = session.history();
			ok(history.some((entry) => entry.id === parent.id));
			strictEqual(history.find((entry) => entry.id === child.id)?.name, name);
			session.resume(parent.id);
			deepStrictEqual(
				session
					.readEntries()
					.filter((entry) => entry.kind === "message")
					.map((entry) => entry.turnId),
				["u1", "a1"],
			);
			session.resume(child.id);
			ok(session.readEntries().some((entry) => entry.turnId === "child-a"));
		});
	}

	for (const leaf of ["u2", "a2"]) {
		it(`honors the active /tree path pinned at ${leaf}`, async () => {
			session.create({ cwd: scratch.dir });
			append("u1", null, "user");
			append("a1", "u1", "assistant");
			append("u2", "a1", "user");
			append("a2", "u2", "assistant");
			session.switchTurn("a1");
			append("sibling-u", "a1", "user");
			append("sibling-a", "sibling-u", "assistant");
			session.switchTurn(leaf);
			const h = harness();
			await h.lifecycle.startBranch();
			deepStrictEqual(h.forks, [leaf === "u2" ? "a1" : "a2"]);
			ok(!session.readEntries().some((entry) => entry.turnId === "sibling-a"));
		});
	}

	it("settles the running turn into its parent before selecting the interrupted assistant", async () => {
		const parent = session.create({ cwd: scratch.dir });
		append("u1", null, "user");
		append("a1", "u1", "assistant");
		append("u2", "a1", "user");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let cancelled = false;
		let parentTranscript = "";
		const h = harness({
			chat: {
				cancel: () => {
					cancelled = true;
				},
				isStreaming: () => true,
				whenSettled: async () => {
					await gate;
					strictEqual(session.current()?.id, parent.id);
					append("partial-a", "u2", "assistant", { text: "interrupted response" });
					parentTranscript = readFileSync(sessionPaths(parent).current, "utf8");
				},
				resetForSession() {},
				extractHandoff: async () => ({ status: "aborted", text: "" }),
			},
		});
		const pending = h.lifecycle.startBranch();
		ok(cancelled);
		deepStrictEqual(h.forks, []);
		strictEqual(session.current()?.id, parent.id);
		release();
		await pending;
		deepStrictEqual(h.forks, ["partial-a"]);
		append("child-u", "partial-a", "user");
		strictEqual(readFileSync(sessionPaths(parent).current, "utf8"), parentTranscript);
	});

	it("reports missing sessions, empty paths, and host fork failures without replacing the transcript", async () => {
		const h = harness({ onForkSession() {} });
		await h.lifecycle.startBranch();
		match(h.notices.pop() ?? "", /no current session/);
		const parent = session.create({ cwd: scratch.dir });
		append("u1", null, "user");
		await h.lifecycle.startBranch();
		match(h.notices.pop() ?? "", /no assistant turns/);
		append("a1", "u1", "assistant");
		await h.lifecycle.startBranch("child");
		match(h.notices.pop() ?? "", /fork failed/);
		strictEqual(session.current()?.id, parent.id);
		strictEqual(h.replayLeaf(), null);
	});
});
