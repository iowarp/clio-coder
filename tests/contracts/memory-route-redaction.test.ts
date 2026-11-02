import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { completedLessonSource } from "../../src/domains/memory/history-review.js";
import { createMemoryInterventionRegistration } from "../../src/domains/memory/intervention.js";
import { reflectionRequest } from "../../src/domains/memory/observations.js";
import { MemoryRuntime } from "../../src/domains/memory/runtime.js";
import { redactForMemoryRoute } from "../../src/domains/memory/secret-text.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import type { TaskMemoryModelRequest } from "../../src/domains/memory/task-memory-policy.js";
import { runTaskMemoryPolicy } from "../../src/domains/memory/task-memory-policy.js";
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

it("exempts a whole variable reference or path, and nothing shorter or longer than one", () => {
	for (const command of [
		"git clone https://$GH_USER:$GH_TOKEN@github.com/a/b.git",
		"curl https://user:$API_PASSWORD@api.example.com/x",
		"curl https://token:$GH_TOKEN@github.com/a",
		"grep -n token: src/a.ts",
	]) {
		strictEqual(redactForMemoryRoute(command), command);
	}
	const proven = completedLessonSource(
		task("git clone https://$GH_USER:$GH_TOKEN@github.com/a/b.git", "clone"),
		"/repo",
	);
	deepStrictEqual([...(proven?.succeededCommands ?? [])], ["git clone https://$GH_USER:$GH_TOKEN@github.com/a/b.git"]);
	for (const [text, secret] of [
		["password: a$ABCDEFGHIJ", "a$ABCDEFGHIJ"],
		['"api_key": "x$ABCDEFGHIJKLMN"', "x$ABCDEFGHIJKLMN"],
		["deploy $AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
		["deploy --token hunter2hunter2 now", "hunter2hunter2"],
		["PASSWD=abc123 then go", "abc123"],
	] as const) {
		strictEqual(redactForMemoryRoute(text).includes(secret), false, text);
	}
});
