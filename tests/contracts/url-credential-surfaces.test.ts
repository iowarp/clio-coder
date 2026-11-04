import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	createHeadlessJsonProjector,
	createJsonCredentialScrub,
	projectDispatchJsonEvent,
} from "../../src/cli/modes/json-stream.js";
import { runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { withRunFailureReporting, writeRunDiagnostic } from "../../src/cli/run-failure.js";
import { formatDispatchHumanOutput } from "../../src/cli/run-output.js";
import { clioStateDir } from "../../src/core/xdg.js";
import type { RunEventJournalBody } from "../../src/domains/dispatch/run-event-journal.js";
import { appendRunFeed, runFeedPath } from "../../src/domains/dispatch/run-feed.js";
import { createRedactionTally, redactSecretSegments, redactSecretsText } from "../../src/domains/evidence/redact.js";
import {
	endsInOpenCredential,
	holdUnresolvedUserinfo,
	redactFinalUrlCredentials,
	redactSecretString,
	redactUrlCredentials,
	UrlCredentialStreamFilter,
} from "../../src/domains/safety/redaction.js";
import { serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import { ACP_MAX_STRING_BYTES } from "../../src/engine/acp/types.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// Secrets draw on letters nothing else here uses, so one leaked character is enough to fail.
const SECRET_LETTERS = /[ZQXJ]/u;

test("one-shot redaction leaves compact JSON valid and untouched when it holds no credential", () => {
	for (const text of [
		'{"url":"https://example.com","email":"a@b.com"}',
		'{"a":"http://h:8080","b":"me@corp.com"}',
		'{"a":"https://h:abc/def","b":"me@corp.com"}',
		'["https://example.com:443","me@corp.com"]',
		'{"a":"https://example.com"}@x',
		'{\\"a\\":\\"http://h:8080\\",\\"b\\":\\"me@corp.com\\"}',
		'<a href="https://example.com:443">me@corp.com</a>',
		'f("https://example.com",me@corp.com)',
	]) {
		strictEqual(redactUrlCredentials(text), text);
		strictEqual(redactSecretString(text), text);
	}
});

test("one-shot redaction hides a credential in compact JSON and the JSON still parses", () => {
	for (const [text, redacted] of [
		['{"a":"https://u:ZQ@h/x","b":"me@corp.com"}', '{"a":"https://u:[redacted]@h/x","b":"me@corp.com"}'],
		['{"u":"https://h/?token=ZQ","e":"a@b.com"}', '{"u":"https://h/?token=[redacted]","e":"a@b.com"}'],
		['{"u":"https://me@corp.com:ZQ@h/","e":"a@b.com"}', '{"u":"https://me@corp.com:[redacted]@h/","e":"a@b.com"}'],
	] as const) {
		strictEqual(redactUrlCredentials(text), redacted);
		deepStrictEqual(Object.keys(JSON.parse(redacted)).length, 2);
	}
	// A quote with no structure after it is still password, so the rule cannot be used to show one.
	for (const text of ['https://u:Z"Q@h', 'https://u:Z"$Q@h', 'https://u:ZQ"@h', 'https://h/?token="ZQ"']) {
		ok(!SECRET_LETTERS.test(redactUrlCredentials(text)), text);
	}
});

test("one-shot redaction survives a run of millions of quotes", () => {
	const quotes = '"a'.repeat(8_000_000);
	for (const text of [`a://x:${quotes}`, `?token=${quotes}`, `a://${quotes}`]) ok(redactUrlCredentials(text).length > 0);
});

test("one-shot redaction reads an @ in the name, and a name with an @ has no reach past the path", () => {
	strictEqual(redactUrlCredentials("https://me@corp.com:hunter2@host/"), "https://me@corp.com:[redacted]@host/");
	for (const text of [
		"ssh://git@github.com:org/repo.git@v1",
		"ssh://git@host:2222/path@tag",
		"https://me@corp.com:8080/a@b",
		"https://me@corp.com/a:b@c",
	]) {
		strictEqual(redactUrlCredentials(text), text);
	}
});

test("a frame releases what a closing quote settled and still holds what a quote cannot settle", () => {
	const settled = '{"u":"https://x.io:80","d":"ppp';
	strictEqual(holdUnresolvedUserinfo(settled), settled);
	strictEqual(holdUnresolvedUserinfo('{"u":"https://u:hun"'), '{"u":"https://u:');
	strictEqual(holdUnresolvedUserinfo('https://u:Z"Q'), "https://u:");
	strictEqual(holdUnresolvedUserinfo("https://me@corp.com:hunter"), "https://me@corp.com:");
	strictEqual(holdUnresolvedUserinfo("https://me@corp.com:8080/x"), "https://me@corp.com:8080/x");
	strictEqual(holdUnresolvedUserinfo("https://me@corp.com:hunter2@ho"), "https://me@corp.com:hunter2@");
});

const MESSAGE_STOP: RunEventJournalBody = { kind: "event", type: "message_end", stopReason: "stop" };

/** Feed a run through the writer and read back the text of its rows. */
function feedText(runId: string, ...items: (string | RunEventJournalBody)[]): string[] {
	for (const item of items) {
		appendRunFeed(runId, typeof item === "string" ? { kind: "event", type: "text", detail: item } : item);
	}
	return readFileSync(runFeedPath(runId, clioStateDir()), "utf8")
		.trim()
		.split("\n")
		.map((raw) => JSON.parse(raw) as { type?: string; detail?: string })
		.filter((row) => row.type === "text")
		.map((row) => row.detail ?? "");
}

test("a run feed keeps every word of compact JSON longer than its carry", async () => {
	const env = await isolateClioEnv("url-surfaces-feed-");
	try {
		const body = "p".repeat(3000);
		const head = `{"u":"https://x.io","d":"${body}`;
		const tail = '","e":1} and the next words follow ';
		strictEqual(feedText("compact", head, body, tail, MESSAGE_STOP).join(""), head + body + tail);
		const credential = `{"u":"https://u:ZQXJ@h/x","d":"${body}`;
		const rows = feedText("compact-secret", credential, body, tail, MESSAGE_STOP).join("");
		ok(!SECRET_LETTERS.test(rows), rows.slice(0, 80));
		ok(rows.endsWith(body + tail), rows.slice(-60));
	} finally {
		env.restore();
	}
});

test("a run feed bound never leaves a secret query value without its name", async () => {
	const env = await isolateClioEnv("url-surfaces-feed-");
	try {
		const long = "a".repeat(4090);
		const rows = feedText(
			"query",
			`https://h/?x=${long}&token=ZQXJZQXJ`,
			"ZQXJZQXJ&y=1 and the rest follows here ",
			MESSAGE_STOP,
		);
		ok(!rows.join("\n").match(SECRET_LETTERS), JSON.stringify(rows.map((row) => row.slice(-40))));
		ok(rows.join("").endsWith("&y=1 and the rest follows here "), rows.join("").slice(-60));
		ok(rows.join("").includes(long));
		const value = feedText(
			"long-value",
			`https://h/?token=ZQ${"X".repeat(5000)}`,
			"ZQXJZQXJ more words to follow ",
			MESSAGE_STOP,
		);
		ok(!value.join("\n").match(SECRET_LETTERS), JSON.stringify(value.map((row) => row.slice(0, 60))));
	} finally {
		env.restore();
	}
});

test("an append-only stream waits on a long token in linear time and joins to the one-shot output", () => {
	for (const head of ["https://example.com/", "a&&b", "x:"]) {
		const filter = new UrlCredentialStreamFilter();
		const delta = "abcdefgh";
		let sent = filter.push(head);
		const count = 400_000 / delta.length;
		const started = performance.now();
		for (let index = 0; index < count; index += 1) sent += filter.push(delta);
		const elapsed = performance.now() - started;
		// 200 KB took 25.7 s when every delta rescanned the open token, and a linear walk takes a few milliseconds.
		ok(elapsed < 1500, `${head}: ${elapsed} ms`);
		sent += filter.push(" tail ");
		sent += filter.end(true);
		strictEqual(sent, redactUrlCredentials(`${head}${delta.repeat(count)} tail `));
	}
	// A short run ahead of the wait can still resolve, so the wait must not begin before it is certain.
	const colon = new UrlCredentialStreamFilter();
	strictEqual(colon.push("see a:"), "see a");
	strictEqual(colon.push("/"), "");
	strictEqual(colon.push("b"), ":/b");
	const open = new UrlCredentialStreamFilter();
	strictEqual(open.push("a:"), "a");
	strictEqual(open.push("/"), "");
	strictEqual(open.push("/u:ZQ"), "");
	strictEqual(open.push("@h next "), "://u:[redacted]@h next ");
});

test("a stream cut off inside an opaque username sends none of it", () => {
	const filter = new UrlCredentialStreamFilter();
	const pushed = filter.push("clone https://abcdef0123456789abcdef0123456789");
	strictEqual(pushed + filter.end(false), "clone https://");
	const host = new UrlCredentialStreamFilter();
	strictEqual(host.push("see https://example.com") + host.end(false), "see https://example.com");
	const done = new UrlCredentialStreamFilter();
	strictEqual(
		done.push("https://abcdef0123456789abcdef0123456789") + done.end(true),
		"https://abcdef0123456789abcdef0123456789",
	);
});

test("--json tool progress holds an open URL and leaves complete args alone", () => {
	const progress = {
		type: "tool_execution_update",
		toolCallId: "t",
		toolName: "bash",
		args: { url: "postgres://db:5432" },
		partialResult: { content: [{ type: "text", text: "cloning https://u:hunter" }] },
	};
	const [frame] = createHeadlessJsonProjector().project(progress as never) as unknown as (typeof progress)[];
	strictEqual(frame?.partialResult.content[0]?.text, "cloning https://u:");
	strictEqual(frame?.args.url, "postgres://db:5432");
});

const updateFrame = (inner: object): unknown =>
	projectDispatchJsonEvent({ type: "message_update", assistantMessageEvent: inner });
const innerOf = (frames: unknown[]): Record<string, unknown>[] =>
	frames.map((frame) => (frame as { assistantMessageEvent: Record<string, unknown> }).assistantMessageEvent);

test("--json dispatch tool-call fragments reassemble with the password gone, per call", () => {
	const scrub = createJsonCredentialScrub();
	const toolDelta = (contentIndex: number, delta: string): unknown =>
		updateFrame({ type: "toolcall_delta", contentIndex, delta });
	const frames = [
		...scrub.scrub(toolDelta(1, '{"url":"https://u:hun')),
		...scrub.scrub(toolDelta(2, '{"url":"https://v:ZQ')),
		...scrub.scrub(toolDelta(1, 'ter2@host/x"}')),
		...scrub.scrub(toolDelta(2, 'XJ@host/y"}')),
		...scrub.scrub(updateFrame({ type: "toolcall_end", contentIndex: 1, toolCall: { name: "bash" } })),
		...scrub.scrub(updateFrame({ type: "toolcall_end", contentIndex: 2, toolCall: { name: "bash" } })),
		...scrub.finish(true),
	];
	const deltas = (index: number): string =>
		innerOf(frames)
			.filter((inner) => inner.contentIndex === index && inner.type === "toolcall_delta")
			.map((inner) => inner.delta)
			.join("");
	strictEqual(deltas(1), '{"url":"https://u:[redacted]@host/x"}');
	strictEqual(deltas(2), '{"url":"https://v:[redacted]@host/y"}');
});

test("a tool call cut off inside a URL sends none of the password", () => {
	const scrub = createJsonCredentialScrub();
	const frames = [
		...scrub.scrub(updateFrame({ type: "toolcall_delta", contentIndex: 0, delta: '{"url":"https://u:hunter' })),
		...scrub.finish(false),
	];
	ok(!JSON.stringify(frames).includes("hunter"), JSON.stringify(frames));
});

test("completed --json streams keep ports in tool results, user messages and finished blocks", () => {
	const projector = createHeadlessJsonProjector();
	const toolResult = {
		role: "toolResult",
		toolCallId: "t",
		toolName: "bash",
		content: [{ type: "text", text: "Server at http://localhost:8080" }],
	};
	const user = { role: "user", content: [{ type: "text", text: "connect to postgres://db.internal:5432" }] };
	for (const type of ["message_start", "message_end"]) {
		deepStrictEqual(projector.project({ type, message: toolResult } as never), [{ type, message: toolResult }]);
		deepStrictEqual(projector.project({ type, message: user } as never), [{ type, message: user }]);
	}
	const finished = (inner: object): Record<string, unknown> | undefined => {
		const scrub = createJsonCredentialScrub();
		const stop = { role: "assistant", stopReason: "stop", content: [] };
		const frames = [...scrub.scrub(updateFrame(inner)), ...scrub.scrub({ type: "message_end", message: stop })];
		return innerOf(frames.filter((frame) => (frame as { type?: string }).type === "message_update"))[0];
	};
	const toolCall = { type: "toolCall", id: "c", name: "bash", arguments: { url: "postgres://db:5432" } };
	deepStrictEqual(finished({ type: "toolcall_end", contentIndex: 1, toolCall })?.toolCall, toolCall);
	const text = "see http://localhost:8080";
	strictEqual(finished({ type: "text_end", contentIndex: 0, content: text })?.content, text);
	strictEqual(finished({ type: "thinking_end", contentIndex: 0, content: text })?.content, text);
	// A finished block still loses a password, and a cut-off assistant message still holds.
	strictEqual(
		finished({ type: "text_end", contentIndex: 0, content: "https://u:ZQXJ@h/x" })?.content,
		"https://u:[redacted]@h/x",
	);
	const scrub = createJsonCredentialScrub();
	const cut = {
		role: "assistant",
		stopReason: "aborted",
		content: [{ type: "toolCall", arguments: { u: "https://u:ZQXJ" } }],
	};
	ok(!SECRET_LETTERS.test(JSON.stringify(scrub.scrub({ type: "message_end", message: cut }))));
});

test("a finished block with nothing open goes out at once, and an open one waits for its message's stop reason", () => {
	const closed = createJsonCredentialScrub();
	strictEqual(closed.scrub(updateFrame({ type: "text_end", contentIndex: 0, content: "done here" })).length, 1);
	const end = updateFrame({ type: "text_end", contentIndex: 0, content: "open https://u:hun" });
	const delta = updateFrame({ type: "text_delta", contentIndex: 0, delta: "open https://u:hun" });
	// Providers end the open block before a message the token limit stopped, so a block end alone says nothing.
	const stopped = (stopReason: string): string => {
		const scrub = createJsonCredentialScrub();
		const message = { role: "assistant", stopReason, content: [] };
		const before = [...scrub.scrub(delta), ...scrub.scrub(end)];
		ok(!JSON.stringify(before).includes("hun"), JSON.stringify(before));
		return JSON.stringify([...before, ...scrub.scrub({ type: "message_end", message })]);
	};
	ok(stopped("stop").includes('"content":"open https://u:hun"'));
	ok(!stopped("length").includes("hun"), stopped("length"));
	ok(stopped("length").includes('"content":"open https://u:"'), stopped("length"));
	const dead = createJsonCredentialScrub();
	const frames = [...dead.scrub(delta), ...dead.scrub(end), ...dead.finish(false)];
	ok(!JSON.stringify(frames).includes("hun"), JSON.stringify(frames));
	strictEqual(innerOf(frames).at(-1)?.type, "text_end");
});

test("a new attempt, or any message start, closes an open URL as cut off", () => {
	const textDelta = (delta: string): unknown => updateFrame({ type: "text_delta", contentIndex: 0, delta });
	const textOf = (frames: unknown[]): string =>
		innerOf(frames.filter((frame) => (frame as { type?: string }).type === "message_update"))
			.map((inner) => inner.delta)
			.join("");
	const failover = createJsonCredentialScrub();
	strictEqual(
		textOf([
			...failover.scrub(textDelta("see https://u:hun")),
			...failover.scrub(projectDispatchJsonEvent({ type: "attempt_start", runId: "r2" })),
			...failover.scrub(textDelta("Hello there ")),
		]),
		"see https://u:Hello there ",
	);
	for (const message of [
		{ role: "assistant", stopReason: "stop", content: [] },
		{ role: "user", content: [{ type: "text", text: "task" }] },
	]) {
		const scrub = createJsonCredentialScrub();
		const frames = [
			...scrub.scrub(textDelta("see https://u:hun")),
			...scrub.scrub(projectDispatchJsonEvent({ type: "message_start", message })),
		];
		strictEqual(textOf(frames), "see https://u:");
	}
});

test("a --json result frame holds partial output and keeps final output whole", () => {
	const scrub = createJsonCredentialScrub();
	const output = (state: string, text: string): unknown => {
		const [frame] = scrub.scrub({ type: "result", result: { exitCode: 1, output: { state, text } } });
		return (frame as { result: { output: { text: string } } }).result.output.text;
	};
	strictEqual(output("partial", "see https://u:hunter"), "see https://u:");
	strictEqual(output("final", "see http://localhost:8080"), "see http://localhost:8080");
	strictEqual(output("final", "see https://u:ZQ@h/"), "see https://u:[redacted]@h/");
});

test("the human answer of a run that was cut off holds an open URL", () => {
	const unknown = { kind: "unknown", reason: "not-observed" };
	const receipt = (fields: object): never =>
		({
			runId: "r",
			agentId: "a",
			exitCode: 1,
			targetId: "t",
			wireModelId: "m",
			startedAt: "2026-01-01T00:00:00Z",
			endedAt: "2026-01-01T00:00:01Z",
			spend: { totalTokens: unknown, usage: { reasoning: unknown } },
			quality: {},
			...fields,
		}) as never;
	const first = (answer: string, fields: object): string =>
		formatDispatchHumanOutput(answer, receipt(fields)).split("\n")[0] ?? "";
	strictEqual(first("see https://u:hunter", { output: { state: "partial", text: "x" } }), "see https://u:");
	strictEqual(first("see https://u:hunter", {}), "see https://u:");
	strictEqual(first("see http://h:8080", { exitCode: 0 }), "see http://h:8080");
	strictEqual(first("see http://h:8080", { output: { state: "final", text: "x" } }), "see http://h:8080");
});

const CREDENTIAL_URL = "https://alice:hunter2@git.example.com/r.git";
const SAFE_URL = "https://alice:[redacted]@git.example.com/r.git";

/** Run a headless turn over a stub chat that settles one message, and read what reached stdout. */
async function headlessStdout(
	mode: "text" | "json",
	jsonEvents: string | undefined,
	message: object,
	events: object[] = [],
	stderr: string[] = [],
): Promise<string> {
	let handler: (event: unknown) => void = () => {};
	const stub: Record<string, unknown> = {
		onEvent: (next: (event: unknown) => void) => {
			handler = next;
			return () => {};
		},
		getSessionId: () => null,
		submit: async () => {
			handler({ type: "agent_start" });
			for (const event of events) handler(event);
			handler({ type: "message_end", message });
			handler({ type: "turn_end", message, toolResults: [] });
			handler({ type: "agent_end", messages: [message] });
		},
		whenSettled: async () => {},
		lastRunSnapshot: () => null,
		isStreaming: () => false,
	};
	const chat = new Proxy(stub, { get: (target, key) => (key in target ? target[key as string] : undefined) });
	const written: string[] = [];
	const write = process.stdout.write;
	const writeError = process.stderr.write;
	process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
		written.push(String(chunk));
		for (const argument of rest) if (typeof argument === "function") argument();
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderr.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		await runHeadlessMainAgent(
			chat as never,
			{
				prompt: "x",
				mode,
				...(jsonEvents !== undefined ? { jsonEvents } : {}),
				shutdown: { onDrain() {}, getExitCode: () => 0, isShuttingDown: () => false },
			} as never,
		);
	} finally {
		process.stdout.write = write;
		process.stderr.write = writeError;
	}
	return written.join("");
}

const assistantAnswer = (text: string, stopReason = "stop"): object => ({
	role: "assistant",
	stopReason,
	content: [{ type: "text", text }],
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
});

test("a headless main-agent answer hides URL credentials at both exits", async () => {
	const answer = `Use ${CREDENTIAL_URL} to clone, BASE_TOKENS=100 and --token to pass`;
	const shown = `Use ${SAFE_URL} to clone, BASE_TOKENS=100 and --token to pass`;
	const env = await isolateClioEnv("url-surfaces-headless-");
	try {
		const text = await headlessStdout("text", undefined, assistantAnswer(answer));
		ok(!text.includes("hunter2"), text);
		ok(text.includes(shown), text);
		const terminal = await headlessStdout("json", "terminal", assistantAnswer(answer));
		ok(!terminal.includes("hunter2"), terminal);
		ok(terminal.includes(shown), terminal);
		const whole = await headlessStdout("text", undefined, assistantAnswer("open http://localhost:8080"));
		ok(whole.includes("open http://localhost:8080"), whole);
		const cut = await headlessStdout("text", undefined, assistantAnswer("see https://u:hunter", "length"));
		ok(!cut.includes("hunter"), cut);
		const endFrame = await headlessStdout("json", "terminal", assistantAnswer("see https://u:hunter", "length"));
		ok(!endFrame.includes("hunter"), endFrame);
	} finally {
		env.restore();
	}
});

interface AcpFake {
	transport: AcpJsonRpcPeerTransport;
	updates: () => Record<string, unknown>[];
	call: (method: string, params: unknown) => Promise<unknown>;
}

function acpFake(): AcpFake {
	const handlers = new Map<string, (params: unknown) => unknown>();
	const updates: Record<string, unknown>[] = [];
	const closers: (() => void)[] = [];
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async () => ({}) as never,
		notify: (method, params) => {
			if (method === "session/update") updates.push((params as { update: Record<string, unknown> }).update);
		},
		onRequest: (name, handler) => {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
		onNotification: () => () => {},
		onClose: (handler) => {
			closers.push(handler);
			return () => {};
		},
		close: () => {
			for (const closer of closers) closer();
		},
	};
	return {
		transport,
		updates: () => updates,
		call: async (method, params) => await handlers.get(method)?.(params),
	};
}

test("ACP raw records carry no URL password on a live call", async () => {
	const url = CREDENTIAL_URL;
	const bashEnd = {
		content: [{ type: "text", text: `fatal: ${url}` }],
		details: { stderr: `fatal: ${url}`, nested: [{ deep: url }] },
	};
	const live = acpFake();
	let emit: (event: unknown) => void = () => {};
	const served = serveClioAcpAgent({
		transport: live.transport,
		cwd: process.cwd(),
		chat: {
			submit: async () => {
				emit({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: `git clone ${url}` } });
				emit({ type: "tool_execution_end", toolCallId: "c", toolName: "bash", result: bashEnd, isError: true });
				emit({ type: "message_end", message: assistantAnswer("done") });
			},
			cancel: () => {},
			onEvent: (handler: (event: unknown) => void) => {
				emit = handler;
				return () => {};
			},
			isStreaming: () => false,
			getSessionId: () => null,
		},
	} as never);
	await live.call("initialize", { protocolVersion: 1 });
	const created = (await live.call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	await live.call("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text: "go" }] });
	live.transport.close();
	await served;
	const wire = JSON.stringify(live.updates());
	ok(!wire.includes("hunter2"), wire);
	const start = live.updates().find((update) => update.sessionUpdate === "tool_call");
	deepStrictEqual(start?.rawInput, { command: `git clone ${SAFE_URL}` });
	const settled = live.updates().find((update) => update.sessionUpdate === "tool_call_update");
	ok(JSON.stringify(settled?.rawOutput).includes(`fatal: ${SAFE_URL}`), JSON.stringify(settled?.rawOutput));
});

test("an ACP raw record redacts ahead of its bound, so a cut cannot strip a password's scheme", async () => {
	const live = acpFake();
	let emit: (event: unknown) => void = () => {};
	const served = serveClioAcpAgent({
		transport: live.transport,
		cwd: process.cwd(),
		chat: {
			submit: async () => {
				const long = `${"x".repeat(ACP_MAX_STRING_BYTES - 64)} https://u:hunter2@h/ ${"y".repeat(64)}`;
				emit({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: long } });
				emit({ type: "message_end", message: assistantAnswer("done") });
			},
			cancel: () => {},
			onEvent: (handler: (event: unknown) => void) => {
				emit = handler;
				return () => {};
			},
			isStreaming: () => false,
			getSessionId: () => null,
		},
	} as never);
	await live.call("initialize", { protocolVersion: 1 });
	const created = (await live.call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	await live.call("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text: "go" }] });
	live.transport.close();
	await served;
	const start = live.updates().find((update) => update.sessionUpdate === "tool_call");
	ok(!JSON.stringify(start?.rawInput).includes("hunter"), "the raw input holds a piece of the password");
});

test("an ACP shell line hides URL passwords in its echo, its live output and its settled output", async () => {
	const env = await isolateClioEnv("url-surfaces-shell-");
	const live = acpFake();
	const meta = {
		id: "acp-shell-446",
		cwd: env.dir,
		cwdHash: "hash",
		createdAt: "2026-11-04T00:00:00.000Z",
		endedAt: null,
		model: null,
		target: null,
	};
	const session = {
		current: () => meta,
		create: () => meta,
		resume: () => meta,
		checkpoint: async () => {},
		flushAppends: () => {},
		tree: () => ({ leafId: null }),
		appendEntry: (entry: object) => ({ ...entry, turnId: "shell" }),
		history: () => [],
		list: () => [],
	};
	const served = serveClioAcpAgent({
		transport: live.transport,
		session,
		cwd: env.dir,
		autonomy: () => "default",
		chat: {
			submit: async () => {},
			whenSettled: async () => {},
			cancel: () => {},
			onEvent: () => () => {},
			isStreaming: () => false,
			getSessionId: () => meta.id,
			resetForSession: () => {},
		},
		labelOperatorCommand: () => null,
		readSessionEntries: () => [],
		buildReplayMessages: () => [],
	} as never);
	try {
		await live.call("initialize", {
			protocolVersion: 1,
			clientCapabilities: { _meta: { "clio-coder/toolProgress": { version: 1 } } },
		});
		await live.call("session/new", { cwd: env.dir, mcpServers: [] });
		const result = (await live.call("_clio-coder/session/shell", {
			sessionId: meta.id,
			command: `echo ${CREDENTIAL_URL}`,
		})) as { output: string };
		const wire = JSON.stringify(live.updates());
		ok(!wire.includes("hunter2"), wire);
		ok(!result.output.includes("hunter2"), result.output);
		ok(result.output.includes(SAFE_URL), result.output);
		const started = live.updates().find((update) => update.sessionUpdate === "tool_call");
		deepStrictEqual(started?.rawInput, { command: `echo ${SAFE_URL}`, excludeFromContext: false });
		strictEqual(started?.title, `echo ${SAFE_URL}`);
		// Written so the command's own echo holds no whole password. Only a held frame can keep this off the wire.
		const held = (await live.call("_clio-coder/session/shell", {
			sessionId: meta.id,
			command: "printf 'https://u:hun'; printf 'ter'; sleep 1; printf '2@h/ done\\n'",
		})) as { output: string };
		strictEqual(held.output.trim(), "https://u:[redacted]@h/ done");
		const frames = live
			.updates()
			.filter((update) => update.status === "in_progress" && update.content !== undefined)
			.map((update) => JSON.stringify(update.content));
		ok(frames.length > 0, "no live frame reached the client");
		ok(!frames.some((frame) => frame.includes("hun")), JSON.stringify(frames));
	} finally {
		live.transport.close();
		await served;
		env.restore();
	}
});

const FAILED_FETCH = "fetch failed for https://alice:hunter2@proxy.example/v1, BASE_TOKENS=100 and --token to pass";
const SAFE_FETCH = "fetch failed for https://alice:[redacted]@proxy.example/v1, BASE_TOKENS=100 and --token to pass";

test("a provider's error reaches no headless surface with its URL password, in any mode", async () => {
	const env = await isolateClioEnv("url-surfaces-error-");
	try {
		const failed = { role: "assistant", stopReason: "error", errorMessage: FAILED_FETCH, content: [] };
		for (const [mode, jsonEvents] of [
			["text", undefined],
			["json", "full"],
			["json", "terminal"],
		] as const) {
			const stderr: string[] = [];
			const stdout = await headlessStdout(mode, jsonEvents, failed, [], stderr);
			const where = `${mode}/${jsonEvents}`;
			ok(!stdout.includes("hunter2"), `${where} stdout: ${stdout}`);
			ok(!stderr.join("").includes("hunter2"), `${where} stderr: ${stderr.join("")}`);
			ok(stderr.join("").includes(SAFE_FETCH), `${where} stderr: ${stderr.join("")}`);
			if (jsonEvents === "terminal") {
				const end = stdout.trim().split("\n").at(-1) ?? "";
				strictEqual((JSON.parse(end) as { error?: string }).error, SAFE_FETCH);
			}
		}
	} finally {
		env.restore();
	}
});

test("a run that fails before its output carries no URL password on stderr or its turn_end frame", async () => {
	const written: string[] = [];
	const write = process.stdout.write;
	const writeError = process.stderr.write;
	const capture = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
		written.push(String(chunk));
		for (const argument of rest) if (typeof argument === "function") argument();
		return true;
	}) as typeof process.stdout.write;
	process.stdout.write = capture;
	process.stderr.write = capture;
	try {
		strictEqual(
			await withRunFailureReporting(true, async () => {
				writeRunDiagnostic(`clio-coder run failed: ${FAILED_FETCH}\n`);
				return 1;
			}),
			1,
		);
		await withRunFailureReporting(true, async () => {
			throw new Error(FAILED_FETCH);
		}).catch(() => {});
	} finally {
		process.stdout.write = write;
		process.stderr.write = writeError;
	}
	const output = written.join("");
	ok(!output.includes("hunter2"), output);
	ok(output.includes(SAFE_FETCH), output);
});

test("a blocked call's reason and a transcript notice carry no URL password on a headless run", async () => {
	const env = await isolateClioEnv("url-surfaces-blocked-");
	try {
		const blocked = {
			type: "tool_execution_end",
			toolCallId: "c",
			toolName: "bash",
			isError: true,
			outcome: "blocked",
			blockReason: `refused ${CREDENTIAL_URL}, BASE_TOKENS=100`,
			result: { content: [] },
		};
		const notice = { type: "notice", surface: "transcript", text: "retry https://alice:hunter2@h.example/r" };
		const terminal = await headlessStdout("json", "terminal", assistantAnswer("done"), [blocked, notice]);
		ok(!terminal.includes("hunter2"), terminal);
		const end = JSON.parse(terminal.trim().split("\n").at(-1) ?? "") as {
			safety: { blockedAttempts: { reason?: string }[] };
		};
		strictEqual(end.safety.blockedAttempts[0]?.reason, `refused ${SAFE_URL}, BASE_TOKENS=100`);
		const stderr: string[] = [];
		const text = await headlessStdout("text", undefined, assistantAnswer("done"), [notice], stderr);
		ok(!`${text}${stderr.join("")}`.includes("hunter2"), stderr.join(""));
		ok(stderr.join("").includes("retry https://alice:[redacted]@h.example/r"), stderr.join(""));
	} finally {
		env.restore();
	}
});

test("every ACP client string holds no URL password: notice, locations, tool name and raw record key", async () => {
	const live = acpFake();
	let emit: (event: unknown) => void = () => {};
	const served = serveClioAcpAgent({
		transport: live.transport,
		cwd: process.cwd(),
		chat: {
			submit: async () => {
				emit({ type: "notice", surface: "transcript", text: "retry https://alice:hunter2@h.example/r" });
				emit({
					type: "tool_execution_start",
					toolCallId: "c",
					toolName: "read",
					args: { path: CREDENTIAL_URL, [CREDENTIAL_URL]: "value" },
				});
				emit({
					type: "tool_execution_start",
					toolCallId: "d",
					toolName: `tool ${CREDENTIAL_URL}`,
					args: {},
				});
				emit({
					type: "tool_execution_end",
					toolCallId: "e",
					toolName: `tool ${CREDENTIAL_URL}`,
					result: {},
					isError: true,
				});
				emit({ type: "message_end", message: assistantAnswer("done") });
			},
			cancel: () => {},
			onEvent: (handler: (event: unknown) => void) => {
				emit = handler;
				return () => {};
			},
			isStreaming: () => false,
			getSessionId: () => null,
		},
	} as never);
	await live.call("initialize", { protocolVersion: 1 });
	const created = (await live.call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	await live.call("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text: "go" }] });
	live.transport.close();
	await served;
	const wire = JSON.stringify(live.updates());
	ok(!wire.includes("hunter2"), wire);
	ok(wire.includes("retry https://alice:[redacted]@h.example/r"), wire);
	const read = live.updates().find((update) => update.sessionUpdate === "tool_call") as {
		locations?: { path: string }[];
		rawInput: Record<string, unknown>;
	};
	ok(read.locations?.[0]?.path.includes("alice:[redacted]@git.example.com"), JSON.stringify(read.locations));
	strictEqual(read.rawInput[SAFE_URL], "value");
});

test("ACP replay holds what a stored message that stopped short left open, and keeps what one that stopped finished", async () => {
	const env = await isolateClioEnv("url-surfaces-replay-");
	const live = acpFake();
	const stamp = "2026-11-04T00:00:00.000Z";
	const meta = {
		id: "acp-replay-446",
		cwd: env.dir,
		cwdHash: "hash",
		createdAt: stamp,
		endedAt: null,
		model: null,
		target: null,
	};
	const turn = (id: string, stopReason: string, text: string, parent: string | null): object[] => [
		{ kind: "message", role: "user", turnId: `u-${id}`, parentTurnId: parent, timestamp: stamp, payload: "go" },
		{
			kind: "message",
			role: "assistant",
			turnId: `a-${id}`,
			parentTurnId: `u-${id}`,
			timestamp: stamp,
			payload: { stopReason, content: [{ type: "text", text }] },
		},
	];
	const session = {
		current: () => meta,
		create: () => meta,
		resume: () => meta,
		checkpoint: async () => {},
		flushAppends: () => {},
		tree: () => ({ leafId: null }),
		appendEntry: (entry: object) => entry,
		history: () => [meta],
		list: () => [meta],
		close: async () => {},
	};
	const served = serveClioAcpAgent({
		transport: live.transport,
		session,
		cwd: env.dir,
		autonomy: () => "default",
		chat: {
			submit: async () => {},
			whenSettled: async () => {},
			cancel: () => {},
			onEvent: () => () => {},
			isStreaming: () => false,
			getSessionId: () => meta.id,
			resetForSession: () => {},
		},
		labelOperatorCommand: () => null,
		readSessionEntries: () => [
			...turn("1", "length", "see https://u:hunter", null),
			...turn("2", "length", "clone https://abcdef0123456789abcdef0123456789", "a-1"),
			...turn("3", "stop", "serve http://localhost:8080", "a-2"),
		],
		buildReplayMessages: () => [],
	} as never);
	try {
		await live.call("initialize", { protocolVersion: 1 });
		await live.call("session/load", { sessionId: meta.id, cwd: env.dir, mcpServers: [] });
		const wire = JSON.stringify(live.updates());
		ok(!wire.includes("hunter"), wire);
		ok(!wire.includes("abcdef0123456789"), wire);
		ok(wire.includes("see https://u:"), wire);
		ok(wire.includes("serve http://localhost:8080"), wire);
	} finally {
		live.transport.close();
		await served;
		env.restore();
	}
});

test("a journal hides a short secret query value as the display rule does", async () => {
	const url = "https://h/?password=hunter2&token=abc1234";
	const shown = "https://h/?password=[redacted:url-param]&token=[redacted:url-param]";
	strictEqual(redactSecretsText(url, createRedactionTally()), shown);
	const tally = createRedactionTally();
	redactSecretsText(url, tally);
	strictEqual(tally.count, 2);
	const segments = redactSecretSegments(["https://h/?password=hun", "ter2&token=abc1234"], createRedactionTally()).join(
		"",
	);
	ok(!segments.includes("hunter2") && !segments.includes("ter2") && !segments.includes("abc1234"), segments);
	// A variable's name and an earlier pass's marker stay what they are, and a long value keeps its own marker.
	strictEqual(redactSecretsText("https://h/?token=$TOK", createRedactionTally()), "https://h/?token=$TOK");
	strictEqual(
		redactSecretsText("https://h/?token=abcdefghijkl", createRedactionTally()),
		"https://h/?token=[redacted:assignment]",
	);
	strictEqual(
		redactSecretsText("pass BASE_TOKENS=100 or a&b?c", createRedactionTally()),
		"pass BASE_TOKENS=100 or a&b?c",
	);
	const env = await isolateClioEnv("url-surfaces-journal-");
	try {
		const rows = feedText("short-secret", "get https://h/?password=hunter2&x=1 now", MESSAGE_STOP).join("");
		ok(!rows.includes("hunter2"), rows);
		ok(rows.includes("password=[redacted:url-param]&x=1 now"), rows);
	} finally {
		env.restore();
	}
});

test("a run feed's bound loses nothing of a run ending in a colon, whatever that colon ends", async () => {
	const env = await isolateClioEnv("url-surfaces-colon-");
	try {
		const tail = " and then more words follow";
		for (const name of ["key", "token"]) {
			const json = `{${Array.from({ length: 4700 }, (_, i) => `"${name}${i}":${i}`).join(",")}}`;
			const whole = redactSecretsText(json + tail, createRedactionTally());
			const at = json.indexOf(`"${name}332":`) + `"${name}332":`.length;
			strictEqual(feedText(`json-${name}`, json.slice(0, at), json.slice(at) + tail, MESSAGE_STOP).join(""), whole);
			// In deltas every bound falls wherever it falls, on a key, a value or a comma.
			const deltas = [...(json.match(/.{1,64}/gu) ?? []), tail];
			strictEqual(feedText(`json-deltas-${name}`, ...deltas, MESSAGE_STOP).join(""), whole);
		}
		const minified = `function f(a){return{a:a,b:${"x".repeat(4100)}:`;
		const code = feedText("minified", minified, "rest();} next word here more", MESSAGE_STOP).join("");
		strictEqual(code, `${minified}rest();} next word here more`);
		// A scheme kept back with what completes it still redacts, and a pathless URL is whole on a completed stream.
		const long = "q".repeat(4100);
		const scheme = feedText("scheme-split", `${long} https:`, "//alice:hunter2@h/x rest of it", MESSAGE_STOP).join("");
		strictEqual(scheme, `${long} https://alice:[redacted:url-userinfo]@h/x rest of it`);
		const assigned = feedText("equals-split", `${long},password=`, "hunter2hunter2,b rest of it", MESSAGE_STOP).join("");
		ok(!assigned.includes("hunter2"), assigned);
		const named = feedText("name-split", `${long}"token":`, '"hunter2hunter2","b":1 rest of it', MESSAGE_STOP).join("");
		ok(!named.includes("hunter2"), named);
		ok(named.endsWith('"b":1 rest of it'), named);
		const pathless = feedText("pathless", `${long},"u":"https://x.io`, '","b":2 rest of it', MESSAGE_STOP).join("");
		strictEqual(pathless, `${long},"u":"https://x.io","b":2 rest of it`);
	} finally {
		env.restore();
	}
});

const OPAQUE = "clone https://abcdef0123456789abcdef0123456789";

test("a reply cut off inside an opaque token shows none of it at any headless or dispatch exit", async () => {
	const env = await isolateClioEnv("url-surfaces-opaque-");
	try {
		const answer = assistantAnswer(OPAQUE, "length");
		const text = await headlessStdout("text", undefined, answer);
		ok(!text.includes("abcdef0123"), text);
		ok(text.includes("clone https://"), text);
		const terminal = await headlessStdout("json", "terminal", answer);
		ok(!terminal.includes("abcdef0123"), terminal);
		const finished = await headlessStdout("text", undefined, assistantAnswer(OPAQUE));
		ok(finished.includes(OPAQUE), finished);

		const update = (inner: object): unknown =>
			projectDispatchJsonEvent({ type: "message_update", assistantMessageEvent: inner } as never);
		const cut = createJsonCredentialScrub();
		const held = cut.scrub(update({ type: "text_end", contentIndex: 0, content: OPAQUE }));
		deepStrictEqual(held, []);
		const ended = cut.scrub(
			projectDispatchJsonEvent({
				type: "message_end",
				message: { role: "assistant", stopReason: "length", content: [{ type: "text", text: OPAQUE }] },
			} as never),
		);
		ok(!JSON.stringify(ended).includes("abcdef0123"), JSON.stringify(ended));
		ok(JSON.stringify(ended).includes("clone https://"), JSON.stringify(ended));

		const stopped = createJsonCredentialScrub();
		stopped.scrub(update({ type: "text_end", contentIndex: 0, content: OPAQUE }));
		const whole = stopped.scrub(
			projectDispatchJsonEvent({
				type: "message_end",
				message: { role: "assistant", stopReason: "stop", content: [] },
			} as never),
		);
		ok(JSON.stringify(whole).includes(OPAQUE), JSON.stringify(whole));

		const partial = createJsonCredentialScrub().scrub({
			type: "result",
			result: { exitCode: 1, output: { state: "partial", text: OPAQUE } },
		});
		ok(!JSON.stringify(partial).includes("abcdef0123"), JSON.stringify(partial));

		const unknown = { kind: "unknown", reason: "not-observed" };
		const human = formatDispatchHumanOutput(OPAQUE, {
			runId: "r",
			agentId: "a",
			exitCode: 1,
			targetId: "t",
			wireModelId: "m",
			startedAt: "2026-01-01T00:00:00Z",
			endedAt: "2026-01-01T00:00:01Z",
			spend: { totalTokens: unknown, usage: { reasoning: unknown } },
			quality: {},
			output: { state: "partial", text: OPAQUE },
		} as never);
		ok(!human.includes("abcdef0123"), human);

		const rows = feedText("opaque-cut", `${OPAQUE} `.trimEnd(), {
			kind: "event",
			type: "message_end",
			stopReason: "length",
		}).join("");
		ok(!rows.includes("abcdef0123"), rows);
		// An open frame still reads it as a host until its `@`, by decision.
		strictEqual(holdUnresolvedUserinfo(OPAQUE), OPAQUE);
	} finally {
		env.restore();
	}
});

test("a feed bound keeps a scheme's last character with the :// that follows it", async () => {
	const env = await isolateClioEnv("url-surfaces-bound-");
	try {
		const stop: RunEventJournalBody = { kind: "event", type: "message_end", stopReason: "stop" };
		for (const scheme of ["https", "postgres"]) {
			const head = `${"x".repeat(4100)}${scheme}`;
			const rows = feedText(`bound-scheme-${scheme}`, head, "://alice:hunter2XY@h/ next words", stop);
			ok(!rows.join("\n").includes("hunter2"), rows.join("\n").slice(-80));
			strictEqual(rows.join(""), `${head}://alice:[redacted:url-userinfo]@h/ next words`);
		}
	} finally {
		env.restore();
	}
});

const PARAM_SECRET = "hunter2XY";

test("the URL rule hides a value by what its whole parameter name means", () => {
	for (const name of [
		"password",
		"db_password",
		"dbPassword",
		"pwd",
		"pass",
		"passwd",
		"secret",
		"client_secret",
		"clientSecret",
		"token",
		"access_token",
		"accessToken",
		"refresh_token",
		"oauth_token",
		"X-Amz-Security-Token",
		"auth",
		"authorization",
		"api_key",
		"apiKey",
		"apikey",
		"credential",
	]) {
		for (const lead of ["?", "?a=1&"]) {
			const text = `https://h.example/p${lead}${name}=${PARAM_SECRET}&next=1 words`;
			strictEqual(redactUrlCredentials(text), `https://h.example/p${lead}${name}=[redacted]&next=1 words`);
			ok(!redactSecretsText(text, createRedactionTally()).includes(PARAM_SECRET), name);
		}
	}
	strictEqual(
		redactUrlCredentials(`jdbc:sqlserver://db:1433;user=sa;password=${PARAM_SECRET};encrypt=true`),
		"jdbc:sqlserver://db:1433;user=sa;password=[redacted];encrypt=true",
	);
	strictEqual(redactUrlCredentials("https://h?token=$TOKEN"), "https://h?token=$TOKEN");
});

test("a name that only starts with a secret word keeps its value, so a completed stream loses nothing", () => {
	for (const text of [
		"see https://github.com/o/r/commits?author=alice for it",
		"https://h/usage?tokens=100&max_tokens=200",
		"https://h/?authenticated=true",
		"fetch('https://h/', ?credentials=include)",
		"https://h/?authority=x&secrets=y&passwords=z&bypass=w&token_type=bearer",
		"https://h/?token&x=1",
		// Semicolons divide parameters only inside a URL, so code keeps its statements.
		"let a=1;token=next();password=b",
		'{"u":"https://h/a","v":"x;token=1"}',
	]) {
		strictEqual(redactUrlCredentials(text), text);
		strictEqual(redactFinalUrlCredentials(text, true), text);
		const filter = new UrlCredentialStreamFilter();
		let joined = "";
		for (let at = 0; at < text.length; at += 3) joined += filter.push(text.slice(at, at + 3));
		strictEqual(joined + filter.end(true), text);
	}
	ok(!endsInOpenCredential("https://h/?author=ali"));
	ok(endsInOpenCredential("https://h/?a=1&pwd=hun"));
	ok(endsInOpenCredential("https://h/?pwd="));
	ok(endsInOpenCredential("jdbc:sqlserver://db;password=hun"));
	strictEqual(redactUrlCredentials("BASE_TOKENS=100 and --token to pass"), "BASE_TOKENS=100 and --token to pass");
});

test("a long run of parameter delimiters stays linear", () => {
	for (const unit of ["&token", "?a", ";b=", "&", "://;"]) {
		const started = performance.now();
		redactUrlCredentials(unit.repeat(Math.ceil(320_000 / unit.length)));
		ok(performance.now() - started < 1_000, unit);
	}
});
