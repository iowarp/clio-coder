import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { removeSessionAtRest, renameSessionAtRest, sessionRemovalRefusal } from "../../src/domains/session/at-rest.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { liveRecordPath, liveSessionsDir } from "../../src/domains/session/heartbeat.js";
import { listSessionsForCwd, resolveSessionIdForCwd } from "../../src/domains/session/history.js";
import type { SessionEntry, SessionMeta } from "../../src/domains/session/index.js";
import { SessionLiveError } from "../../src/domains/session/live-owner.js";
import { resolveSessionTarget, suggestSessionName } from "../../src/domains/session/names.js";
import { cwdHash, sessionPaths } from "../../src/engine/session.js";
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
	assert.equal(child.name, "my-experiment");
	assert.equal(JSON.parse(readFileSync(sessionPaths(child).meta, "utf8")).name, "my-experiment");
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
		if (command.kind === "usage-error") assert.match(command.reason ?? "", /empty or whitespace/);
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

test("a named resume resolves ids and prefixes from metadata and orders an ambiguous prefix by activity", async (t) => {
	const env = await isolateClioEnv("session-resolve-id-");
	t.after(() => env.restore());
	const cwd = join(env.dir, "project");
	const write = (id: string, at: string, ledger: boolean) => {
		const dir = join(clioStateDir(), "sessions", cwdHash(cwd), id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "meta.json"), JSON.stringify({ id, cwd, createdAt: at, endedAt: at }));
		// A directory where the ledger belongs throws on any read, so these lookups prove no ledger is parsed.
		if (!ledger) mkdirSync(join(dir, "current.jsonl"));
		else
			writeFileSync(
				join(dir, "current.jsonl"),
				`${JSON.stringify({ type: "session", version: 6, id, timestamp: at, cwd })}\n${JSON.stringify({ ...entries[0], timestamp: at })}\n`,
			);
	};
	write("def-newer", "2026-11-01T12:00:00Z", true);
	write("def-older", "2026-11-01T09:00:00Z", true);
	assert.deepEqual(resolveSessionIdForCwd(cwd, "def"), { ambiguous: ["def-newer", "def-older"] });
	write("abc", "2026-11-01T10:00:00Z", false);
	write("abc-one", "2026-11-01T11:00:00Z", false);
	write("ghi-only", "2026-11-01T08:00:00Z", false);
	assert.equal(resolveSessionIdForCwd(cwd, "abc"), "abc", "an exact id wins over the ids it prefixes");
	assert.equal(resolveSessionIdForCwd(cwd, "ghi"), "ghi-only");
	assert.equal(resolveSessionIdForCwd(cwd, "zzz"), "zzz", "no match passes the input on for the resume to refuse");
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

test("a CLI fork names its child at creation, never writes the parent, and blocks removal while live or forked (SPEC L3)", async (t) => {
	const env = await isolateClioEnv("session-at-rest-");
	const session = createSession();
	t.after(async () => {
		await session.close();
		env.restore();
	});
	const parent = session.create({ cwd: env.dir, target: "gateway", model: "solver" });
	const user = session.append({ parentId: null, kind: "user", payload: { text: "Fix checkpoint output" } });
	session.append({ parentId: user.id, kind: "assistant", payload: { text: "Investigating" } });
	await session.close();
	const parentFile = readFileSync(sessionPaths(parent).current, "utf8");
	const parentMeta = readFileSync(sessionPaths(parent).meta, "utf8");

	const child = session.forkFrom(parent.id, { name: "beta" });
	assert.equal(child.name, "beta");
	assert.equal(child.parentSessionId, parent.id);
	assert.equal(JSON.parse(readFileSync(sessionPaths(child).meta, "utf8")).name, "beta", "the name is part of creation");
	await session.close();
	assert.equal(readFileSync(sessionPaths(parent).current, "utf8"), parentFile, "the parent ledger is untouched");
	assert.equal(readFileSync(sessionPaths(parent).meta, "utf8"), parentMeta, "the parent meta is untouched");
	assert.equal(resolveSessionIdForCwd(env.dir, "beta"), child.id, "a resume target resolves by name");

	assert.equal(renameSessionAtRest(parent.id, "alpha"), null);
	assert.equal(listSessionsForCwd(env.dir).find((meta) => meta.id === parent.id)?.name, "alpha");
	assert.deepEqual(sessionRemovalRefusal(parent.id), { kind: "children", children: [child.id] });

	// Another live process on this host holds the parent: the registry alone is enough to refuse.
	const now = new Date().toISOString();
	mkdirSync(liveSessionsDir(), { recursive: true });
	writeFileSync(
		liveRecordPath(parent.id),
		`${JSON.stringify({ schema: 1, id: parent.id, cwd: env.dir, cwdHash: cwdHash(env.dir), host: hostname(), pid: process.ppid, birth: null, startedAt: now, at: now, surface: "run", version: "0.0.0", user: "u" })}\n`,
	);
	assert.equal(sessionRemovalRefusal(parent.id)?.kind, "live");
	// A resume refuses with the typed error whose C17 slug a run carries to its exit-2 cause (SPEC L3, 6.7).
	assert.throws(
		() => session.resume(parent.id),
		(error: unknown) => error instanceof SessionLiveError && error.slug === "session_live",
	);
	assert.equal(renameSessionAtRest(parent.id, "gamma")?.pid, process.ppid);
	// session compact refuses the held session before it boots anything (SPEC L3c).
	const compactScript = `process.chdir(${JSON.stringify(env.dir)}); process.argv = [process.execPath, "clio-coder", "session", "compact", ${JSON.stringify(parent.id)}, "--json"]; await import(${JSON.stringify(join(process.cwd(), "src/cli/index.ts"))});`;
	const refused = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", compactScript], {
		env: process.env,
		encoding: "utf8",
	});
	assert.equal(refused.status, 1, refused.stderr);
	assert.equal(JSON.parse(refused.stdout).error.code, "session_live");
	assert.throws(() => session.resume(parent.id), new RegExp(`${process.ppid}`));
	assert.equal(session.forkFrom(parent.id).parentSessionId, parent.id, "a live parent can still be forked");
	await session.close();

	// The owner died: terminate --force releases the record and points at the resume flag, not the retired alias.
	writeFileSync(
		liveRecordPath(parent.id),
		`${JSON.stringify({ schema: 1, id: parent.id, cwd: env.dir, cwdHash: cwdHash(env.dir), host: hostname(), pid: 99_999_999, birth: null, startedAt: now, at: now, surface: "run", version: "0.0.0", user: "u" })}\n`,
	);
	const script = `process.argv = [process.execPath, "clio-coder", "session", "terminate", ${JSON.stringify(parent.id)}, "--force", "--json"]; await import(${JSON.stringify(join(process.cwd(), "src/cli/index.ts"))});`;
	const terminated = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
		env: process.env,
		encoding: "utf8",
	});
	assert.equal(terminated.status, 0, terminated.stderr);
	assert.match(terminated.stdout, new RegExp(`clio-coder run --resume ${parent.id}`));
	assert.doesNotMatch(terminated.stdout, /run --session/);
	rmSync(liveRecordPath(parent.id), { force: true });

	removeSessionAtRest(child.id);
	assert.equal(
		listSessionsForCwd(env.dir).some((meta) => meta.id === child.id),
		false,
	);
});
