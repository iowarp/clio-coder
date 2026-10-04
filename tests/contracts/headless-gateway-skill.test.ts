import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { captureSkillContext } from "../../src/domains/session/compaction/compact.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { isSessionEntry, latestSkillContextState } from "../../src/domains/session/entries.js";
import { buildModelReplayAgentMessagesFromTurns } from "../../src/session-control/model-session-replay.js";
import { runCli } from "../harness/headless-run.js";
import {
	closeServer,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { makeScratchHome } from "../harness/scratch-env.js";

const name = "gateway-evidence";
const body = `FULL_SKILL_START\n${"Preserve this exact workflow instruction.\n".repeat(1000)}FULL_SKILL_END\n`;

async function skillTurn(t: TestContext, autonomy: string, requestedName = name) {
	const scratch = makeScratchHome("clio-headless-gateway-skill-");
	t.after(scratch.cleanup);
	const env = {
		...process.env,
		...scratch.env,
		NODE_ENV: "test",
		NO_COLOR: "1",
		CLIO_CODER_TEST_OPENAI_KEY: "fixture-key",
	};
	const initialized = await runCli(["doctor", "--fix"], { env, cwd: scratch.dir });
	strictEqual(initialized.code, 0, initialized.stderr);
	const fixture = await startOpenAICompatFixture("done", {
		toolCall: {
			name: "gateway",
			arguments: { op: "call", capability: "context", args: { scope: "skills", name: requestedName } },
		},
	});
	t.after(() => closeServer(fixture.server));
	seedOpenAICompatToolOrchestrator(join(scratch.dir, "config"), fixture.url, autonomy);
	const skillDir = join(scratch.dir, "skills", name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: Complete gateway skill evidence.\nallowed-tools: read, grep\n---\n\n${body}`,
	);
	const turn = await runCli(
		[
			"--no-context-files",
			"--skill",
			skillDir,
			"run",
			"--autonomy",
			autonomy,
			"--json-events",
			"full",
			"Load the skill workflow.",
		],
		{ env, cwd: scratch.dir },
	);
	strictEqual(turn.code, 0, turn.stderr);
	const events = turn.stdout
		.trim()
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	const ledgers = readdirSync(join(scratch.dir, "state", "sessions"), { recursive: true, encoding: "utf8" }).filter(
		(file) => file.endsWith("current.jsonl"),
	);
	strictEqual(ledgers.length, 1);
	const entries = readFileSync(join(scratch.dir, "state", "sessions", ledgers[0] ?? ""), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	return { events, entries, fixture, skillDir };
}

function textOf(result: unknown): string {
	return ((result as { content?: Array<{ type: string; text?: string }> })?.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

function projectedContext(events: Array<Record<string, unknown>>) {
	const start = events.find((event) => event.type === "tool_execution_start");
	const end = events.find((event) => event.type === "tool_execution_end");
	ok(start && end);
	for (const event of [start, end]) {
		strictEqual(event.toolName, "context");
		strictEqual(event.via, "gateway");
	}
	deepStrictEqual(start.args, { scope: "skills", name: (start.args as { name: string }).name });
	strictEqual(start.toolCallId, end.toolCallId);
	return end;
}

function persistedGateway(entries: Array<Record<string, unknown>>) {
	const call = entries.find((entry) => entry.role === "tool_call")?.payload as
		| { name: string; args: unknown; toolCallId: string }
		| undefined;
	const result = entries.find((entry) => entry.role === "tool_result")?.payload as
		| { toolName: string; toolCallId: string; isError: boolean; result: { details?: Record<string, unknown> } }
		| undefined;
	ok(call && result);
	strictEqual(call.name, "gateway");
	strictEqual(result.toolName, "gateway");
	strictEqual(result.toolCallId, call.toolCallId);
	return { call, result };
}

for (const autonomy of ["yolo", "default"]) {
	test(`headless ${autonomy}: capability display, gateway replay, and complete skill evidence`, {
		timeout: 30000,
	}, async (t) => {
		const { events, entries, fixture, skillDir } = await skillTurn(t, autonomy);
		const end = projectedContext(events);
		strictEqual(end.isError, false);
		ok(
			textOf(end.result).includes(body.trim()),
			"projected activation retains the complete body beyond generic output caps",
		);
		ok(
			events.some((event) => event.type === "notice" && String(event.text).includes(`Skill activated: ${name} (model)`)),
		);
		const { call, result } = persistedGateway(entries);
		deepStrictEqual(call.args, { op: "call", capability: "context", args: { scope: "skills", name } });
		strictEqual(result.isError, false);
		ok(textOf(result.result).includes(body.trim()), "durable wire evidence keeps the complete instructions");
		const details = result.result.details;
		ok(details);
		strictEqual(details.name, name);
		strictEqual(details.path, join(skillDir, "SKILL.md"));
		match(String(details.hash), /^[a-f0-9]{64}$/u);
		strictEqual(details.activation, "model");
		const states = entries.filter((entry) => entry.customType === "skillContextState");
		strictEqual(states.length, 1);
		const state = states[0]?.data as { activationRefs?: string[]; unknown?: boolean };
		strictEqual(state.unknown, undefined);
		strictEqual(state.activationRefs?.length, 1, "selection records durable activation evidence");
		const durableEntries = entries.filter((entry): entry is Record<string, unknown> & SessionEntry =>
			isSessionEntry(entry),
		);
		const captured = captureSkillContext(durableEntries, latestSkillContextState(durableEntries));
		ok(captured);
		strictEqual(captured.skills.length, 1);
		ok(textOf(captured.skills[0]).includes(body.trim()), "verified historical evidence keeps the full instruction body");
		ok(
			fixture.requests.some((request) =>
				(request.messages as Array<{ role: string; content?: string }> | undefined)?.some(
					(message) => message.role === "tool" && message.content?.includes(body.trim()),
				),
			),
			"the provider receives the complete activation body",
		);
		const replay = buildModelReplayAgentMessagesFromTurns(durableEntries);
		const replayResult = replay.find((message) => message.role === "toolResult");
		ok(replayResult && replayResult.role === "toolResult");
		strictEqual(replayResult.toolName, "gateway");
		ok(
			textOf(replayResult).includes(body.trim()),
			`provider replay retains the full skill result (${textOf(replayResult).length} replayed characters)`,
		);
		const altered = structuredClone(durableEntries);
		const alteredResult = altered.find((entry) => entry.kind === "message" && entry.role === "tool_result");
		ok(alteredResult && alteredResult.kind === "message");
		const alteredPayload = alteredResult.payload as { result: { content: Array<{ type: "text"; text: string }> } };
		alteredPayload.result.content[0] = { type: "text", text: `${textOf(result.result)}\nUNVERIFIED_EXTRA` };
		strictEqual(captureSkillContext(altered, latestSkillContextState(altered)), undefined);
		const alteredReplay = buildModelReplayAgentMessagesFromTurns(altered).find(
			(message) => message.role === "toolResult",
		);
		ok(alteredReplay);
		ok(
			!textOf(alteredReplay).includes("FULL_SKILL_END"),
			"altered evidence never gains unbounded replay from skill metadata alone",
		);
	});
}

test("headless gateway skill refusal preserves structured failure in display and durable replay", {
	timeout: 30000,
}, async (t) => {
	const { events, entries } = await skillTurn(t, "yolo", "not-installed-anywhere");
	const end = projectedContext(events);
	strictEqual(end.isError, true);
	const refusal = { subject: "skill", name: "not-installed-anywhere", kind: "unknown" };
	deepStrictEqual((end.result as { details: { refusal: unknown } }).details.refusal, refusal);
	const { result } = persistedGateway(entries);
	strictEqual(result.isError, true);
	deepStrictEqual(result.result.details?.refusal, refusal);
	ok(!textOf(result.result).includes("FULL_SKILL_START"));
	ok(!events.some((event) => event.type === "notice" && String(event.text).includes("Skill activated:")));
});
