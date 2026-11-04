import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createJsonCredentialScrub } from "../../src/cli/modes/json-stream.js";
import { formatDispatchHumanOutput } from "../../src/cli/run-output.js";
import { combineLiveBashOutput } from "../../src/core/bash-exec.js";
import { clioStateDir } from "../../src/core/xdg.js";
import type { RunEventJournalBody } from "../../src/domains/dispatch/run-event-journal.js";
import { attachRunEventJournalBridge } from "../../src/domains/dispatch/run-event-journal-bridge.js";
import { appendRunFeed, runFeedPath } from "../../src/domains/dispatch/run-feed.js";
import { createRedactionTally, redactSecretSegments, redactSecretsText } from "../../src/domains/evidence/redact.js";
import {
	cutHeadGuard,
	dropShortCutHead,
	holdUnresolvedStrings,
	RedactedStringProjection,
	redactSecretString,
	redactStreamingSecretString,
	redactUrlCredentials,
	UrlCredentialStreamFilter,
} from "../../src/domains/safety/redaction.js";
import {
	createWorkerProgressFold,
	WORKER_LIVE_TAIL_MAX_BYTES,
	WORKER_PROGRESS_WINDOW_BYTES,
	WORKER_PROGRESS_WINDOW_MS,
} from "../../src/domains/telemetry/worker-progress.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { type ChatPanel, createChatPanel } from "../../src/interactive/chat-panel.js";
import { rehydrateChatPanelFromTurns } from "../../src/interactive/chat-renderer.js";
import {
	SideQuestionOverlayBody,
	type SideQuestionOverlayPhase,
} from "../../src/interactive/overlays/side-question.js";
import { LiveToolView } from "../../src/interactive/renderers/live-tool-view.js";
import { renderBashTranscriptExecution } from "../../src/interactive/renderers/tool-execution.js";
import {
	liveWorkerAnswerText,
	safeWorkerAnswerText,
	WorkerAnswerProjection,
} from "../../src/interactive/renderers/worker-answer.js";
import { renderWorkerEntryLines } from "../../src/interactive/renderers/worker-entry.js";
import { createWorkerStream } from "../../src/session-control/worker-stream.js";
import {
	BASH_DEFAULT_RESULT_DISPOSITION,
	BASH_DISPLAY_MAX_BYTES,
	bashOutputCapResult,
	bashTool,
	shapeBashProgress,
} from "../../src/tools/bash.js";
import { deterministicDiagnosticSummary } from "../../src/tools/result-disposition.js";
import { shapeToolResult } from "../../src/tools/result-shaping.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const SEED = 0x5eed;
const DOCUMENTS = 60;
const CHUNKINGS = 6;
// One sweep offset in this many runs by default, rotating per case so the cases together still reach every offset. Set it
// to 1 for the deep sweep, which also restores the wide display-tail range.
const OFFSET_STRIDE: number = 5;
const sweptOffset = (offset: number, sweep: number): boolean => (Math.abs(offset) + sweep + SEED) % OFFSET_STRIDE === 0;

// Secrets draw on letters nothing else in the corpus uses, so one leaked character is enough to fail a frame.
const SECRET_LETTERS = /[ZQXJΩЖ😀]/gu;

const BOUNDARIES = [" ", "\n", "\t", "\r\n", "/", "@", "\u00a0", "\u3000", "\u2003"];

const CORPUS = [
	"https://user:ZQXJ@github.com/x",
	"http://u:ZQ:XJ@h",
	"https://u:ZQXJ:@h",
	"HTTPS://u:ZQXJ@h",
	"git+https://u:ZQXJ@h/r.git",
	'https://u:Z)Q,X"J@h',
	"https://u:ΩЖZ@h/p",
	"https://u:😀ZQ@h",
	"https://u:ZQ@XJ@h",
	"https://a:b,https://c:ZQXJ@h",
	"https://u:ZQXJ@h:8443/p",
	"https://u:ZQXJ",
	"--token\nZQXJ next",
	"deploy --token ZQXJsecret tail",
	"https://u:$TOKEN@h",
	"https://ghp_x@github.com/r",
	"https://ghp_x:ZQXJ@github.com/r",
	"https://ghp_ZQXJZQXJZQXJZQXJZQXJZQXJ@github.com/r",
	"https://glpat-ZQXJZQXJZQXJ:x-oauth@gitlab.com/r",
	"https://:ZQXJ@h",
	"https://u:ZQ/XJ@h",
	"ssh://u:ZQ/XJ@h/p",
	"postgres://u:ZQXJ@h/db",
	"redis://:ZQXJ@h:6379",
	"mongodb+srv://u:ZQXJ@c.example.net/db",
	"http://$HOST:$PORT/api tail",
	"redis://localhost:6379/0",
	"--token ZQXJ next",
	"--token=ZQXJ",
	"API_KEY=ZQXJ;x",
	"KEY=https://u:ZQXJ@h",
	"https://h/p?token=ZQXJ&y=1",
	"https://h:1?token=ZQXJ#f",
	"curl -u x https://a:ZQXJ@h/p -H y",
	"[link](https://u:ZQXJ@h/p)",
	"`https://u:ZQXJ@h`",
	"<https://u:ZQXJ@h>",
	'"https://u:ZQXJ@h"',
	"https://example.com/a/b?x=1#f",
	"http://localhost:8080/health",
	"http://localhost:8080",
	"http://[::1]:8080/",
	"https://h:443 next",
	"see https:// and http:// in prose",
	"scheme https: only",
	"a:b c:d",
	"time 10:30:45",
	"[l](http://h:80/x) after",
	"(http://h:80), then",
	"日本語 https://例え.jp:8080/パス 次",
	"https://例え.jp:8080。次の文",
	"# heading\n\n- **bold** text ok\n",
	'{"url":"https://example.com","email":"a@b.com"}',
	'{"a":"http://h:8080","b":"me@corp.com"}',
	'{"a":"https://u:ZQXJ@h/x","b":"me@corp.com"}',
	'{"a":"https://h/?token=ZQXJ","b":"me@corp.com"}',
	'{\\"a\\":\\"http://h:8080\\",\\"b\\":\\"me@corp.com\\"}',
	"https://me@corp.com:ZQXJ@host/",
	"https://me@corp.com:ZQ:XJ@host",
	"ssh://git@host:2222/path@tag",
	...BOUNDARIES.map((boundary) => `http://h:8080${boundary}tail`),
];

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = state;
		mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * The stated contract, written apart from the code. In the last token, the first URL that can still hold a password shows
 * through its first colon, or its last `@`. A numeric port ahead of `/`, an `@` that closed an authority, or a `"` closing a
 * string settles a URL.
 */
function expectedFrame(prefix: string): string {
	const token = /\S*$/u.exec(prefix)?.[0] ?? "";
	const base = prefix.length - token.length;
	for (const match of token.matchAll(/(?<=[a-z0-9+.-]):\/\//giu)) {
		const start = match.index + 3;
		const rest = token.slice(start);
		const cut = (end: number) => redactSecretString(prefix.slice(0, base + start + end));
		const lastAt = rest.lastIndexOf("@");
		if (/"[,:;}\])>\\]/u.test(rest)) continue;
		if (/^(?:gh[pousr]_|github_pat_|glpat-)[^/]*$/iu.test(rest)) return cut(lastAt + 1);
		if (/^[^/:[]*:[^/]*@[^/]*$/u.test(rest)) return cut(lastAt + 1);
		if (/^[^/:[]*:[^/@]*$/u.test(rest)) return cut(rest.indexOf(":") + 1);
		if (/^[^/@:[]*:(?!\d*\/)[^/@]*\//u.test(rest)) return cut(lastAt >= 0 ? lastAt + 1 : rest.indexOf(":") + 1);
	}
	return redactSecretString(prefix);
}

function leaked(frame: string, oneShot: string): string[] {
	const shown = new Set(oneShot.match(SECRET_LETTERS) ?? []);
	return (frame.match(SECRET_LETTERS) ?? []).filter((letter) => !shown.has(letter));
}

function cuts(next: () => number, length: number): number[] {
	const points = new Set<number>([length]);
	const count = Math.floor(next() * 12);
	for (let index = 0; index < count; index += 1) points.add(1 + Math.floor(next() * length));
	return [...points].sort((a, b) => a - b);
}

function document(next: () => number): string {
	const parts: string[] = [];
	const count = 1 + Math.floor(next() * 5);
	for (let index = 0; index < count; index += 1) {
		parts.push(CORPUS[Math.floor(next() * CORPUS.length)] ?? "");
		parts.push(["", " ", "\n", " and "][Math.floor(next() * 4)] ?? "");
	}
	return parts.join("");
}

function checkStream(text: string, points: readonly number[], context: string): void {
	const oneShot = redactSecretString(text);
	const projection = new RedactedStringProjection();
	const worker = new WorkerAnswerProjection();
	const workerOneShot = safeWorkerAnswerText(text);
	for (const point of points) {
		const prefix = text.slice(0, point);
		const frame = projection.project(prefix);
		const where = `${context} at ${point} of ${JSON.stringify(text)}`;
		strictEqual(frame, expectedFrame(prefix), where);
		strictEqual(redactStreamingSecretString(prefix), frame, where);
		strictEqual(leaked(frame, oneShot).join(""), "", where);
		strictEqual(leaked(worker.project(prefix, false), workerOneShot).join(""), "", `worker ${where}`);
	}
	strictEqual(projection.project(text, true), oneShot, `${context} final of ${JSON.stringify(text)}`);
	strictEqual(worker.project(text, true), workerOneShot, `worker ${context} final of ${JSON.stringify(text)}`);
}

test("every chunking of the corpus streams to the one-shot output without showing a secret early", () => {
	const next = random(SEED);
	const inputs = [...CORPUS, ...Array.from({ length: DOCUMENTS }, () => document(next))];
	for (const text of inputs) {
		const everyUnit = Array.from({ length: text.length }, (_, index) => index + 1);
		checkStream(text, everyUnit, `seed ${SEED} one-unit`);
		for (let chunking = 0; chunking < CHUNKINGS; chunking += 1) {
			checkStream(text, cuts(next, text.length), `seed ${SEED} chunking ${chunking}`);
		}
	}
});

test("one-shot redaction hides the whole password of every userinfo shape", () => {
	for (const [text, redacted] of [
		["https://:ZQXJ@h", "https://:[redacted]@h"],
		["https://u:ZQ:XJ@h", "https://u:[redacted]@h"],
		["https://u:ZQ@XJ@h", "https://u:[redacted]@h"],
		["https://u:ZQ@XJ@h:8443/p", "https://u:[redacted]@h:8443/p"],
		["https://u:ZQ@h/a@b", "https://u:[redacted]@h/a@b"],
		["https://a:ZQ@h,https://b:XJ@h", "https://a:[redacted]@h,https://b:[redacted]@h"],
		["https://u:ZQ/XJ@h", "https://u:[redacted]@h"],
		["postgres://u:ZQ@h/db", "postgres://u:[redacted]@h/db"],
		["redis://:ZQ@h:6379", "redis://:[redacted]@h:6379"],
		["mongodb+srv://u:ZQ@c.example.net", "mongodb+srv://u:[redacted]@c.example.net"],
		["ssh://u:ZQ@h", "ssh://u:[redacted]@h"],
		["jdbc:mysql://u:ZQ@h:3306/db", "jdbc:mysql://u:[redacted]@h:3306/db"],
		["https://ZQXJ0ZQXJZQXJZQXJZQXJZ@github.com/r", "https://[redacted]@github.com/r"],
		["https://glpat-ZQXJZQXJZQXJ:ZQ@gitlab.com/r", "https://[redacted]:[redacted]@gitlab.com/r"],
		["https://me@corp.com:ZQXJ@host/", "https://me@corp.com:[redacted]@host/"],
		['https://u:Z)Q,X"J@h', "https://u:[redacted]@h"],
		['https://u:ZQ"@h', "https://u:[redacted]@h"],
	] as const) {
		strictEqual(redactSecretString(text), redacted);
		strictEqual(redactSecretString(redacted), redacted);
		const tally = createRedactionTally();
		const evidence = redactSecretsText(text, tally);
		strictEqual(leaked(evidence, "").join(""), "", text);
		strictEqual(redactSecretsText(evidence, tally), evidence);
	}
});

test("a headless answer hides URL credentials and keeps prose the wider rule would blank", () => {
	const unknown = { kind: "unknown", reason: "not-observed" };
	const receipt = {
		runId: "r",
		agentId: "a",
		exitCode: 0,
		targetId: "t",
		wireModelId: "m",
		startedAt: "2026-01-01T00:00:00Z",
		endedAt: "2026-01-01T00:00:01Z",
		spend: { totalTokens: unknown, usage: { reasoning: unknown } },
	} as never;
	const human = formatDispatchHumanOutput(
		"clone https://u:ZQXJ@h/r and postgres://u:ZQXJ@h/db\nBASE_TOKENS=100, pass --token to it",
		receipt,
	);
	ok(
		human.startsWith(
			"clone https://u:[redacted]@h/r and postgres://u:[redacted]@h/db\nBASE_TOKENS=100, pass --token to it\n",
		),
		human,
	);
});

test("a side question hides URL credentials while it streams and when it ends", () => {
	const shown = (phase: SideQuestionOverlayPhase): string => {
		const body = new SideQuestionOverlayBody("q", () => 0);
		body.set(phase);
		return stripTerminalSequences(body.render(120).join("\n"));
	};
	strictEqual(leaked(shown({ kind: "streaming", text: "clone https://u:ZQXJ" }), "").join(""), "");
	strictEqual(leaked(shown({ kind: "aborted", text: "clone https://u:ZQXJ" }), "").join(""), "");
	const answered = shown({ kind: "answered", text: "clone postgres://u:ZQXJ@h/db and BASE_TOKENS=100" });
	strictEqual(leaked(answered, "").join(""), "");
	ok(answered.includes("postgres://u:[redacted]@h/db") && answered.includes("BASE_TOKENS=100"), answered);
	ok(shown({ kind: "answered", text: "open http://h:8080" }).includes("http://h:8080"));
});

test("what an append-only stream sends joins to the one-shot output and never shows a secret early", () => {
	const next = random(SEED);
	const inputs = [
		...CORPUS,
		"日本語の文章は空白がないまま続く",
		...Array.from({ length: DOCUMENTS }, () => document(next)),
	];
	for (const text of inputs) {
		const oneShot = redactUrlCredentials(text);
		for (let chunking = 0; chunking <= CHUNKINGS; chunking += 1) {
			const points =
				chunking === 0 ? Array.from({ length: text.length }, (_, index) => index + 1) : cuts(next, text.length);
			const filter = new UrlCredentialStreamFilter();
			const cutOff = new UrlCredentialStreamFilter();
			let sent = "";
			let at = 0;
			for (const point of points) {
				const piece = filter.push(text.slice(at, point));
				cutOff.push(text.slice(at, point));
				sent += piece;
				at = point;
				strictEqual(leaked(sent, oneShot).join(""), "", `at ${point} of ${JSON.stringify(text)}`);
			}
			strictEqual(sent + filter.end(true), oneShot, JSON.stringify(text));
			strictEqual(leaked(sent + cutOff.end(false), oneShot).join(""), "", JSON.stringify(text));
		}
	}
	const prose = new UrlCredentialStreamFilter();
	strictEqual(prose.push("日本語の文章"), "日本語の文章");
	strictEqual(prose.push("https"), "https");
	strictEqual(prose.push("://u:ZQ"), "");
	strictEqual(prose.push("XJ@h "), "://u:[redacted]@h ");
});

test("a JSON stream sends no URL credential in a delta, a message or a result", () => {
	const scrub = createJsonCredentialScrub();
	const frames = [
		{ type: "text_delta", contentIndex: 0, delta: "clone https://u:ZQ" },
		{ type: "text_delta", contentIndex: 0, delta: "XJ@h/r and http://h" },
		{
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "ok ", partial: { text: "https://u:ZQ" } },
		},
		{ type: "message_end", message: { stopReason: "stop", content: [{ type: "text", text: "https://u:ZQXJ@h" }] } },
		{ type: "text_delta", contentIndex: 0, delta: "cut https://u:ZQ" },
		{ type: "message_end", message: { stopReason: "aborted", content: [{ type: "text", text: "cut https://u:ZQ" }] } },
		{ type: "result", result: { output: { text: "postgres://u:ZQXJ@h/db" } } },
	].flatMap((frame) => scrub.scrub<unknown>(frame));
	const wire = JSON.stringify(frames);
	strictEqual(leaked(wire, "").join(""), "", wire);
	const deltas = frames.flatMap((frame) => {
		const row = frame as { type?: string; delta?: string };
		return row.type === "text_delta" ? [row.delta ?? ""] : [];
	});
	strictEqual(deltas.join(""), "clone https://u:[redacted]@h/r and http://hcut https://u:");
	ok(wire.includes("postgres://u:[redacted]@h/db"), wire);
});

function proseFrame(panel: ChatPanel): string {
	return JSON.stringify(panel.renderRegions(200)).replace(/\\u001b\[[0-9;:]*m/gu, "");
}

test("main prose hides URL credentials while it streams and keeps other text whole", () => {
	const panel = createChatPanel({ now: () => 1_000 });
	panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
	const text = "clone https://u:ZQXJ@h/r and postgres://u:ZQ/XJ@h/db\nBASE_TOKENS=100 and --token to pass it";
	for (let at = 0; at < text.length; at += 3) {
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: text.slice(at, at + 3), partialText: "" });
		strictEqual(leaked(proseFrame(panel), "").join(""), "", `after ${at}`);
	}
	const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] };
	panel.applyEvent({ type: "message_end", message } as never);
	const done = proseFrame(panel);
	strictEqual(leaked(done, "").join(""), "");
	ok(
		done.includes("https://u:[redacted]@h/r") && done.includes("BASE_TOKENS=100") && done.includes("--token to pass"),
		done,
	);
});

test("main prose cut off inside a URL keeps what it held", () => {
	for (const stopReason of ["length", "error", "aborted"]) {
		const panel = createChatPanel({ now: () => 1_000 });
		panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "clone https://u:ZQXJ", partialText: "" });
		const message = { role: "assistant", stopReason, content: [{ type: "text", text: "clone https://u:ZQXJ" }] };
		panel.applyEvent({ type: "message_end", message } as never);
		strictEqual(leaked(proseFrame(panel), "").join(""), "", stopReason);
	}
});

test("an ordinary name or host stays readable beside a username token", () => {
	for (const text of [
		"https://alice@github.com/r",
		"https://first.last@corp.example.com/r",
		"ssh://git@github.com/o/r.git",
		"http://my-service-12345-abcdefghij:8080/health",
		"http://localhost:4873/@scope/pkg",
		"http://[::1]:8080/a@b",
		"https://abcdefghijklmnopqrstuvwxyz.example.com/",
		"redis://localhost:6379/0",
		"sqlite:///a:b/c@d",
		"file:///C:/x@y",
		"ssh://git@github.com:22/o/r.git",
	]) {
		strictEqual(redactSecretString(text), text);
		strictEqual(redactStreamingSecretString(text), text);
	}
});

test("the hold and the pattern stay linear on a token full of URLs", () => {
	for (const text of ["x://".repeat(80_000), "a://b:c/".repeat(40_000), `https://${"a:".repeat(160_000)}`]) {
		const started = performance.now();
		redactStreamingSecretString(text);
		ok(performance.now() - started < 1_000, text.slice(0, 16));
	}
});

test("a run that never ends gains a marker past the limit and never shows what it holds", () => {
	const run = `https://u:${"Z".repeat(5000)}`;
	strictEqual(redactStreamingSecretString(run), "https://u:[held]");
	strictEqual(redactStreamingSecretString(`${run}@h`), "https://u:[redacted]@");
	strictEqual(redactStreamingSecretString(`${run}@h/`), "https://u:[redacted]@h/");
	strictEqual(redactStreamingSecretString(run, true), run);
});

test("forming tool arguments hold every string they carry", () => {
	deepStrictEqual(holdUnresolvedStrings({ command: "curl https://u:ZQ", count: 1, urls: ["https://h:1", "plain"] }), {
		command: "curl https://u:",
		count: 1,
		urls: ["https://h:", "plain"],
	});
});

const delta = (text: string) => ({
	type: "message_update",
	assistantMessageEvent: { type: "text_delta", delta: text },
});

function liveCard(fold: ReturnType<typeof createWorkerProgressFold>): string {
	return liveWorkerAnswerText(fold.snapshot().tailText, false);
}

test("no frame of a rolling worker tail shows a secret, wherever a byte cut or a refused chunk lands", () => {
	const next = random(SEED);
	const fillers = [
		(size: number) => "x".repeat(size),
		(size: number) => "xy ".repeat(Math.ceil(size / 3)).slice(0, size),
		(size: number) => "line\n".repeat(Math.ceil(size / 5)).slice(0, size),
	];
	let sweep = 0;
	for (const text of CORPUS) {
		const oneShot = redactSecretString(text);
		for (const fill of fillers) {
			sweep += 1;
			for (let offset = 0; offset <= text.length + 2; offset += 1) {
				if (!sweptOffset(offset, sweep)) continue;
				const stream = `${fill(WORKER_LIVE_TAIL_MAX_BYTES - offset)}${text} tail words here\nand a line after`;
				const fold = createWorkerProgressFold();
				let now = 1000;
				let at = 0;
				const where = `seed ${SEED} offset ${offset} of ${JSON.stringify(text)}`;
				for (const point of cuts(next, stream.length)) {
					// One chunk in six falls in a spent rate window and is refused.
					if (next() < 1 / 6) fold.observe(delta("w".repeat(WORKER_PROGRESS_WINDOW_BYTES + 1)), now);
					fold.observe(delta(stream.slice(at, point)), now);
					strictEqual(leaked(liveCard(fold), oneShot).join(""), "", where);
					at = point;
					now += next() < 0.5 ? 1 : WORKER_PROGRESS_WINDOW_MS;
				}
			}
		}
	}
});

test("the tail guard outlives the delta that emptied the tail", () => {
	const fold = createWorkerProgressFold();
	fold.observe(delta(`${"x".repeat(5000)}https://u:ZQ`), 0);
	strictEqual(fold.snapshot().tailText, "");
	fold.observe(delta("XJ@host/repo.git next words and more"), 1);
	strictEqual(fold.snapshot().tailText, "words and more");
	const spent = createWorkerProgressFold();
	spent.observe(delta("w ".repeat(WORKER_PROGRESS_WINDOW_BYTES / 2)), 0);
	spent.observe(delta("see https://user:"), 1);
	spent.observe(delta("ZQXJ@host/x done now"), WORKER_PROGRESS_WINDOW_MS + 1);
	strictEqual(liveCard(spent).match(SECRET_LETTERS), null);
	const hole = createWorkerProgressFold();
	hole.observe(delta("see https://user:ZQ"), 0);
	hole.observe(delta("w".repeat(WORKER_PROGRESS_WINDOW_BYTES + 1)), 1);
	hole.observe(delta("XJ/path more words here now"), WORKER_PROGRESS_WINDOW_MS + 1);
	strictEqual(liveCard(hole), "see words here now");
});

test("no frame of the bash live tail shows a secret, and a finished line past the cap releases", () => {
	const shown = (raw: string) =>
		new LiveToolView()
			.outputRows((shapeBashProgress(raw, raw.length, "bounded") as { output: string }).output, 5, 400, {
				rail: "",
				railWidth: 0,
			})
			.join("\n");
	const cap = 16 * 1024;
	let sweep = 0;
	for (const text of CORPUS) {
		const oneShot = redactSecretString(text);
		sweep += 1;
		for (let offset = 0; offset <= text.length + 2; offset += 1) {
			if (!sweptOffset(offset, sweep)) continue;
			const where = `offset ${offset} of ${JSON.stringify(text)}`;
			strictEqual(leaked(shown(`${text} ${"z".repeat(cap - text.length - 1 + offset)}`), oneShot).join(""), "", where);
			const words = `${text} ${"zz ".repeat(Math.ceil((cap + offset) / 3))}`;
			strictEqual(leaked(shown(words.slice(0, cap + offset)), oneShot).join(""), "", `words ${where}`);
		}
	}
	strictEqual(leaked(shown(`--token\nZQXJ\n${"line\n".repeat(cap / 5)}`), "").join(""), "");
	const summary = shapeBashProgress("Local: http://localhost:5173\n", 29, "summary") as { output: string };
	strictEqual(
		new LiveToolView().outputRows(summary.output, 5, 400, { rail: "", railWidth: 0 }).join(""),
		"Local: http://localhost:5173",
	);
	const hyphens = shown("well-known ".repeat(4000));
	strictEqual(hyphens.startsWith("well-known"), true);
	const dashes = createWorkerProgressFold();
	dashes.observe(delta("well-known ".repeat(1000)), 0);
	strictEqual(dashes.snapshot().tailText.startsWith("well-known"), true);
	const dev = shown(`${"line\n".repeat(cap / 4)}Local: http://localhost:5173\n`);
	strictEqual(dev.split("\n").at(-1), "Local: http://localhost:5173");
	strictEqual(
		shown(`${"line\n".repeat(cap / 4)}Local: http://localhost:5173`)
			.split("\n")
			.at(-1),
		"Local: http://localhost:",
	);
});

test("the hard-cap preview cannot cut a scheme off a password", () => {
	const budget = BASH_DISPLAY_MAX_BYTES - 2048;
	const secret = "clone https://user:ZQXJ@host/r.git ";
	for (let cut = 1; cut < secret.length; cut += 1) {
		const stdout = `${secret}${"z ".repeat(budget)}`.slice(0, budget + cut);
		const capped = bashOutputCapResult({ stdout, stderr: "", outputBytes: stdout.length } as never, "bounded") as {
			message: string;
		};
		const preview = capped.message.slice(0, capped.message.lastIndexOf("\n\n"));
		strictEqual(redactSecretString(preview).match(SECRET_LETTERS), null, `cut ${cut}`);
	}
});

test("/view holds open thinking the way the rail does", async () => {
	const panel = createChatPanel({ now: () => 1_000 });
	panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
	panel.applyEvent({ type: "thinking_delta", contentIndex: 0, delta: "clone https://user:ZQXJ", partialThinking: "x" });
	const open = panel.inspectionArtifacts().find((artifact) => artifact.title.startsWith("Thinking"));
	strictEqual(open?.title, "Thinking · clone https://user:");
	strictEqual((await open?.load())?.lines.join("\n"), "clone https://user:");
});

test("a settled result's cuts leave no piece of a secret, in the model context or the display tail", () => {
	const cases = [
		"https://user:ZQXJZQXJ@host/repo.git",
		`https://user:ZQXJZQXJ@host/${"y".repeat(400)}`,
		"AKIAZQXJZQXJZQXJZQXJ",
		"password: ZQXJZQXJ",
		"password = ZQXJZQXJ",
		"Authorization: Bearer ZQXJ1ZQXJ",
		"--token ZQXJZQXJ",
		'"Authorization": "Bearer ZQXJ1ZQXJ"',
		"'Authorization': 'Basic ZQXJ1ZQXJ'",
	];
	const marker = "\n[… omitted …]\n";
	const shape = (output: string) =>
		shapeToolResult(bashTool, { kind: "ok", output }, undefined, BASH_DEFAULT_RESULT_DISPOSITION) as {
			output: string;
			modelContext: string;
		};
	// The header's retrieve path is a random temp directory, so only the excerpt is read.
	const excerpt = (output: string) => {
		const context = shape(output).modelContext;
		return context.slice(context.indexOf("\n", context.indexOf("followUp=")) + 1);
	};
	const shown = (text: string) => redactSecretString(redactSecretsText(text, createRedactionTally()));
	const filler = (size: number, unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
	const edges = excerpt(`${filler(40_000, "q ")}\n${filler(40_000, "w ")}\n`);
	const headBytes = edges.indexOf(marker);
	const tailBytes = edges.length - headBytes - marker.length;
	let sweep = 0;
	for (const secret of cases) {
		sweep += 1;
		for (let offset = -secret.length - 8; offset < 8; offset += 1) {
			if (!sweptOffset(offset, sweep)) continue;
			const where = `offset ${offset} of ${secret}`;
			const atHead = `${filler(headBytes + offset, "q ")} ${secret} ${filler(40_000, "w ")}`;
			strictEqual(shown(excerpt(atHead)).match(SECRET_LETTERS), null, `head ${where}`);
			const atTail = `${filler(40_000, "q ")}${secret} ${filler(tailBytes + offset, "w ")}`;
			strictEqual(shown(excerpt(atTail)).match(SECRET_LETTERS), null, `tail ${where}`);
		}
	}
	const display = (tail: number) =>
		shape(`${filler(120_000, "q ")}https://user:ZQXJZQXJ@host/repo.git ${filler(tail, "w ")}`).output;
	const [firstTail, lastTail, tailStep] = OFFSET_STRIDE === 1 ? [64_500, 65_600, 11] : [64_950, 65_010, 5];
	for (let tail = firstTail; tail < lastTail; tail += tailStep) {
		const output = display(tail);
		strictEqual(shown(output.slice(0, output.lastIndexOf("\n\n"))).match(SECRET_LETTERS), null, `display tail ${tail}`);
	}
	// Routine long tokens keep the plain cut's bytes for the model and the display, and the live row stays as it was.
	for (const [first, last] of [
		[filler(40_000, "q"), filler(40_000, "w")],
		[filler(40_000, '{"a":1,'), filler(40_000, '"b":2,')],
	] as const) {
		const output = `${first}\n${last}\n`;
		const body = excerpt(output);
		strictEqual(body.slice(0, 32), first.slice(0, 32));
		strictEqual(body.indexOf(marker) > 7000, true);
		strictEqual(body.trimEnd().slice(-32), last.slice(-32));
		strictEqual(body.length - body.indexOf(marker) - marker.length > 7900, true);
		strictEqual(shape(`${first}${last}`).output.includes(last.slice(-64)), true);
	}
	// A word before the long token must not pull the head back to it.
	const afterWord = excerpt(`a ${filler(40_000, "q")}\n${filler(40_000, "w")}\n`);
	strictEqual(afterWord.indexOf(marker) > 7000, true);
	const live = shapeBashProgress(filler(40_000, "q"), 40_000, "bounded") as { output: string };
	strictEqual(live.output, "");
});

test("the trim's bound keeps a key with its value and never leaves nothing", () => {
	for (const lead of ["password:", "--token"]) {
		for (let remainder = 470; remainder < 522; remainder += 1) {
			const kept = dropShortCutHead(`${"x".repeat(remainder)} ${lead} ZQXJZQXJ tail words a b c`, cutHeadGuard());
			strictEqual(kept.startsWith("ZQXJ"), false, `${lead} remainder ${remainder}`);
		}
	}
	strictEqual(dropShortCutHead("a b ", cutHeadGuard()), "a b ");
	const tiny = shapeToolResult(bashTool, { kind: "ok", output: "x".repeat(2_000) }, undefined, {
		...BASH_DEFAULT_RESULT_DISPOSITION,
		context: { mode: "bounded", maxBytes: 900 },
	}) as { modelContext: string };
	const marker = tiny.modelContext.indexOf("\n[… omitted …]\n");
	strictEqual(tiny.modelContext.slice(marker - 8, marker), "xxxxxxxx");
	strictEqual(tiny.modelContext.slice(-8), "xxxxxxxx");
});

test("run feed row fields are redacted before their bound cuts them", () => {
	const handlers = new Map<string, (payload: unknown) => void>();
	const bus = {
		subscribe(name: string, handler: (payload: unknown) => void) {
			handlers.set(name, handler);
			return () => {};
		},
		emit() {},
	};
	const details: unknown[] = [];
	const journal = {
		open() {},
		append(_runId: string, entry: unknown) {
			details.push(entry);
		},
		result() {},
		terminal() {},
	};
	const bridge = attachRunEventJournalBridge(bus as never, { journal: journal as never, nowMs: () => 0 });
	const secret = "https://user:ZQXJZQXJZQXJ@host/x";
	for (let offset = 0; offset < 40; offset += 1) {
		const text = `${"x".repeat(580 - offset)} ${secret} more`;
		const usage = { input: 1, output: 1, totalTokens: 2 };
		handlers.get("run.progressed")?.({
			runId: `end${offset}`,
			agentId: "a",
			event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage } },
		});
		handlers.get("run.progressed")?.({
			runId: `reason${offset}`,
			agentId: "a",
			event: {
				type: "clio_coder_tool_finish",
				payload: { tool: "bash", toolCallId: "c", outcome: "error", reason: `${"y".repeat(220 - offset)} ${secret} more` },
			},
		});
	}
	bridge.stop();
	strictEqual(details.length, 80);
	const rows = details as { detail?: string; reason?: string }[];
	strictEqual(
		rows
			.map((row) => `${row.detail ?? ""}${row.reason ?? ""}`)
			.join("")
			.match(SECRET_LETTERS),
		null,
	);
});

const CUT_OFF = ["aborted", "error", "length", undefined] as const;
const KILLED_STATUS =
	"bash: command aborted after 1s of its 300000ms timeout. The host ended the run and recorded no cause.";
const plainRows = (panel: ChatPanel) => panel.render(400).map(stripTerminalSequences).join("\n");
const viewOf = async (panel: ChatPanel) => {
	const shown: string[] = [];
	for (const artifact of panel.inspectionArtifacts()) shown.push(artifact.title, ...(await artifact.load()).lines);
	return shown.join("\n");
};
const message = (content: unknown[], stopReason?: string) => ({
	type: "message_end",
	message: { role: "assistant", content, ...(stopReason === undefined ? {} : { stopReason }) },
});

function thinkingPanel(text: string, stopReason: string | undefined, streamed: boolean): ChatPanel {
	const panel = createChatPanel({ now: () => 1_000, getOutputStyle: () => "detailed" });
	panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
	if (streamed) panel.applyEvent({ type: "thinking_delta", contentIndex: 0, delta: text, partialThinking: text });
	panel.applyEvent(message([{ type: "thinking", thinking: text }], stopReason) as never);
	return panel;
}

function killedBashPanel(output: string, details: Record<string, unknown> | undefined): ChatPanel {
	const panel = createChatPanel({ now: () => 1_000, getOutputStyle: () => "detailed" });
	const text = details?.outcome === "success" ? output : `${output}\n\n${KILLED_STATUS}`;
	panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
	panel.applyEvent({
		type: "tool_execution_start",
		toolCallId: "c",
		toolName: "bash",
		args: { command: "run" },
	} as never);
	panel.applyEvent({
		type: "tool_execution_end",
		toolCallId: "c",
		toolName: "bash",
		isError: details?.outcome !== "success",
		result: { content: [{ type: "text", text }], ...(details === undefined ? {} : { details }) },
	} as never);
	return panel;
}

test("a stream cut off at any offset shows no secret part in any frame, and a completed one equals one-shot", async () => {
	for (const text of CORPUS) {
		const oneShot = redactSecretString(text);
		const hidden = (frame: string, where: string) =>
			strictEqual(leaked(frame, oneShot).join(""), "", `${where} of ${JSON.stringify(text)}`);
		for (let at = 1; at <= text.length; at += 1) {
			const prefix = text.slice(0, at);
			const where = `offset ${at}`;
			for (const stopReason of CUT_OFF) {
				const fold = createWorkerProgressFold();
				fold.observe(delta(prefix), 0);
				const open = liveWorkerAnswerText(fold.snapshot().tailText, false);
				fold.observe(message([{ type: "text", text: prefix }], stopReason), 1);
				fold.observe({ type: "agent_end" }, 2);
				const snapshot = fold.snapshot();
				strictEqual(liveWorkerAnswerText(snapshot.tailText, snapshot.completed === true), open, `${stopReason} ${where}`);
				hidden(open, `${stopReason} ${where}`);
			}
			if (!sweptOffset(at, text.length)) continue;
			hidden(plainRows(thinkingPanel(prefix, "aborted", true)), `thinking ${where}`);
			hidden(await viewOf(thinkingPanel(prefix, "aborted", true)), `thinking view ${where}`);
			const killed = killedBashPanel(prefix, { outcome: "abort", aborted: true, outputEndsOpen: true });
			hidden(plainRows(killed), `killed ${where}`);
			// /view redacts a tool's rows one at a time, so a flag and its value on two lines is a gap with or without an abort.
			if (!text.includes("\n")) hidden(await viewOf(killed), `killed view ${where}`);
		}
		const fold = createWorkerProgressFold();
		fold.observe(delta(text), 0);
		fold.observe(message([{ type: "text", text }], "stop"), 1);
		fold.observe({ type: "agent_end" }, 2);
		strictEqual(fold.snapshot().completed, true);
		strictEqual(liveWorkerAnswerText(fold.snapshot().tailText, true), safeWorkerAnswerText(text), `completed ${text}`);
	}
});

test("what ended a stream decides whether its last URL shows", async () => {
	const url = "http://localhost:8080";
	const done = "see http://localhost:8080";
	for (const stopReason of ["stop", "toolUse"])
		strictEqual(plainRows(thinkingPanel(done, stopReason, true)).includes(url), true);
	for (const stopReason of CUT_OFF) strictEqual(plainRows(thinkingPanel(done, stopReason, true)).includes(url), false);
	const success = killedBashPanel(done, { outcome: "success", outputEndsOpen: true });
	strictEqual(plainRows(success).includes(url), true);
	strictEqual((await viewOf(success)).includes(url), true);
	const failed = killedBashPanel(done, {
		outcome: "nonzero",
		exitCode: 1,
		signal: null,
		aborted: false,
		timedOut: false,
		outputEndsOpen: true,
	});
	strictEqual(plainRows(failed).includes(url), true);
	for (const details of [
		{ outcome: "abort", outputEndsOpen: true },
		{ outcome: "timeout", outputEndsOpen: true },
		{ outcome: "output-cap", outputEndsOpen: true },
		{ outcome: "nonzero", aborted: false, timedOut: false, signal: "SIGKILL", outputEndsOpen: true },
	]) {
		const panel = killedBashPanel(done, details);
		strictEqual(plainRows(panel).includes(url), false, details.outcome);
		strictEqual((await viewOf(panel)).includes(url), false, details.outcome);
	}
	// A finished line is finished, however the process ended.
	strictEqual(plainRows(killedBashPanel(done, { outcome: "abort", outputEndsOpen: false })).includes(url), true);
	const local = (execution: object) =>
		renderBashTranscriptExecution({ command: "run", output: done, ...execution } as never, 400).join("\n");
	strictEqual(local({ exitCode: 0 }).includes(url), true);
	strictEqual(local({ cancelled: true }).includes(url), false);
	strictEqual(local({ exitCode: null }).includes(url), false);
	const fold = createWorkerProgressFold();
	fold.observe(delta(done), 0);
	fold.observe(message([{ type: "text", text: done }], "stop"), 1);
	fold.observe({ type: "agent_end" }, 2);
	strictEqual(fold.snapshot().completed, true);
	fold.settle(undefined, false);
	strictEqual(fold.snapshot().completed, false);
	const resumed = createWorkerProgressFold();
	resumed.observe(message([{ type: "text", text: "first" }], "stop"), 0);
	resumed.observe(delta(" https://user:ZQ"), 1);
	resumed.observe({ type: "agent_end" }, 2);
	strictEqual(resumed.snapshot().completed, false);
	const died = createChatPanel({ now: () => 1_000, getOutputStyle: () => "detailed" });
	died.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
	died.applyEvent({
		type: "message_update",
		assistantMessageEvent: {
			type: "toolcall_delta",
			contentIndex: 0,
			partial: {
				content: [{ type: "toolCall", id: "d", name: "bash", arguments: { command: "curl https://u:ZQXJ" } }],
			},
		},
	} as never);
	died.applyEvent({ type: "agent_end", messages: [] } as never);
	strictEqual(plainRows(died).match(SECRET_LETTERS), null);
	const openThought = createChatPanel({ now: () => 1_000, getOutputStyle: () => "detailed" });
	openThought.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
	openThought.applyEvent({
		type: "thinking_delta",
		contentIndex: 0,
		delta: "see https://user:ZQXJ",
		partialThinking: "x",
	});
	openThought.applyEvent({ type: "agent_end", messages: [] } as never);
	strictEqual(plainRows(openThought).match(SECRET_LETTERS), null);
	const worker = (settle: (stream: ReturnType<typeof createWorkerStream>) => void) => {
		const stream = createWorkerStream({
			readResult: () => null,
		});
		const started = stream.started({
			runId: "r",
			assignmentId: "w",
			attempt: 0,
			requestOrigin: "user",
			agentId: "coder",
			targetId: "local",
			wireModelId: "m",
			runtimeId: "openai",
			runtimeKind: "http",
			pid: 1,
		} as never);
		strictEqual(started !== null, true);
		stream.progress({ runId: "r", agentId: "coder", event: delta(done) });
		settle(stream);
		const entry = stream.get("w");
		strictEqual(entry !== undefined, true);
		return renderWorkerEntryLines(entry as never, 200, { unbounded: true })
			.map(stripTerminalSequences)
			.join("\n");
	};
	const terminal = { runId: "r", outcomeCode: null, outcomeDetail: null };
	strictEqual(worker((stream) => stream.aborted({ runId: "r" } as never)).includes(url), false);
	strictEqual(worker((stream) => stream.failed({ ...terminal, outcome: "failed" } as never)).includes(url), false);
	strictEqual(worker((stream) => stream.completed({ ...terminal, outcome: "succeeded" } as never)).includes(url), true);
	const forming = createChatPanel({ now: () => 1_000, getOutputStyle: () => "detailed" });
	forming.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
	forming.applyEvent({
		type: "message_update",
		assistantMessageEvent: {
			type: "toolcall_delta",
			contentIndex: 0,
			partial: { content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "curl https://u:ZQXJ" } }] },
		},
	} as never);
	forming.applyEvent(message([], "aborted") as never);
	forming.applyEvent({ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] } as never);
	strictEqual(plainRows(forming).match(SECRET_LETTERS), null);
	strictEqual((await viewOf(forming)).match(SECRET_LETTERS), null);
});

test("later text cannot close what a cut-off stream was holding", () => {
	for (const stopReason of CUT_OFF) {
		const next = createWorkerProgressFold();
		next.observe(delta("clone https://user:ZQXJ"), 0);
		next.observe(message([{ type: "text", text: "clone https://user:ZQXJ" }], stopReason), 1);
		next.observe(delta("next message text"), 2);
		strictEqual(next.snapshot().tailText, "clone https://user:\n\nnext message text", String(stopReason));
		const failover = createWorkerProgressFold();
		failover.observe(delta("clone https://user:ZQXJ"), 0);
		failover.observe(message([{ type: "text", text: "clone https://user:ZQXJ" }], stopReason), 1);
		failover.restart();
		failover.observe(delta("second attempt words"), 2);
		strictEqual(failover.snapshot().tailText.match(SECRET_LETTERS), null, String(stopReason));
	}
	const noEnd = createWorkerProgressFold();
	noEnd.observe(delta("clone https://user:ZQXJ"), 0);
	noEnd.restart();
	noEnd.observe(delta("second attempt words"), 1);
	strictEqual(noEnd.snapshot().tailText, "clone https://user:\n\nsecond attempt words");
	const kept = createWorkerProgressFold();
	kept.observe(delta("see http://localhost:8080"), 0);
	kept.observe(message([{ type: "text", text: "see http://localhost:8080" }], "stop"), 1);
	kept.restart();
	strictEqual(kept.snapshot().tailText, "see http://localhost:8080");
	const stream = createWorkerStream({ readResult: () => null });
	const started = {
		assignmentId: "w",
		requestOrigin: "user",
		agentId: "coder",
		targetId: "t",
		wireModelId: "m",
		runtimeId: "o",
		runtimeKind: "http",
		pid: 1,
	};
	stream.started({ ...started, runId: "r1", attempt: 0 } as never);
	stream.progress({ runId: "r1", agentId: "coder", event: delta("clone https://user:ZQXJ") });
	stream.progress({ runId: "r1", agentId: "coder", event: message([{ type: "text", text: "x" }], "error") });
	stream.started({ ...started, runId: "r2", attempt: 1 } as never);
	stream.progress({ runId: "r2", agentId: "coder", event: delta("second attempt words") });
	const frame = () =>
		renderWorkerEntryLines(stream.get("w") as never, 200, { unbounded: true })
			.map(stripTerminalSequences)
			.join("\n");
	strictEqual(frame().match(SECRET_LETTERS), null);
	stream.completed({ runId: "r2", outcome: "succeeded", outcomeCode: null, outcomeDetail: null } as never);
	strictEqual(frame().match(SECRET_LETTERS), null);
});

test("every killed tool result holds each stream's tail, and exit codes tell a kill from a failure", async () => {
	const url = "http://localhost:8080";
	const panelOf = (name: string, text: string, details: Record<string, unknown>) => {
		const panel = createChatPanel({ now: () => 1_000, getOutputStyle: () => "detailed" });
		panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
		panel.applyEvent({ type: "tool_execution_start", toolCallId: "c", toolName: name, args: {} } as never);
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "c",
			toolName: name,
			isError: true,
			result: { content: [{ type: "text", text }], details },
		} as never);
		return panel;
	};
	const script = (stdout: string, stderr: string) =>
		`run_script aborted: python3 s.py\n--- stdout tail ---\n${stdout}\n--- stderr tail ---\n${stderr}\nthe run was cancelled; the logs end where the script was stopped`;
	for (const details of [
		{ outcome: "aborted", aborted: true },
		{ outcome: "timed-out", timedOut: true },
		{ outcome: "failed", aborted: false, timedOut: false, exitCode: 137 },
	]) {
		for (const [stdout, stderr] of [
			["clone https://user:ZQXJ", "(empty)"],
			["(empty)", "clone https://user:ZQXJ"],
		] as const) {
			const panel = panelOf("run_script", script(stdout, stderr), details);
			strictEqual(plainRows(panel).match(SECRET_LETTERS), null, JSON.stringify(details));
			strictEqual((await viewOf(panel)).match(SECRET_LETTERS), null, JSON.stringify(details));
		}
	}
	strictEqual(
		plainRows(panelOf("run_script", script(`see ${url}\n`, "(empty)"), { outcome: "aborted", aborted: true })).includes(
			url,
		),
		true,
	);
	strictEqual(
		plainRows(panelOf("run_script", script(`see ${url}`, "(empty)"), { outcome: "succeeded", exitCode: 0 })).includes(
			url,
		),
		true,
	);
	const verified = panelOf("verify", "verify: command exited with code 137 before judgement: clone https://user:ZQXJ", {
		aborted: true,
		timedOut: false,
		exitCode: 137,
	});
	strictEqual(plainRows(verified).match(SECRET_LETTERS), null);
	const running = panelOf("run_script", "x", {});
	running.applyEvent({ type: "tool_execution_start", toolCallId: "d", toolName: "run_script", args: {} } as never);
	running.applyEvent({
		type: "tool_execution_update",
		toolCallId: "d",
		toolName: "run_script",
		args: {},
		partialResult: {
			content: [{ type: "text", text: script("clone https://user:ZQXJ", "(no output yet)") }],
			details: { progress: { elapsedMs: 1 } },
		},
	} as never);
	strictEqual(plainRows(running).match(SECRET_LETTERS), null);
	const failed = (exitCode: number) => `see https://user:ZQXJ\n\nbash: command failed (exit ${exitCode})`;
	for (const exitCode of [124, 128, 137, 143]) {
		const panel = killedBashPanel("see https://user:ZQXJ", {
			outcome: "nonzero",
			aborted: false,
			timedOut: false,
			exitCode,
			signal: null,
			outputEndsOpen: true,
		});
		strictEqual(plainRows(panel).match(SECRET_LETTERS), null, String(exitCode));
		strictEqual((await viewOf(panel)).match(SECRET_LETTERS), null, String(exitCode));
		strictEqual(plainRows(panelOf("bash", failed(exitCode), {})).match(SECRET_LETTERS), null, `no details ${exitCode}`);
		const shell = renderBashTranscriptExecution(
			{ command: "run", output: "see https://user:ZQXJ", exitCode } as never,
			400,
		).join("\n");
		strictEqual(shell.match(SECRET_LETTERS), null, `operator ${exitCode}`);
	}
	for (const exitCode of [1, 2, 127]) {
		const panel = killedBashPanel(`see ${url}`, {
			outcome: "nonzero",
			aborted: false,
			timedOut: false,
			exitCode,
			signal: null,
			outputEndsOpen: true,
		});
		strictEqual(plainRows(panel).includes(url), true, String(exitCode));
		strictEqual(
			renderBashTranscriptExecution({ command: "run", output: `see ${url}`, exitCode } as never, 400)
				.join("\n")
				.includes(url),
			true,
		);
	}
	const cancelled = (output: string) => {
		const panel = createChatPanel({ now: () => 1_000, getOutputStyle: () => "detailed" });
		rehydrateChatPanelFromTurns(panel, [
			{
				kind: "bashExecution",
				turnId: "b",
				parentTurnId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				command: "run",
				output,
				exitCode: null,
				cancelled: true,
				truncated: false,
				excludeFromContext: false,
			},
		] as never);
		return plainRows(panel);
	};
	strictEqual(cancelled("Local: http://localhost:5173\n").includes("http://localhost:5173"), true);
	strictEqual(cancelled("Local: http://localhost:5173").includes("http://localhost:5173"), false);
});

test("what finished stays shown: an earlier message, a finished stderr line, a tool's own timeout", () => {
	const url = "http://localhost:8080";
	for (const stopReason of CUT_OFF) {
		const fold = createWorkerProgressFold();
		fold.observe(delta(`Server at ${url}`), 0);
		fold.observe(message([{ type: "text", text: `Server at ${url}` }], "toolUse"), 1);
		fold.observe(message([], stopReason), 2);
		strictEqual(fold.snapshot().tailText, `Server at ${url}`, String(stopReason));
		fold.restart();
		strictEqual(fold.snapshot().tailText, `Server at ${url}`, `restart ${stopReason}`);
	}
	const tool = (name: string, event: "tool_execution_end" | "tool_execution_update", text: string, details: unknown) => {
		const panel = createChatPanel({ now: () => 1_000, getOutputStyle: () => "detailed" });
		const result = { content: [{ type: "text", text }], details };
		panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
		panel.applyEvent({ type: "tool_execution_start", toolCallId: "c", toolName: name, args: {} } as never);
		panel.applyEvent({
			type: event,
			toolCallId: "c",
			toolName: name,
			isError: false,
			...(event === "tool_execution_end" ? { result } : { partialResult: result, args: {} }),
		} as never);
		return plainRows(panel);
	};
	const progress = { progress: { elapsedMs: 1 } };
	const running = (stdout: string, stderr: string) =>
		`run_script: running\n--- stdout tail ---\n${stdout}\n--- stderr tail ---\n${stderr}`;
	strictEqual(
		tool("run_script", "tool_execution_update", running("(no output yet)", `Listening on ${url}\n`), progress).includes(
			url,
		),
		true,
	);
	strictEqual(
		tool(
			"run_script",
			"tool_execution_update",
			running("(no output yet)", `Listening on ${url}\nnext line\n`),
			progress,
		).includes(url),
		true,
	);
	strictEqual(
		tool("run_script", "tool_execution_update", running(`Listening on ${url}\n`, "(no output yet)"), progress).includes(
			url,
		),
		true,
	);
	strictEqual(
		tool("run_script", "tool_execution_update", running("(no output yet)", "clone https://user:ZQXJ"), progress).match(
			SECRET_LETTERS,
		),
		null,
	);
	strictEqual(
		tool("run_script", "tool_execution_update", running("clone https://user:ZQXJ", "(no output yet)"), progress).match(
			SECRET_LETTERS,
		),
		null,
	);
	const collect = `worker r1 said: Server at ${url}\n\ncollect waited 5ms; the runs keep running normally.`;
	strictEqual(tool("monitor", "tool_execution_end", collect, { timedOut: true, waitedMs: 5 }).includes(url), true);
	strictEqual(
		tool("monitor", "tool_execution_end", collect, {
			outcome: "failed",
			exitCode: 137,
			timedOut: true,
			waitedMs: 5,
		}).includes(url),
		true,
	);
	strictEqual(
		tool("panes", "tool_execution_end", `Local: ${url}\n\nwaited`, {
			action: "wait",
			state: "running",
			timedOut: true,
		}).includes(url),
		true,
	);
});

test("replay and /resume hide what the live view hid", async () => {
	const entry = (turnId: string, role: string, payload: unknown, parentTurnId: string | null) => ({
		kind: "message",
		turnId,
		parentTurnId,
		timestamp: "2026-01-01T00:00:00.000Z",
		role,
		payload,
	});
	const replay = (...entries: unknown[]) => {
		const panel = createChatPanel({ now: () => 1_000, getOutputStyle: () => "detailed" });
		rehydrateChatPanelFromTurns(panel, entries as never);
		return panel;
	};
	const thinking = (stopReason?: string) => [
		entry("u", "user", { text: "go" }, null),
		entry(
			"a",
			"assistant",
			{
				content: [{ type: "thinking", thinking: "see https://user:ZQXJ" }],
				...(stopReason === undefined ? {} : { stopReason }),
			},
			"u",
		),
	];
	for (const stopReason of ["aborted", "error", "length", undefined]) {
		const panel = replay(...thinking(stopReason));
		strictEqual(plainRows(panel).includes("https://user:"), true, String(stopReason));
		strictEqual(plainRows(panel).match(SECRET_LETTERS), null, String(stopReason));
		strictEqual((await viewOf(panel)).match(SECRET_LETTERS), null, String(stopReason));
	}
	strictEqual(plainRows(replay(...thinking("stop"))).includes("ZQXJ"), true);
	const tool = (details: unknown) => [
		entry("u", "user", { text: "go" }, null),
		entry(
			"a",
			"assistant",
			{ content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "x" } }], stopReason: "toolUse" },
			"u",
		),
		entry("tc", "tool_call", { toolCallId: "c", name: "bash", args: { command: "x" } }, "a"),
		entry(
			"tr",
			"tool_result",
			{
				toolCallId: "c",
				outcome: "error",
				result: {
					content: [{ type: "text", text: `see https://user:ZQXJ\n\n${KILLED_STATUS}` }],
					...(details === undefined ? {} : { details }),
				},
			},
			"tc",
		),
	];
	for (const details of [{ outcome: "abort", aborted: true }, undefined]) {
		const panel = replay(...tool(details));
		strictEqual(plainRows(panel).includes("https://user:"), true, JSON.stringify(details));
		strictEqual(plainRows(panel).match(SECRET_LETTERS), null, JSON.stringify(details));
		strictEqual((await viewOf(panel)).match(SECRET_LETTERS), null, JSON.stringify(details));
	}
});

test("live command output holds only an open last line", () => {
	const options = { rail: "", railWidth: 0 };
	const rows = (text: string) => new LiveToolView().outputRows(text, 5, 200, options).join("\n");
	strictEqual(rows("clone https://u:ZQ"), "clone https://u:");
	strictEqual(rows("listening on http://h:8080\n"), "listening on http://h:8080");
});

test("the evidence redactor hides the same URL text as display redaction", () => {
	const forms = [
		"https://user:ZQXJ@github.com/x",
		"HTTP://u:ZQ:XJ@h",
		"https://u:ZQXJ:@h",
		"git+https://u:Z)Q@h/r.git",
		"https://u:ZQ@XJ@h",
		"https://u:ΩЖ@h:8443/p",
		"https://u:$TOKEN@h",
		"https://ghp_x@github.com/r",
		"https://:ZQXJ@h",
		"https://u:ZQ/XJ@h",
		"http://localhost:8080/health",
		"postgres://u:ZQXJ@h",
	];
	for (const form of forms) {
		const shown = redactSecretsText(form, createRedactionTally());
		strictEqual(shown.replace("[redacted:url-userinfo]", "[redacted]"), redactSecretString(form), form);
	}
});

test("userinfo redaction counts once, survives a second pass and spans display frames", () => {
	const tally = createRedactionTally();
	const once = redactSecretsText("clone https://u:ZQXJ@h/r", tally);
	strictEqual(once, "clone https://u:[redacted:url-userinfo]@h/r");
	strictEqual(redactSecretsText(once, tally), once);
	strictEqual(redactSecretsText(redactSecretString("https://u:ZQXJ@h"), tally), "https://u:[redacted]@h");
	strictEqual(redactSecretString(once), once);
	const deeper = redactSecretsText("https://a:b:ZQ@h", tally);
	strictEqual(deeper, "https://a:[redacted:url-userinfo]@h");
	strictEqual(redactSecretsText(deeper, tally), deeper);
	strictEqual(redactSecretString("https://u:ZQ[redacted:abc]@h"), "https://u:[redacted]@h");
	strictEqual(tally.count, 2);
	deepStrictEqual(redactSecretSegments(["clone https://u:ZQ", "XJ@h/r"], createRedactionTally()), [
		"clone https://u:[redacted:url-userinfo]",
		"[redacted:url-userinfo]@h/r",
	]);
	const summary = deterministicDiagnosticSummary("fatal: https://u:ZQXJ@h/r\n", 1024);
	deepStrictEqual(summary, { text: "fatal: https://u:[redacted:url-userinfo]@h/r", redactions: 1, complete: false });
});

test("redacting a styled worker row keeps its escapes whole and its width on budget", () => {
	const reset = "\u001b[0m";
	const muted = "\u001b[38;2;137;128;113m";
	const styled = `does not govern auth-token ${reset}${muted} · ≥5,770,768 · 119 calls${reset}`;
	const row = redactSecretString(styled);
	strictEqual(row.includes(`${muted}`), true);
	strictEqual(stripTerminalSequences(row).includes(";2;137"), false);
	const hidden = redactSecretString(`--token ${muted}ZQXJSECRET${reset} next`);
	strictEqual(stripTerminalSequences(hidden), "--token [redacted] next");
	strictEqual(hidden.endsWith(`${muted}${reset} next`), true);
	const split = stripTerminalSequences(redactSecretString(`API_TO${muted}KEN=ZQXJSECRET${reset}`));
	strictEqual(split, "API_TOKEN=[redacted]");
	const link = redactSecretString("\u001b]8;;https://h/a?token=ZQXJSECRET\u0007site\u001b]8;;\u0007");
	strictEqual(link.includes("ZQXJSECRET"), false);
	strictEqual(stripTerminalSequences(link), "site");

	const text =
		"The new per-target timeout is only for model requests and it does not govern auth-token x refresh or login";
	const telemetry = {
		row: { tokens: { display: "≥5,770,768 (1 call unknown)" } },
		activity: { toolCalls: { display: "119" }, elapsed: { display: "30m" } },
	};
	const entry = {
		runId: "r",
		agentId: "architect",
		task: "t",
		text,
		pending: true,
		runtime: {},
		progress: { phase: "writing" },
	};
	for (let width = 40; width <= 180; width += 1) {
		for (const line of renderWorkerEntryLines(entry as never, width, { telemetry: telemetry as never })) {
			strictEqual(stripTerminalSequences(line).includes(";2;"), false, `width ${width}: ${JSON.stringify(line)}`);
			strictEqual(visibleWidth(line) <= width, true, `width ${width}: ${visibleWidth(line)} ${JSON.stringify(line)}`);
		}
	}
});

test("no secret survives redaction wherever a styled line holds it, and every SGR sequence stays whole", () => {
	const secret = "ZQXJSECRET";
	const sgr = "\u001b[38;2;137;128;113m";
	const reset = "\u001b[0m";
	const end = "\u001b\\";
	const cases = {
		plain: `--token ${secret} next`,
		"styled on both sides": `${sgr}--token ${reset}${sgr}${secret}${reset} next`,
		"split by SGR": `--token ZQXJ${sgr}SECRET${reset} next`,
		"OSC payload": `\u001b]8;;https://h/a?token=${secret}\u0007site\u001b]8;;\u0007 ${sgr}x${reset}`,
		"DCS payload": `\u001bPq;token=${secret}${end} ${sgr}x${reset}`,
		"SOS payload": `\u001bXtoken=${secret}${end} ${sgr}x${reset}`,
		"PM payload": `\u001b^token=${secret}${end} ${sgr}x${reset}`,
		"APC payload": `\u001b_token=${secret}${end} ${sgr}x${reset}`,
		"named outside an APC payload": `--token \u001b_${secret}${end} ${sgr}x${reset}`,
		"twice in one line": `--token ${secret} ${sgr}mid${reset} API_KEY=${secret}`,
	};
	// biome-ignore lint/suspicious/noControlCharactersInRegex: an SGR escape is what this test counts.
	const sgrOf = (text: string) => text.match(/\u001b\[[0-9;]*m/gu) ?? [];
	for (const [name, line] of Object.entries(cases)) {
		const out = redactSecretString(line);
		strictEqual(/ZQXJ|SECRET/u.test(out), false, `${name}: ${JSON.stringify(out)}`);
		strictEqual(/ZQXJ|SECRET/u.test(stripTerminalSequences(out)), false, `${name}: stripped`);
		deepStrictEqual(sgrOf(out), sgrOf(line), name);
	}
});

test("a /view row whose redaction outgrows it is fitted to its width again", async () => {
	const panel = createChatPanel({ now: () => 1_000 });
	panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
	const text = "it does not govern auth-token x refresh or login in any code path that exists and auth-token y";
	panel.applyEvent({
		type: "tool_execution_start",
		toolCallId: "c",
		toolName: "bash",
		args: { command: "run" },
	} as never);
	panel.applyEvent({
		type: "tool_execution_end",
		toolCallId: "c",
		toolName: "bash",
		isError: false,
		result: { content: [{ type: "text", text }] },
	} as never);
	for (const artifact of panel.inspectionArtifacts()) {
		const { render } = await artifact.load();
		for (let width = 20; width <= 120 && render !== undefined; width += 1) {
			for (const row of render(width)) strictEqual(visibleWidth(row) <= width, true, `${width}: ${JSON.stringify(row)}`);
		}
	}
});

const WARNING: RunEventJournalBody = { kind: "event", type: "route_warning", detail: "late" };
const MESSAGE_STOP: RunEventJournalBody = { kind: "event", type: "message_end", stopReason: "stop" };

/** Feed a run through the writer and read back its rows' text in order, an event row showing as its type in brackets. */
function feedRows(runId: string, ...items: (string | RunEventJournalBody)[]): string {
	for (const item of items) {
		appendRunFeed(runId, typeof item === "string" ? { kind: "event", type: "text", detail: item } : item);
	}
	return readFileSync(runFeedPath(runId, clioStateDir()), "utf8")
		.trim()
		.split("\n")
		.map((raw) => {
			const row = JSON.parse(raw) as { kind: string; type?: string; detail?: string };
			return row.type === "text" ? (row.detail ?? "") : `[${row.type ?? row.kind}]`;
		})
		.join("");
}

test("a run feed releases held text only at a message that stopped on purpose", async () => {
	const env = await isolateClioEnv("url-userinfo-feed-");
	try {
		const open = "clone https://user:ZQXJ";
		for (const stopReason of ["stop", "toolUse"]) {
			const end: RunEventJournalBody = { kind: "event", type: "message_end", stopReason };
			strictEqual(feedRows(`done-${stopReason}`, "well ", open, end), `well ${open}[message_end]`);
		}
		strictEqual(
			feedRows("dev-server", "see http://localhost:8080", MESSAGE_STOP, "next message "),
			"see http://localhost:8080[message_end]",
		);
		for (const stopReason of ["length", "error", "aborted", "unknown"]) {
			const end: RunEventJournalBody = { kind: "event", type: "message_end", stopReason };
			strictEqual(
				feedRows(`cut-${stopReason}`, open, end, "the next message is whole ", MESSAGE_STOP),
				"clone https://user:[message_end]the next message is whole [message_end]",
			);
		}
		const attempt: RunEventJournalBody = { kind: "event", type: "attempt_start", detail: "retry" };
		strictEqual(
			feedRows("retried", open, attempt, "second try ", MESSAGE_STOP),
			"clone https://user:[attempt_start]second try [message_end]",
		);
		strictEqual(
			feedRows("died", open, { kind: "result", outcome: "failed", exitCode: 1 }, { kind: "terminal", outcome: "failed" }),
			"clone https://user:[result][terminal]",
		);
	} finally {
		env.restore();
	}
});

test("a row arriving mid-text splits nothing and loses nothing on a completed run", async () => {
	const env = await isolateClioEnv("url-userinfo-feed-");
	try {
		const cases = [
			"https://user:ZQXJZQXJ@host/repo",
			"password: ZQXJZQXJ",
			"password = ZQXJZQXJ",
			"password=ZQXJZQXJ",
			"Authorization: Bearer ZQXJZQXJ",
		];
		let run = 0;
		for (const secret of cases) {
			const text = `before words ${secret} after words here now`;
			for (let offset = 1; offset < text.length; offset += 1) {
				run += 1;
				const rows = feedRows(`mid-${run}`, text.slice(0, offset), WARNING, text.slice(offset), MESSAGE_STOP);
				const where = `offset ${offset} of ${text}`;
				strictEqual(rows.match(SECRET_LETTERS), null, where);
				const shown = rows.replace("[route_warning]", "").replace("[message_end]", "");
				strictEqual(shown, redactSecretsText(text, createRedactionTally()), where);
			}
		}
	} finally {
		env.restore();
	}
});

test("the end of a text block releases the carry in order, for a runtime whose tools run inside one message", async () => {
	const env = await isolateClioEnv("url-userinfo-feed-");
	try {
		const tool: RunEventJournalBody = { kind: "event", type: "clio_coder_tool_start", tool: "bash" };
		strictEqual(
			feedRows("in-order", "let me check the file", tool, "it looks fine", MESSAGE_STOP),
			"let me check the file[clio_coder_tool_start]it looks fine[message_end]",
		);
	} finally {
		env.restore();
	}
});

test("the run feed's bound never splits a password across rows and keeps what a long harmless token cannot hide", async () => {
	const env = await isolateClioEnv("url-userinfo-feed-");
	try {
		const long = "q".repeat(4100);
		const rest = " words here now ";
		const bound = feedRows("bound", `${long}https://user:ZQXJ`, "ZQXJ@host/x next", rest, MESSAGE_STOP);
		strictEqual(bound, `${long}https://user:words here now [message_end]`);
		const oversized = feedRows("over", `https://user:${"Z".repeat(5000)}`, "ZQ@host/x next", rest, MESSAGE_STOP);
		strictEqual(oversized.match(SECRET_LETTERS), null);
		strictEqual(oversized.endsWith(`words here now [message_end]`), true);
		const name = feedRows("name", `${long} https://user`, ":ZQXJ@host/x next", rest, MESSAGE_STOP);
		strictEqual(name.match(SECRET_LETTERS), null);
		const scheme = feedRows("scheme", `${long} https:/`, "/user:ZQXJ@host/x next", rest, MESSAGE_STOP);
		strictEqual(scheme.match(SECRET_LETTERS), null);
		const key = feedRows("key", `${long}password:`, " ZQXJ next", rest, MESSAGE_STOP);
		strictEqual(key.match(SECRET_LETTERS), null);
		const url = `https://example.com/${"q".repeat(5000)}`;
		strictEqual(feedRows("plain", url, "/rest next", rest, MESSAGE_STOP), `${url}/rest next${rest}[message_end]`);
		const cut = feedRows("message", `${long}https://user:ZQXJ`, MESSAGE_STOP, "whole next message ", MESSAGE_STOP);
		strictEqual(cut, `${long}https://user:[message_end]whole next message [message_end]`);
	} finally {
		env.restore();
	}
});

test("writer eviction keeps a run's held text and its discard", async () => {
	const env = await isolateClioEnv("url-userinfo-feed-");
	try {
		appendRunFeed("held", { kind: "event", type: "text", detail: "see https://user:ZQ" });
		appendRunFeed("guarded", { kind: "event", type: "text", detail: `${"q".repeat(4100)}https://user:ZQ` });
		for (let index = 0; index < 300; index += 1) feedRows(`other-${index}`, "some words", MESSAGE_STOP);
		const held = feedRows("held", "XJ@host/x next words", MESSAGE_STOP);
		strictEqual(held.match(SECRET_LETTERS), null);
		strictEqual(held, "see https://user:[redacted:url-userinfo]@host/x next words[message_end]");
		const guarded = feedRows("guarded", "XJ@host/x next words here now ", MESSAGE_STOP);
		strictEqual(guarded.match(SECRET_LETTERS), null);
		strictEqual(guarded.endsWith("words here now [message_end]"), true);
	} finally {
		env.restore();
	}
});

test("a cut-off message's text on its message_end row keeps its open URL back", () => {
	const handlers = new Map<string, (payload: unknown) => void>();
	const bus = {
		subscribe(name: string, handler: (payload: unknown) => void) {
			handlers.set(name, handler);
			return () => {};
		},
		emit() {},
	};
	const rows: { type: string; detail?: string; stopReason?: string }[] = [];
	const journal = {
		open() {},
		append(_runId: string, entry: { type: string; detail?: string; stopReason?: string }) {
			rows.push(entry);
		},
		result() {},
		terminal() {},
	};
	const bridge = attachRunEventJournalBridge(bus as never, { journal: journal as never, nowMs: () => 0 });
	const send = (runId: string, stopReason: string | undefined) =>
		handlers.get("run.progressed")?.({
			runId,
			agentId: "a",
			event: {
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "clone https://user:ZQXJ" }],
					usage: { input: 1, output: 1, totalTokens: 2 },
					...(stopReason === undefined ? {} : { stopReason }),
				},
			},
		});
	for (const stopReason of ["length", "aborted", "error", undefined]) send(`cut-${stopReason}`, stopReason);
	send("done", "stop");
	bridge.stop();
	deepStrictEqual(
		rows.map((row) => [row.detail, row.stopReason]),
		[
			["clone https://user:", "length"],
			// An aborted or failed message projects no text of its own.
			[undefined, "aborted"],
			[undefined, "error"],
			["clone https://user:", "unknown"],
			["clone https://user:ZQXJ", "stop"],
		],
	);
});

test("live command output keeps stdout's open URL back past stderr, and a finished line still releases", () => {
	const shown = (stdout: string, stderr: string) => {
		const raw = combineLiveBashOutput({ stdout, stderr });
		return new LiveToolView()
			.outputRows((shapeBashProgress(raw, raw.length, "bounded") as { output: string }).output, 5, 400, {
				rail: "",
				railWidth: 0,
			})
			.join("\n");
	};
	strictEqual(shown("curl https://user:ZQXJ", "retrying\n"), "curl https://user:\nretrying");
	strictEqual(shown("curl https://user:ZQXJ", "retrying"), "curl https://user:\nretrying");
	strictEqual(shown("curl https://user:ZQXJ@host/x\n", "retrying\n"), "curl https://user:[redacted]@host/x\nretrying");
	strictEqual(shown("listening on http://h:8080\n", "retrying\n"), "listening on http://h:8080\nretrying");
	strictEqual(shown("listening on http://h:8080/x", "retrying\n"), "listening on http://h:8080/x\nretrying");
	strictEqual(shown("", "curl https://user:ZQXJ"), "curl https://user:");
	strictEqual(shown("curl https://user:ZQXJ", ""), "curl https://user:");
});

test("a worker's stream reaches the feed file held when it dies and whole when it stops", async () => {
	const env = await isolateClioEnv("url-userinfo-feed-");
	try {
		const handlers = new Map<string, (payload: unknown) => void>();
		const bus = {
			subscribe(name: string, handler: (payload: unknown) => void) {
				handlers.set(name, handler);
				return () => {};
			},
			emit() {},
		};
		const bridge = attachRunEventJournalBridge(bus as never, { nowMs: () => 0 });
		const progress = (runId: string, event: unknown) => handlers.get("run.progressed")?.({ runId, agentId: "a", event });
		const end = (stopReason: string) => ({
			type: "message_end",
			message: { role: "assistant", content: [], usage: { input: 1, output: 1, totalTokens: 2 }, stopReason },
		});
		const open = "clone https://user:ZQXJ";
		progress("stopped", { type: "text_delta", delta: open });
		progress("stopped", end("stop"));
		handlers.get("run.completed")?.({ runId: "stopped", agentId: "a", outcome: "completed", outcomeDetail: null });
		progress("aborted", { type: "text_delta", delta: open });
		progress("aborted", end("aborted"));
		handlers.get("run.failed")?.({ runId: "aborted", agentId: "a", outcome: "failed", outcomeDetail: null });
		progress("killed", { type: "text_delta", delta: open });
		handlers.get("run.failed")?.({ runId: "killed", agentId: "a", outcome: "failed", outcomeDetail: null });
		bridge.stop();
		const text = (runId: string) => feedRows(runId).replace(/^\[open\]/u, "");
		strictEqual(text("stopped"), `${open}[message_end][result][terminal]`);
		strictEqual(text("aborted"), "clone https://user:[message_end][result][terminal]");
		strictEqual(text("killed"), "clone https://user:[result][terminal]");
	} finally {
		env.restore();
	}
});
