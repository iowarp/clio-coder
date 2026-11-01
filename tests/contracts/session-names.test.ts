import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { listSessionsForCwd } from "../../src/domains/session/history.js";
import type { SessionEntry, SessionMeta } from "../../src/domains/session/index.js";
import { resolveSessionTarget, suggestSessionName } from "../../src/domains/session/names.js";
import { sessionPaths } from "../../src/engine/session.js";
import type { OverlayHandle, TUI } from "../../src/engine/tui.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { buildFooterDashboard } from "../../src/interactive/footer/dashboard.js";
import { createOverlaySessionLifecycle } from "../../src/interactive/overlay-session-lifecycle.js";
import type { OverlayTransitions } from "../../src/interactive/overlay-transitions.js";
import { renameCurrentSession } from "../../src/interactive/session-rename.js";
import { parseSlashCommand } from "../../src/session-control/slash-commands.js";
import type { AskUserResult } from "../../src/tools/ask-user.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function createSession() {
	return createSessionBundle({ bus: { emit() {} } } as unknown as DomainContext).contract;
}

const entries: SessionEntry[] = [
	{
		kind: "message",
		turnId: "user",
		parentTurnId: null,
		timestamp: "2026-11-01T12:00:00Z",
		role: "user",
		payload: { text: "Repair checkpoint output for the particle solver" },
	},
];

test("saved names survive reopen and a child rename preserves the parent's transcript and route", async (t) => {
	const env = await isolateClioEnv("session-names-");
	const session = createSession();
	t.after(async () => {
		await session.close();
		env.restore();
	});
	const original = session.create({ cwd: env.dir, target: "gateway", model: "solver" });
	const user = session.append({ parentId: null, kind: "user", payload: { text: "Fix checkpoint output" } });
	const assistant = session.append({ parentId: user.id, kind: "assistant", payload: { text: "Investigating" } });
	const conversation = session.readEntries().filter((entry) => entry.kind === "message");
	session.setName("my-experiment");
	assert.equal(session.current()?.name, "my-experiment");
	const footer = buildFooterDashboard({
		providers: { list: () => [] } as never,
		resolveCurrentBranch: async () => null,
		getSessionInfo: () => ({ id: session.current()?.id ?? null, name: session.current()?.name ?? null, turns: 1 }),
	});
	try {
		assert.match(footer.view.render(120).map(stripTerminalSequences).join("\n"), /my-experiment/);
	} finally {
		footer.dispose();
	}

	assert.equal(session.current()?.id, original.id);
	assert.equal(session.current()?.target, "gateway");
	assert.equal(session.current()?.model, "solver");
	assert.deepEqual(
		session.readEntries().filter((entry) => entry.kind === "message"),
		conversation,
	);
	await session.close();
	assert.equal(listSessionsForCwd(env.dir).find((meta) => meta.id === original.id)?.name, "my-experiment");
	assert.equal(session.resume(original.id).name, "my-experiment");
	const child = session.fork(assistant.id);
	const parentPath = sessionPaths(original).current;
	const parentBytes = readFileSync(parentPath, "utf8");
	session.setName("child-experiment");
	assert.equal(session.current()?.id, child.id);
	assert.equal(session.current()?.name, "child-experiment");
	assert.equal(readFileSync(parentPath, "utf8"), parentBytes);
	assert.equal(listSessionsForCwd(env.dir).find((meta) => meta.id === original.id)?.name, "my-experiment");
	assert.deepEqual(
		session.readEntries().filter((entry) => entry.kind === "message"),
		conversation,
	);
	assert.equal(session.current()?.target, "gateway");
	assert.equal(session.current()?.model, "solver");
});

test("rename parsing accepts full names and refuses explicit empty names", () => {
	assert.deepEqual(parseSlashCommand("/rename"), { kind: "rename" });
	for (const input of ["/rename my experiment", '/rename "my experiment"']) {
		assert.deepEqual(parseSlashCommand(input), { kind: "rename", name: "my experiment" });
	}
	for (const input of ['/rename ""', "/rename ''", '/rename "   "', "/rename   "]) {
		const command = parseSlashCommand(input);
		assert.equal(command.kind, "usage-error");
		if (command.kind === "usage-error") assert.match(command.reason, /empty or whitespace/);
	}
	assert.deepEqual(parseSlashCommand("/resume my experiment"), { kind: "resume", target: "my experiment" });
});

test("a local suggestion writes only after operator confirmation and rejects stale or automatic answers", async () => {
	let current = { id: "original" } as SessionMeta;
	const saved: string[] = [];
	let answer!: (result: AskUserResult) => void;
	let question = "";
	const deps = {
		session: {
			current: () => current,
			setName: (name: string) => {
				saved.push(name);
			},
		},
		entries: () => entries,
		leaf: () => "user",
		confirm: async (questions: ReadonlyArray<{ question: string }>) => {
			question = questions[0]?.question ?? "";
			return new Promise<AskUserResult>((resolve) => {
				answer = resolve;
			});
		},
		notice: () => {},
		refresh: () => {},
	};
	assert.equal(suggestSessionName(entries), "Repair checkpoint output for the particle solver");
	let pending = renameCurrentSession(deps);
	assert.match(question, /Repair checkpoint output/);
	assert.deepEqual(saved, []);
	answer({ answers: [{ question, answer: "Confirm" }] });
	await pending;
	assert.deepEqual(saved, ["Repair checkpoint output for the particle solver"]);
	for (const result of [
		{ answers: [], cancelled: true },
		{ answers: [{ question, answer: "Cancel" }] },
		{ answers: [{ question, answer: "Confirm", auto: true }] },
	] satisfies AskUserResult[]) {
		pending = renameCurrentSession(deps);
		answer(result);
		await pending;
	}
	pending = renameCurrentSession(deps);
	current = { id: "child" } as SessionMeta;
	answer({ answers: [{ question, answer: "Confirm" }] });
	await pending;
	await renameCurrentSession(deps, "   ");
	assert.equal(saved.length, 1);
});

test("resume names resolve exactly while ID lookups keep precedence", () => {
	const sessions = [
		{ id: "abc-one", name: "experiment" },
		{ id: "abc-two", name: "duplicate" },
		{ id: "def-three", name: "duplicate" },
		{ id: "ghi-four", name: "abc-one" },
		{ id: "jkl-five", name: "abc" },
		{ id: "mno-six", name: "def" },
	];
	assert.deepEqual(resolveSessionTarget(sessions, "experiment"), { id: "abc-one" });
	assert.deepEqual(resolveSessionTarget(sessions, "abc-one"), { id: "abc-one" });
	assert.deepEqual(resolveSessionTarget(sessions, "def"), { id: "def-three" });
	assert.deepEqual(resolveSessionTarget(sessions, "abc"), { miss: "abc matches 2 sessions" });
	assert.deepEqual(resolveSessionTarget(sessions, "duplicate"), { miss: "duplicate matches 2 sessions" });
	assert.deepEqual(resolveSessionTarget(sessions, "exper"), { miss: "no session matches exper" });
});

test("resume uses a unique saved name directly and opens a filtered picker for duplicate names", async (t) => {
	const env = await isolateClioEnv("resume-names-");
	const session = createSession();
	t.after(async () => {
		await session.close();
		env.restore();
	});
	const first = session.create({ cwd: env.dir });
	session.setName("my experiment");
	const second = session.create({ cwd: env.dir });
	session.setName("duplicate");
	session.create({ cwd: env.dir });
	session.setName("duplicate");
	let query: string | undefined;
	let opened = 0;
	const transitions: OverlayTransitions = {
		state: "closed",
		handle: null,
		showPermission: () => false,
		close: () => {
			transitions.state = "closed";
		},
	};
	const lifecycle = createOverlaySessionLifecycle({
		tui: {} as TUI,
		transitions,
		session,
		chatPanel: createChatPanel(),
		chat: {
			cancel() {},
			isStreaming: () => false,
			resetForSession() {},
			whenSettled: async () => {},
			extractHandoff: async () => ({ status: "failed", reason: "unused" }),
		},
		resetTranscript() {},
		readStructuredEntries: () => [],
		getSlashNotice: () => () => {},
		announceTaskMemorySeedOffer() {},
		refreshFooter() {},
		requestRender() {},
		stderr() {},
		notify() {},
		openSessionOverlay: (_tui, deps) => {
			opened++;
			query = deps.initialQuery;
			return { hide() {}, focus() {} } as OverlayHandle;
		},
	});
	lifecycle.openResume("my experiment");
	await Promise.resolve();
	assert.equal(session.current()?.id, first.id);
	assert.equal(opened, 0);
	lifecycle.openResume("duplicate");
	assert.equal(opened, 1);
	assert.equal(query, "duplicate");
	assert.equal(session.current()?.id, first.id);
	assert.notEqual(session.current()?.id, second.id);
});
