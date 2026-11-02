import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { createRedactionTally, redactSecretSegments, redactSecretsText } from "../../src/domains/evidence/redact.js";
import {
	holdUnresolvedStrings,
	RedactedStringProjection,
	redactSecretString,
	redactStreamingSecretString,
} from "../../src/domains/safety/redaction.js";
import { createWorkerProgressFold, WORKER_LIVE_TAIL_MAX_BYTES } from "../../src/domains/telemetry/worker-progress.js";
import { LiveToolView } from "../../src/interactive/renderers/live-tool-view.js";
import { safeWorkerAnswerText, WorkerAnswerProjection } from "../../src/interactive/renderers/worker-answer.js";
import { deterministicDiagnosticSummary } from "../../src/tools/result-disposition.js";

const SEED = Number(process.env.URL_USERINFO_FUZZ_SEED ?? 0x5eed);
const DOCUMENTS = Number(process.env.URL_USERINFO_FUZZ_DOCUMENTS ?? 60);
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

test("the live worker tail cannot cut a scheme or key off a secret", () => {
	const head = "start https://u:ZQXJ@host/x API_KEY=ZQXJ ";
	for (let cut = 0; cut <= head.length; cut += 1) {
		const line = `${head}${"a ".repeat(Math.ceil((WORKER_LIVE_TAIL_MAX_BYTES + cut - head.length) / 2))}`;
		const fold = createWorkerProgressFold();
		fold.observe(
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: line.slice(0, WORKER_LIVE_TAIL_MAX_BYTES + cut) },
			},
			0,
		);
		strictEqual(redactSecretString(fold.snapshot().tailText).match(SECRET_LETTERS), null, `cut ${cut}`);
	}
	const unbroken = createWorkerProgressFold();
	unbroken.observe(
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `https://u:${"Z".repeat(5000)}` } },
		0,
	);
	strictEqual(unbroken.snapshot().tailText, "");
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
	strictEqual(tally.count, 1);
	deepStrictEqual(redactSecretSegments(["clone https://u:ZQ", "XJ@h/r"], createRedactionTally()), [
		"clone https://u:[redacted:url-userinfo]",
		"[redacted:url-userinfo]@h/r",
	]);
	const summary = deterministicDiagnosticSummary("fatal: https://u:ZQXJ@h/r\n", 1024);
	deepStrictEqual(summary, { text: "fatal: https://u:[redacted:url-userinfo]@h/r", redactions: 1, complete: false });
});
