import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { test } from "node:test";
import {
	applyAttachEvent,
	attachInputCommand,
	createAttachClientView,
	renderAttachEvent,
} from "../../src/domains/attach/client.js";
import {
	type AttachActor,
	type AttachConnection,
	type AttachSessionPort,
	createAttachHost,
} from "../../src/domains/attach/host.js";
import {
	type AttachApprovalView,
	type AttachRole,
	type AttachServerEvent,
	attachApprovalView,
	attachRoleAllows,
	effectiveAttachRole,
	parseAttachCommand,
	parseAttachEvent,
} from "../../src/domains/attach/protocol.js";

const CARD: AttachApprovalView = {
	requestId: "req-1",
	tool: "bash",
	actionClass: "system_modify",
	origin: { kind: "main" },
	reason: "autonomy asks",
	target: "rm -rf build",
};

function harness(initialCeiling: AttachRole | null) {
	let ceiling = initialCeiling;
	const listeners = new Set<() => void>();
	const notices: string[] = [];
	const resolved: Array<{ requestId: string; decision: string; by: AttachActor }> = [];
	const said: Array<{ text: string; by: AttachActor }> = [];
	const pending = new Map<string, AttachApprovalView>([[CARD.requestId, CARD]]);
	const session: AttachSessionPort = {
		sessionId: () => "s1",
		transcript: () => [{ kind: "request", text: "fix the build" }],
		status: () => ({ phase: "tool_blocked" }),
		pendingApprovals: () => [...pending.values()],
		resolveApproval: (requestId, decision, by) => {
			if (!pending.delete(requestId)) return { status: "stale" };
			resolved.push({ requestId, decision, by });
			return { status: "resolved" };
		},
		say: (text, by) => {
			said.push({ text, by });
			return { status: "accepted", via: "steer" };
		},
	};
	const host = createAttachHost({
		session,
		consent: {
			ceiling: () => ceiling,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		notice: (level, text) => notices.push(`${level}: ${text}`),
	});
	const join = (role: AttachRole, label?: string) => {
		const events: AttachServerEvent[] = [];
		let closed = false;
		const connection: AttachConnection = {
			send: (line) => {
				const event = parseAttachEvent(line);
				ok(event, `host sent a line the client parses: ${line}`);
				events.push(event);
			},
			close: () => {
				closed = true;
			},
		};
		const channel = host.connect(connection);
		channel.receive(JSON.stringify({ v: 1, type: "hello", role, ...(label !== undefined ? { label } : {}) }));
		return {
			events,
			channel,
			isClosed: () => closed,
			send: (command: object) => channel.receive(JSON.stringify(command)),
		};
	};
	const setCeiling = (next: AttachRole | null) => {
		ceiling = next;
		for (const listener of listeners) listener();
	};
	return { host, join, notices, resolved, said, setCeiling };
}

test("a client holds the lower of the role it asked for and the host ceiling, and each role sends only its commands", () => {
	equal(effectiveAttachRole("pair", "observer"), "observer");
	equal(effectiveAttachRole("observer", "pair"), "observer");
	equal(effectiveAttachRole("approver", "approver"), "approver");
	equal(effectiveAttachRole("pair", null), null);
	deepStrictEqual(
		(["observer", "approver", "pair"] as const).map((role) => [
			attachRoleAllows(role, "approve"),
			attachRoleAllows(role, "deny"),
			attachRoleAllows(role, "say"),
		]),
		[
			[false, false, false],
			[true, true, false],
			[true, true, true],
		],
	);
});

test("only well-formed v1 commands parse; everything else is a structured refusal", () => {
	const code = (line: string) => {
		const parsed = parseAttachCommand(line);
		return parsed.ok ? "ok" : parsed.code;
	};
	equal(code("not json"), "malformed");
	equal(code(JSON.stringify({ v: 2, type: "hello", role: "observer" })), "unsupported-version");
	equal(code(JSON.stringify({ v: 1, type: "exec", cmd: "ls" })), "unknown-type");
	equal(code(JSON.stringify({ v: 1, type: "approve", requestId: "../x" })), "malformed");
	equal(code(JSON.stringify({ v: 1, type: "say", text: "hi", steering: "interrupt" })), "malformed");
	equal(code(JSON.stringify({ v: 1, type: "say", text: "a\u001b[2Jb" })), "malformed");
	equal(code(JSON.stringify({ v: 1, type: "say", text: "x".repeat(9_000) })), "malformed");
	deepStrictEqual(parseAttachCommand(JSON.stringify({ v: 1, type: "hello", role: "pair", label: "ana <b>" })), {
		ok: true,
		value: { type: "hello", role: "pair", label: "anab" },
	});
	// The card view keeps only the fields that may leave the host process.
	deepStrictEqual(Object.keys(attachApprovalView({ ...CARD, reason: "r" })).sort(), [
		"actionClass",
		"origin",
		"reason",
		"requestId",
		"target",
		"tool",
	]);
});

test("the host admits by role, routes answers and messages to the session, and attributes every action", () => {
	const h = harness("approver");
	const watcher = h.join("pair", "ana");
	deepStrictEqual(
		watcher.events.map((event) => event.type),
		["hello", "replay", "status", "approval.open", "presence"],
	);
	equal(watcher.events[0]?.type === "hello" ? watcher.events[0].role : null, "approver");
	ok(h.notices.includes("info: attach c1 (ana) joined as approver (asked for pair)"));

	// Above its role: refused before the session sees it, and the host is told.
	watcher.send({ v: 1, type: "say", text: "look at tests" });
	equal(h.said.length, 0);
	match(JSON.stringify(watcher.events.at(-1)), /"code":"forbidden"/);
	ok(h.notices.includes("warn: attach c1 (ana) (approver) tried to send a message; refused"));

	// A stale id never reaches the session; the pending one resolves exactly once.
	watcher.send({ v: 1, type: "deny", requestId: "req-9" });
	match(JSON.stringify(watcher.events.at(-1)), /"code":"stale"/);
	watcher.send({ v: 1, type: "approve", requestId: "req-1" });
	deepStrictEqual(h.resolved, [
		{ requestId: "req-1", decision: "approve", by: { clientId: "c1", role: "approver", label: "ana" } },
	]);
	ok(h.notices.includes("warn: attach c1 (ana) approved bash call (request req-1)"));
	watcher.send({ v: 1, type: "approve", requestId: "req-1" });
	equal(h.resolved.length, 1);

	// Raising the ceiling never lifts a client above what it asked for; lifting it to pair here does.
	h.setCeiling("pair");
	deepStrictEqual(watcher.events.at(-2), { v: 1, type: "role", role: "pair" });
	watcher.send({ v: 1, type: "say", text: "focus on\ntests/contracts" });
	deepStrictEqual(h.said, [{ text: "focus on\ntests/contracts", by: { clientId: "c1", role: "pair", label: "ana" } }]);
	ok(h.notices.includes("info: attach c1 (ana) said (steer): focus on tests/contracts"));

	// The host stops admitting: the client is told why and its stream closed.
	h.setCeiling(null);
	deepStrictEqual(watcher.events.at(-1), { v: 1, type: "bye", reason: "the host stopped admitting attach clients" });
	ok(watcher.isClosed());
	deepStrictEqual(h.host.presence(), []);

	// With no ceiling a newcomer is refused at hello and dropped.
	const late = h.join("observer");
	equal(late.events[0]?.type === "error" ? late.events[0].code : null, "not-admitted");
	ok(late.isClosed());
});

test("the attached terminal folds the stream, renders cards and turns typed lines into allowed commands only", () => {
	const view = createAttachClientView();
	const events: AttachServerEvent[] = [
		{ v: 1, type: "hello", clientId: "c2", sessionId: "s1", role: "observer" },
		{ v: 1, type: "approval.open", request: CARD },
	];
	const lines = events.flatMap((event) => {
		applyAttachEvent(view, event);
		return renderAttachEvent(event, view);
	});
	ok(lines.includes("! approval req-1: bash (system_modify)"));
	ok(lines.includes("  target: rm -rf build"));
	deepStrictEqual(attachInputCommand(":approve", view), { problem: "observer cannot answer a card" });
	deepStrictEqual(attachInputCommand("hello", view), { problem: "observer cannot message the session" });
	applyAttachEvent(view, { v: 1, type: "role", role: "pair" });
	deepStrictEqual(attachInputCommand(":approve", view), { command: { type: "approve", requestId: "req-1" } });
	deepStrictEqual(attachInputCommand("/model x", view), { command: { type: "say", text: "/model x" } });
	deepStrictEqual(attachInputCommand(":quit", view), { quit: true });
	applyAttachEvent(view, { v: 1, type: "approval.closed", requestId: "req-1", status: "granted" });
	deepStrictEqual(attachInputCommand(":deny", view), { problem: "no card is open" });
});
