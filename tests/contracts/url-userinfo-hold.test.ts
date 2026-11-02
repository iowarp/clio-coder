import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { clioStateDir } from "../../src/core/xdg.js";
import type { RunEventJournalBody } from "../../src/domains/dispatch/run-event-journal.js";
import { appendRunFeed, runFeedPath } from "../../src/domains/dispatch/run-feed.js";
import { createRedactionTally, redactSecretSegments, redactSecretsText } from "../../src/domains/evidence/redact.js";
import {
	holdUnresolvedStrings,
	RedactedStringProjection,
	redactSecretString,
	redactStreamingSecretString,
} from "../../src/domains/safety/redaction.js";
import {
	createWorkerProgressFold,
	WORKER_LIVE_TAIL_MAX_BYTES,
	WORKER_PROGRESS_WINDOW_BYTES,
	WORKER_PROGRESS_WINDOW_MS,
} from "../../src/domains/telemetry/worker-progress.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { LiveToolView } from "../../src/interactive/renderers/live-tool-view.js";
import {
	liveWorkerAnswerText,
	safeWorkerAnswerText,
	WorkerAnswerProjection,
} from "../../src/interactive/renderers/worker-answer.js";
import { shapeBashProgress } from "../../src/tools/bash.js";
import { deterministicDiagnosticSummary } from "../../src/tools/result-disposition.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const SEED = 0x5eed;
const DOCUMENTS = 60;
const CHUNKINGS = 6;

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
	"https://:ZQXJ@h",
	"https://u:ZQ/XJ@h",
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

/** The stated contract, written apart from the code: the last run after a scheme shows through its first colon. */
function expectedFrame(prefix: string): string {
	const open = /https?:\/\/([^\s/@]*)$/iu.exec(prefix);
	if (open === null) return redactSecretString(prefix);
	const runStart = open.index + open[0].length - (open[1]?.length ?? 0);
	const colon = prefix.indexOf(":", runStart);
	return redactSecretString(colon < 0 ? prefix : prefix.slice(0, colon + 1));
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

test("a run that never ends gains a marker past the limit and never shows what it holds", () => {
	const run = `https://u:${"Z".repeat(5000)}`;
	strictEqual(redactStreamingSecretString(run), "https://u:[held]");
	strictEqual(redactStreamingSecretString(`${run}@h`), "https://u:[redacted]@h");
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
	for (const text of CORPUS) {
		const oneShot = redactSecretString(text);
		for (const fill of fillers) {
			for (let offset = 0; offset <= text.length + 2; offset += 1) {
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
	for (const text of CORPUS) {
		const oneShot = redactSecretString(text);
		for (let offset = 0; offset <= text.length + 2; offset += 1) {
			const where = `offset ${offset} of ${JSON.stringify(text)}`;
			strictEqual(leaked(shown(`${text} ${"z".repeat(cap - text.length - 1 + offset)}`), oneShot).join(""), "", where);
			const words = `${text} ${"zz ".repeat(Math.ceil((cap + offset) / 3))}`;
			strictEqual(leaked(shown(words.slice(0, cap + offset)), oneShot).join(""), "", `words ${where}`);
		}
	}
	strictEqual(leaked(shown(`--token\nZQXJ\n${"line\n".repeat(cap / 5)}`), "").join(""), "");
	const dev = shown(`${"line\n".repeat(cap / 4)}Local: http://localhost:5173\n`);
	strictEqual(dev.split("\n").at(-1), "Local: http://localhost:5173");
	strictEqual(
		shown(`${"line\n".repeat(cap / 4)}Local: http://localhost:5173`)
			.split("\n")
			.at(-1),
		"Local: http://localhost:",
	);
});

test("/view holds open thinking the way the rail does", async () => {
	const panel = createChatPanel({ now: () => 1_000 });
	panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
	panel.applyEvent({ type: "thinking_delta", contentIndex: 0, delta: "clone https://user:ZQXJ", partialThinking: "x" });
	const open = panel.inspectionArtifacts().find((artifact) => artifact.title.startsWith("Thinking"));
	strictEqual(open?.title, "Thinking · clone https://user:");
	strictEqual((await open?.load())?.lines.join("\n"), "clone https://user:");
});

test("the run feed never splits a password across rows", async () => {
	const env = await isolateClioEnv("url-userinfo-feed-");
	try {
		const rows = (id: string, ...details: (string | RunEventJournalBody)[]): string => {
			for (const item of details) {
				appendRunFeed(id, typeof item === "string" ? { kind: "event", type: "text", detail: item } : item);
			}
			appendRunFeed(id, { kind: "terminal", outcome: "ok" });
			return readFileSync(runFeedPath(id, clioStateDir()), "utf8")
				.trim()
				.split("\n")
				.map((row) => (JSON.parse(row) as { detail?: string }).detail ?? "")
				.join("|");
		};
		const long = "q".repeat(4100);
		const bound = rows("feed-bound", `${long}https://user:ZQXJ`, "ZQXJ@host/x next", " words here now ");
		strictEqual(bound.match(SECRET_LETTERS), null);
		const oversized = rows("feed-oversized", `https://user:${"Z".repeat(5000)}`, "ZQ@host/x next", " words here now ");
		strictEqual(oversized.match(SECRET_LETTERS), null);
		const warning = { kind: "event", type: "route_warning", detail: "late" } as const;
		const midUrl = rows("feed-event", "see https://user:ZQ", warning, "XJ@host/x next words here now ");
		strictEqual(midUrl.match(SECRET_LETTERS), null);
		const scheme = rows("feed-scheme", `${long}htt`, warning, "ps://user:ZQXJ@host/x next words here now ");
		strictEqual(scheme.match(SECRET_LETTERS), null);
	} finally {
		env.restore();
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
	strictEqual(deeper, "https://a:b:[redacted:url-userinfo]@h");
	strictEqual(redactSecretsText(deeper, tally), deeper);
	strictEqual(redactSecretString("https://u:ZQ[redacted:abc]@h"), "https://u:ZQ[redacted:[redacted]@h");
	strictEqual(tally.count, 2);
	deepStrictEqual(redactSecretSegments(["clone https://u:ZQ", "XJ@h/r"], createRedactionTally()), [
		"clone https://u:[redacted:url-userinfo]",
		"[redacted:url-userinfo]@h/r",
	]);
	const summary = deterministicDiagnosticSummary("fatal: https://u:ZQXJ@h/r\n", 1024);
	deepStrictEqual(summary, { text: "fatal: https://u:[redacted:url-userinfo]@h/r", redactions: 1, complete: false });
});
