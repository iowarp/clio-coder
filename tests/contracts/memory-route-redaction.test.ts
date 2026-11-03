import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createRedactionTally, headForRedaction, redactSecretsText } from "../../src/domains/evidence/redact.js";
import { completedLessonSource } from "../../src/domains/memory/history-review.js";
import { createMemoryInterventionRegistration } from "../../src/domains/memory/intervention.js";
import { reflectionRequest } from "../../src/domains/memory/observations.js";
import { MemoryRuntime } from "../../src/domains/memory/runtime.js";
import { memoryRouteJson, redactForMemoryRoute } from "../../src/domains/memory/secret-text.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import type { TaskMemoryModelRequest } from "../../src/domains/memory/task-memory-policy.js";
import { runTaskMemoryPolicy } from "../../src/domains/memory/task-memory-policy.js";
import { RedactedStringProjection } from "../../src/domains/safety/redaction.js";
import type { SessionEntry } from "../../src/domains/session/index.js";
import { observationSourceUnits } from "../../src/domains/session/memory-source.js";

const entry = (turnId: string, role: string, payload: unknown): SessionEntry =>
	({
		kind: "message",
		turnId,
		parentTurnId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		role,
		payload,
	}) as SessionEntry;

const task = (command: string, id: string): SessionEntry[] => [
	entry(`${id}-u`, "user", {
		text: `run it, key AKIAIOSFODNN7EXAMPLE`,
		operatorText: "run it, key AKIAIOSFODNN7EXAMPLE",
	}),
	entry(`${id}-c`, "tool_call", { toolCallId: id, name: "bash", args: { command } }),
	entry(`${id}-r`, "tool_result", {
		toolCallId: id,
		outcome: "ok",
		result: { content: [{ type: "text", text: "done" }], details: { kind: "ok", outcome: "success", exitCode: 0 } },
	}),
	entry(`${id}-a`, "assistant", { text: "done", stopReason: "stop" }),
];

it("keeps bare secrets from a memory route without letting redacted text ground a lesson", () => {
	const secret = completedLessonSource(task("node scripts/deploy.mjs AKIAIOSFODNN7EXAMPLE", "secret"), "/repo");
	ok(secret);
	doesNotMatch(secret.text, /AKIAIOSFODNN7EXAMPLE/);
	match(secret.text, /ok: node scripts\/deploy\.mjs \[redacted:aws-access-key\]/);
	deepStrictEqual([...secret.succeededCommands], [], "text the operator never ran proves nothing");

	const reference = "API_TOKEN=$API_TOKEN node scripts/deploy.mjs";
	const named = completedLessonSource(task(reference, "named"), "/repo");
	ok(named);
	match(named.text, /ok: API_TOKEN=\$API_TOKEN node scripts\/deploy\.mjs/);
	deepStrictEqual([...named.succeededCommands], [reference], "a variable reference holds no credential");
});

// The seam: a raw string does not compile as a request's prompt, so a new caller cannot bypass redaction.
// @ts-expect-error A plain string is not cleared for a memory route.
const _uncleared: TaskMemoryModelRequest["userPrompt"] = "raw";
void _uncleared;

const SECRETS = "AKIAIOSFODNN7EXAMPLE ghp_abcdefghijklmnopqrstuvwxyz0123 https://user:hunter2hunter2@host/x";
const RAW = /AKIAIOSFODNN7EX|ghp_abcdefg|hunter2hunter2/;

it("observation and reflection requests carry no raw secret", async () => {
	const dir = mkdtempSync(join(tmpdir(), "memory-route-observation-"));
	const prompts: string[] = [];
	const scope = { sessionId: "s", branchAnchorTurnId: null };
	const runtime = new MemoryRuntime();
	runtime.createIntervention({}).bindCommitScope(scope);
	const entries = [
		entry("u", "user", { text: `${SECRETS} ${"word ".repeat(1400)}` }),
		entry("a", "assistant", { text: `ok ${"more ".repeat(400)}`, stopReason: "stop" }),
	];
	runtime.configure({
		stateDir: () => dir,
		dataDir: () => dir,
		cwd: () => dir,
		settings: () => ({ enabled: true, observations: { enabled: true }, maxOutputTokens: 512, timeoutMs: 5000 }),
		lessonSource: () => null,
		source: () => ({ ...scope, checkpoint: null, units: observationSourceUnits(entries) }),
		usableHistoryTokens: () => 100_000,
		client: {
			getModelClient: () => ({
				complete: async (request: TaskMemoryModelRequest) => {
					prompts.push(request.userPrompt);
					return { text: '{"notes":[]}' };
				},
			}),
			getModelMaxTokens: (configured: number) => configured,
			backgroundEndpointBusy: () => false,
		},
	} as never);
	try {
		await runtime.runIdleStep();
		ok(prompts.length > 0);
		for (const prompt of prompts) doesNotMatch(prompt, RAW);
		const inputs = [{ notes: [{ id: "n1", text: SECRETS }] }] as never;
		doesNotMatch(reflectionRequest(inputs, []).userPrompt, RAW);
	} finally {
		runtime.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("redacts before cutting, so a cut leaves no partial secret", async () => {
	let prompt = "";
	const client = {
		complete: async (request: TaskMemoryModelRequest) => {
			prompt = request.userPrompt;
			return { text: "<operations>[]</operations>\n<no_intervention/>" };
		},
	};
	const policy = (task: string) =>
		runTaskMemoryPolicy(new TaskMemoryBank(), client, {
			task,
			trajectory: [],
			deterministicTrigger: false,
			maxTokens: 256,
			modelMaxTokens: 256,
			timeoutMs: 2000,
			signal: new AbortController().signal,
		});
	await policy(`${"x".repeat(2000 - "https://u:hunter2hunter2".length)}https://u:hunter2hunter2@host/a`);
	doesNotMatch(prompt, /hunter2/);
	await policy(`${"x".repeat(2000 - 15)} AKIAIOSFODNN7EXAMPLE`);
	doesNotMatch(prompt, /AKIA/);
	const memory = createMemoryInterventionRegistration({ bank: new TaskMemoryBank(), getModelClient: () => client });
	memory.evaluate({ hook: "turn_start", sessionId: "s", text: `${"y".repeat(2000 - 15)} AKIAIOSFODNN7EXAMPLE` });
	await memory.runPromptedStep({ deterministicTrigger: true });
	doesNotMatch(prompt, /AKIA/);
});

it("keeps a whole variable reference, with a host only as URL userinfo, and nothing that merely looks like one", () => {
	const kept = [
		"git clone https://$GH_USER:$GH_TOKEN@github.com/a/b.git",
		"curl https://user:$API_PASSWORD@api.example.com/x",
		"curl https://token:$GH_TOKEN@github.com/a",
		"API_TOKEN=$API_TOKEN node x.mjs",
	];
	for (const command of kept) strictEqual(redactForMemoryRoute(command), command);
	for (const command of kept.slice(0, 2)) {
		const proven = completedLessonSource(task(command, "kept"), "/repo");
		deepStrictEqual([...(proven?.succeededCommands ?? [])], [command]);
	}
	for (const [text, secret] of [
		["password: a$ABCDEFGHIJ", "a$ABCDEFGHIJ"],
		['"api_key": "x$ABCDEFGHIJKLMN"', "x$ABCDEFGHIJKLMN"],
		["deploy $AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
		["deploy --token hunter2hunter2 now", "hunter2hunter2"],
		["PASSWD=abc123 then go", "abc123"],
		["password: $AB@hunter2hunter2", "hunter2hunter2"],
		["https://x.example/a?password:$AB@hunter2hunter2", "hunter2hunter2"],
		["password: /hunter2hunter2", "hunter2hunter2"],
		["password: ./hunter2hunter2", "hunter2hunter2"],
		["secret: /K7MDENG/bPxRfiCYEXAMPLEKEY", "K7MDENG"],
		["AWS_SECRET_ACCESS_KEY: /K7MDENG/bPxRfiCYEXAMPLEKEY", "K7MDENG"],
		["client_secret: Zm9v/YmFy/aHVudGVyMg.b", "aHVudGVyMg"],
	] as const) {
		strictEqual(redactForMemoryRoute(text).includes(secret), false, text);
	}
	// A secret can look like a path, so these fail closed: they stay hidden and cannot ground a lesson.
	for (const command of [
		"curl -H 'token: /hunter2hunter2' https://x.example/y",
		"login --conf password:$AB@hunter2hunter2",
		"grep -n token: src/a.ts",
		"node run.mjs token: src/a.test.ts",
	]) {
		// The sibling is worth a lesson, so a source exists and this command's absence from it means something.
		const sibling = task("node build.mjs", "sibling").slice(1, 3);
		const [ask, ...rest] = task(command, "closed");
		const source = completedLessonSource([ask as SessionEntry, ...sibling, ...rest], "/repo");
		strictEqual(source?.succeededCommands.has("node build.mjs"), true, command);
		strictEqual(source?.succeededCommands.has(command), false, command);
	}
});

it("a structured prompt hides what tool arguments hide, and property names carry no secret", () => {
	const json = (value: unknown): unknown => JSON.parse(memoryRouteJson(value));
	deepStrictEqual(json({ env: { DB_PASS: "hunter2hunter2" } }), { env: { DB_PASS: "[redacted]" } });
	deepStrictEqual(json({ token: ["hunter2hunter2"] }), { token: "[redacted]" });
	deepStrictEqual(json({ password: { value: "hunter2hunter2" } }), { password: "[redacted]" });
	deepStrictEqual(json({ env: { AKIAIOSFODNN7EXAMPLE: "x" } }), { env: { "[redacted:aws-access-key]": "[redacted]" } });
	deepStrictEqual(json({ a: [{ AKIAIOSFODNN7EXAMPLE: 1 }] }), { a: [{ "[redacted:aws-access-key]": 1 }] });
	deepStrictEqual(json({ author: "Ada", authority: "x", co_author: "Bo" }), {
		author: "Ada",
		authority: "x",
		co_author: "Bo",
	});
	deepStrictEqual(json({ author_token: "hunter2hunter2", authorization: "x" }), {
		author_token: "[redacted]",
		authorization: "[redacted]",
	});
});

it("redaction stays linear on the shapes that once stalled it", () => {
	for (const text of ["token-".repeat(1400), `authorization${" ".repeat(80_000)}`, "-eyJ".repeat(20_000)]) {
		const started = performance.now();
		redactSecretsText(text, createRedactionTally());
		ok(performance.now() - started < 1000, text.slice(0, 20));
	}
});

it("display redaction stays linear on the shapes that once stalled it", () => {
	for (const text of ["api_key_".repeat(40_000), "&token".repeat(53_000)]) {
		const started = performance.now();
		redactForMemoryRoute(text);
		ok(performance.now() - started < 1000, text.slice(0, 20));
	}
	const started = performance.now();
	new RedactedStringProjection().project("a".repeat(320_000));
	ok(performance.now() - started < 1000, "projection");
});

it("a bound before redaction takes a token it lands inside whole", () => {
	const text = "aaa AKIAIOSFODNN7EXAMPLE rest";
	strictEqual(headForRedaction(text, 100), text);
	strictEqual(headForRedaction(text, 10), "aaa");
	strictEqual(headForRedaction(text, 24), "aaa AKIAIOSFODNN7EXAMPLE");
	strictEqual(headForRedaction("x".repeat(50), 10), "");
});
