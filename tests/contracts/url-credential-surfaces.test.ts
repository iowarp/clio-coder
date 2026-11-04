import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createHeadlessJsonProjector, createJsonCredentialScrub, projectDispatchJsonEvent } from "../../src/cli/modes/json-stream.js";
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
