import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createHeadlessJsonProjector, createJsonCredentialScrub, projectDispatchJsonEvent } from "../../src/cli/modes/json-stream.js";
import { runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { formatDispatchHumanOutput } from "../../src/cli/run-output.js";
import { clioStateDir } from "../../src/core/xdg.js";
import type { RunEventJournalBody } from "../../src/domains/dispatch/run-event-journal.js";
import { appendRunFeed, runFeedPath } from "../../src/domains/dispatch/run-feed.js";
import {
	holdUnresolvedUserinfo,
	redactSecretString,
	redactUrlCredentials,
	UrlCredentialStreamFilter,
} from "../../src/domains/safety/redaction.js";
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
		const rows = feedText("query", `https://h/?x=${long}&token=ZQXJZQXJ`, "ZQXJZQXJ&y=1 and the rest follows here ", MESSAGE_STOP);
		ok(!rows.join("\n").match(SECRET_LETTERS), JSON.stringify(rows.map((row) => row.slice(-40))));
		ok(rows.join("").endsWith("&y=1 and the rest follows here "), rows.join("").slice(-60));
		ok(rows.join("").includes(long));
		const value = feedText("long-value", `https://h/?token=ZQ${"X".repeat(5000)}`, "ZQXJZQXJ more words to follow ", MESSAGE_STOP);
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
	const scrub = createJsonCredentialScrub();
	const toolCall = { type: "toolCall", id: "c", name: "bash", arguments: { url: "postgres://db:5432" } };
	strictEqual(
		JSON.stringify(innerOf(scrub.scrub(updateFrame({ type: "toolcall_end", contentIndex: 1, toolCall })))[0]?.toolCall),
		JSON.stringify(toolCall),
	);
	const text = "see http://localhost:8080";
	strictEqual(innerOf(scrub.scrub(updateFrame({ type: "text_end", contentIndex: 0, content: text })))[0]?.content, text);
	strictEqual(
		innerOf(scrub.scrub(updateFrame({ type: "thinking_end", contentIndex: 0, content: text })))[0]?.content,
		text,
	);
	// A finished block still loses a password, and a cut-off assistant message still holds.
	const secret = innerOf(
		scrub.scrub(updateFrame({ type: "text_end", contentIndex: 0, content: "https://u:ZQXJ@h/x" })),
	)[0];
	strictEqual(secret?.content, "https://u:[redacted]@h/x");
	const cut = { role: "assistant", stopReason: "aborted", content: [{ type: "toolCall", arguments: { u: "https://u:ZQXJ" } }] };
	ok(!SECRET_LETTERS.test(JSON.stringify(scrub.scrub({ type: "message_end", message: cut }))));
});

test("a finished text block releases what waited in its filter as complete", () => {
	const scrub = createJsonCredentialScrub();
	const frames = [
		...scrub.scrub(updateFrame({ type: "text_delta", contentIndex: 0, delta: "open http://localhost:8080" })),
		...scrub.scrub(updateFrame({ type: "text_end", contentIndex: 0, content: "open http://localhost:8080" })),
	];
	const deltas = innerOf(frames).filter((inner) => inner.type === "text_delta");
	strictEqual(deltas.map((inner) => inner.delta).join(""), "open http://localhost:8080");
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
	process.stderr.write = (() => true) as typeof process.stderr.write;
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
