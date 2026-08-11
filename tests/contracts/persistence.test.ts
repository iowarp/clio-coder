import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { isSkillActivation } from "../../src/core/skill-activation.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import { isSessionEntry, isSessionHeader, type SkillActivationEntry } from "../../src/domains/session/entries.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import {
	appendPromptCompileRecord,
	getPromptManifestFilePath,
	readPromptCompileRecords,
} from "../../src/domains/session/prompt-manifest.js";
import {
	type ClioTurnRecord,
	createSession,
	openSession,
	readSessionFileEntries,
	resumeSession,
	sessionPaths,
	writeJsonlFileAtomic,
} from "../../src/engine/session.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

const ORIGINAL_ENV = { ...process.env };

function stubContext(): DomainContext {
	return {
		bus: { emit: () => {}, on: () => () => {} } as unknown as DomainContext["bus"],
		getContract: () => undefined,
	};
}

function payloadText(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const text = (payload as Record<string, unknown>).text;
	return typeof text === "string" ? text : undefined;
}

describe("contracts/persistence", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = newScratchClioHome("clio-persistence-");
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		clearScratchClioHome(scratch);
	});

	it("creates, retrieves, and persists ledger runs and receipts", async () => {
		const ledger = openLedger({ maxRuns: 10 });
		const env = ledger.create({
			agentId: "coder",
			executionRole: "builder",
			task: "persistence task",
			targetId: "anthropic-default",
			wireModelId: "claude-sonnet-4-6",
			runtimeId: "anthropic",
			runtimeKind: "http" as const,
			sessionId: null,
			cwd: process.cwd(),
		});

		ok(env.id.length > 0);
		strictEqual(env.status, "queued");

		const got = ledger.get(env.id);
		strictEqual(got?.id, env.id);

		// Persist runs.json
		await ledger.persist();
		const reopened = openLedger();
		strictEqual(reopened.get(env.id)?.task, "persistence task");

		// Record a receipt
		ledger.update(env.id, {
			status: "completed",
			endedAt: "2026-04-24T00:00:01.000Z",
			exitCode: 0,
			tokenCount: 0,
			costUsd: 0,
		});

		const receipt = ledger.recordReceipt(env.id, {
			verification: { state: "unverified", basis: "no-validation-tool" },
			routingIntent: {
				posture: "balanced",
				maxCostUsd: null,
				deadlineMs: null,
				minimumQuality: null,
				requiredCapabilities: [],
				locality: "any",
				failover: "none",
			},
			quality: {
				version: 1,
				typedValidations: [],
				responseSchema: { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null },
				resultContract: null,
			},
			costProvenance: "unknown",
			outcome: "succeeded",
			runId: env.id,
			agentId: "coder",
			executionRole: "builder",
			task: "persistence task",
			targetId: "anthropic-default",
			wireModelId: "claude-sonnet-4-6",
			runtimeId: "anthropic",
			runtimeKind: "http" as const,
			startedAt: env.startedAt,
			endedAt: "2026-04-24T00:00:01.000Z",
			exitCode: 0,
			tokenCount: 0,
			costUsd: 0,
			compiledPromptHash: null,
			staticCompositionHash: null,
			clioVersion: "0.0.0",
			piMonoVersion: "0.0.0",
			platform: process.platform,
			nodeVersion: process.version,
			toolCalls: 0,
			toolStats: [],
			sessionId: null,
		});

		const receiptPath = join(scratch, "state", "receipts", `${env.id}.json`);
		ok(existsSync(receiptPath));
		const written = JSON.parse(readFileSync(receiptPath, "utf8")) as typeof receipt;
		strictEqual(written.integrity.digest, receipt.integrity.digest);
	});

	it("validates session headers and entry serialization", () => {
		const header = {
			type: "session",
			version: 2,
			id: "sess-1",
			timestamp: "2026-04-17T00:00:00.000Z",
			cwd: "/tmp/project",
		};
		strictEqual(isSessionHeader(header), true);
		strictEqual(isSessionHeader({ type: "invalid" }), false);

		const messageEntry = {
			kind: "message",
			turnId: "t1",
			parentTurnId: null,
			timestamp: "2026-04-17T00:00:00.000Z",
			role: "user",
			payload: { text: "hello" },
		};
		strictEqual(isSessionEntry(messageEntry), true);
		strictEqual(isSessionEntry({ kind: "invalid" }), false);
	});

	it("persists ordinary turns as structured messages while preserving tree continuity", () => {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;
		const meta = contract.create({ cwd: scratch });
		const userTurn = contract.append({ parentId: null, kind: "user", payload: { text: "question" } });
		const assistantTurn = contract.append({
			parentId: userTurn.id,
			kind: "assistant",
			payload: { text: "answer" },
		});

		const reader = openSession(meta.id);
		const entries = reader.turns();
		strictEqual(entries.length, 2);
		ok(entries.every(isSessionEntry));
		deepStrictEqual(entries, [
			{
				kind: "message",
				turnId: userTurn.id,
				parentTurnId: null,
				timestamp: userTurn.at,
				role: "user",
				payload: { text: "question" },
			},
			{
				kind: "message",
				turnId: assistantTurn.id,
				parentTurnId: userTurn.id,
				timestamp: assistantTurn.at,
				role: "assistant",
				payload: { text: "answer" },
			},
		]);
		deepStrictEqual(reader.tree(), [
			{ id: userTurn.id, parentId: null, at: userTurn.at, kind: "user" },
			{ id: assistantTurn.id, parentId: userTurn.id, at: assistantTurn.at, kind: "assistant" },
		]);
	});

	it("persists skill activation entries and session metadata", () => {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;
		const meta = contract.create({ cwd: scratch });
		const userTurn = contract.append({ parentId: null, kind: "user", payload: { text: "use a skill" } });

		contract.recordSkillActivation({
			name: "review-tests",
			filePath: join(scratch, ".clio", "skills", "review-tests", "SKILL.md"),
			hash: "a".repeat(64),
			source: "clio",
			triggeredBy: "slash-command",
			turnId: userTurn.id,
		});

		const reader = openSession(meta.id);
		const entries = reader.turns();
		const activationEntry = entries.find(
			(entry): entry is SkillActivationEntry => isSessionEntry(entry) && entry.kind === "skillActivation",
		);
		ok(activationEntry);
		strictEqual(activationEntry.activation.name, "review-tests");
		strictEqual(activationEntry.activation.turnId, userTurn.id);
		const persistedMeta = reader.meta() as { skillActivations?: Array<{ name: string; turnId?: string }> };
		strictEqual(persistedMeta.skillActivations?.[0]?.name, "review-tests");
		strictEqual(persistedMeta.skillActivations?.[0]?.turnId, userTurn.id);
	});

	it("persists worker skill activations folded in with a runId tag", () => {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;
		const meta = contract.create({ cwd: scratch });

		// Dispatch-completion fold: the orchestrator appends the worker
		// receipt's activation with the runId set; entry and meta must both
		// carry it so /view can attribute worker skill provenance.
		contract.recordSkillActivation({
			name: "verify-suite",
			filePath: join(scratch, ".clio", "skills", "verify-suite", "SKILL.md"),
			hash: "b".repeat(64),
			source: "clio",
			triggeredBy: "tool",
			runId: "run-worker-1",
		});

		const reader = openSession(meta.id);
		const activationEntry = reader
			.turns()
			.find((entry): entry is SkillActivationEntry => isSessionEntry(entry) && entry.kind === "skillActivation");
		ok(activationEntry);
		strictEqual((activationEntry.activation as { runId?: string }).runId, "run-worker-1");
		const persistedMeta = reader.meta() as { skillActivations?: Array<{ runId?: string }> };
		strictEqual(persistedMeta.skillActivations?.[0]?.runId, "run-worker-1");

		// The runtime validator tolerates both shapes: main-agent activations
		// without runId and folded worker activations with one.
		strictEqual(isSkillActivation(activationEntry.activation), true);
		const { runId: _runId, ...withoutRunId } = activationEntry.activation;
		strictEqual(isSkillActivation(withoutRunId), true);
		strictEqual(isSkillActivation({ ...activationEntry.activation, runId: 7 }), false);
	});

	it("persists prompt-compile manifest records as a session sibling artifact", () => {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;
		const meta = contract.create({ cwd: scratch });

		const record = {
			at: "2026-07-03T00:00:00.000Z",
			previousHash: null,
			systemPromptHash: "b".repeat(64),
			tokenEstimate: 1234,
			thinkingLevel: "off",
			projectPreload: null,
			sections: [
				{ id: "identity", tokenEstimate: 200 },
				{ id: "operating-contract", tokenEstimate: 900 },
			],
			fragments: [{ id: "identity.clio", relPath: "identity/clio.md", contentHash: "c".repeat(64), dynamic: false }],
		};
		appendPromptCompileRecord(meta, record);
		appendPromptCompileRecord(meta, {
			...record,
			at: "2026-07-03T00:05:00.000Z",
			previousHash: record.systemPromptHash,
			systemPromptHash: "d".repeat(64),
			thinkingLevel: "low",
		});

		const manifestPath = getPromptManifestFilePath(meta);
		strictEqual(manifestPath, join(dirname(sessionPaths(meta).current), "prompt-manifest.jsonl"));
		ok(existsSync(manifestPath));

		const records = readPromptCompileRecords(meta);
		strictEqual(records.length, 2);
		strictEqual(records[0]?.systemPromptHash, "b".repeat(64));
		strictEqual(records[0]?.previousHash, null);
		strictEqual(records[0]?.thinkingLevel, "off");
		deepStrictEqual(records[0]?.sections, record.sections);
		deepStrictEqual(records[0]?.fragments, record.fragments);
		strictEqual(records[1]?.previousHash, "b".repeat(64));
		strictEqual(records[1]?.systemPromptHash, "d".repeat(64));
		strictEqual(records[1]?.thinkingLevel, "low");

		// A torn trailing line must not break provenance reads.
		writeFileSync(manifestPath, `${readFileSync(manifestPath, "utf8")}{"truncated`, "utf8");
		strictEqual(readPromptCompileRecords(meta).length, 2);
	});

	it("fd-appends turns without close and they are immediately readable", () => {
		const { meta, writer } = createSession({ cwd: scratch });
		const turn = (id: string, parentId: string | null, text: string): ClioTurnRecord => ({
			id,
			parentId,
			at: "2026-06-11T00:00:00.000Z",
			kind: "user",
			payload: { text },
		});
		writer.append(turn("t1", null, "one"));
		writer.append(turn("t2", "t1", "two"));

		const entries = readSessionFileEntries(sessionPaths(meta).current);
		strictEqual(entries.length, 3);
		strictEqual((entries[0] as { type?: string }).type, "session");
		strictEqual((entries[1] as { turnId?: string }).turnId, "t1");
		strictEqual((entries[2] as { turnId?: string }).turnId, "t2");
	});

	it("terminates a torn tail on resume so appends never fuse onto the fragment", () => {
		const { meta, writer } = createSession({ cwd: scratch });
		writer.append({
			id: "t1",
			parentId: null,
			at: "2026-06-11T00:00:00.000Z",
			kind: "user",
			payload: { text: "before crash" },
		});
		const current = sessionPaths(meta).current;
		// Simulate a crash mid-append: a partial line with no trailing newline.
		writeFileSync(current, `${readFileSync(current, "utf8")}{"kind":"mess`, "utf8");

		const resumed = resumeSession(meta.id);
		resumed.writer.append({
			id: "t2",
			parentId: "t1",
			at: "2026-06-11T00:00:01.000Z",
			kind: "user",
			payload: { text: "after crash" },
		});

		const warnings: string[] = [];
		const entries = readSessionFileEntries(current, { onWarning: (w) => warnings.push(w.message) });
		strictEqual(warnings.length, 1);
		ok(warnings[0]?.startsWith("invalid JSON skipped"));
		strictEqual(entries.length, 3);
		strictEqual((entries[1] as { turnId?: string }).turnId, "t1");
		strictEqual((entries[2] as { turnId?: string }).turnId, "t2");
	});

	it("appends an off-current label without rewriting away a torn transcript tail", () => {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;
		const first = contract.create({ cwd: scratch });
		const turn = contract.append({ parentId: null, kind: "user", payload: { text: "label me" } });
		contract.create({ cwd: scratch });
		const current = sessionPaths(first).current;
		appendFileSync(current, '{"kind":"message"', "utf8");

		contract.editLabel(turn.id, "checkpoint", first.id);

		const warnings: string[] = [];
		const entries = readSessionFileEntries(current, { onWarning: (warning) => warnings.push(warning.message) });
		strictEqual(warnings.length, 1, "the pre-existing torn record remains observable instead of being dropped");
		ok(warnings[0]?.startsWith("invalid JSON skipped"));
		ok(
			entries.some(
				(entry) =>
					isSessionEntry(entry) && entry.kind === "label" && entry.targetTurnId === turn.id && entry.label === "checkpoint",
			),
		);
	});

	it("reopens the append fd after replaceEntries so later appends land in the new file", () => {
		const { meta, writer } = createSession({ cwd: scratch });
		const turn = (id: string, text: string): ClioTurnRecord => ({
			id,
			parentId: null,
			at: "2026-06-11T00:00:00.000Z",
			kind: "user",
			payload: { text },
		});
		writer.append(turn("t1", "original"));
		writer.replaceEntries([
			{
				kind: "message",
				turnId: "r1",
				parentTurnId: null,
				timestamp: "2026-06-11T00:00:00.000Z",
				role: "user",
				payload: { text: "rewritten" },
			},
		]);
		writer.append(turn("t2", "post-replace"));

		const entries = readSessionFileEntries(sessionPaths(meta).current);
		strictEqual(entries.length, 3);
		strictEqual((entries[0] as { type?: string }).type, "session");
		strictEqual((entries[1] as { turnId?: string }).turnId, "r1");
		strictEqual((entries[2] as { turnId?: string }).turnId, "t2");
	});

	it("handles atomic JSONL file writes and skips corrupt trailing lines", () => {
		const path = join(scratch, "session.jsonl");
		writeJsonlFileAtomic(path, [{ type: "session", version: 2 }]);

		ok(existsSync(path));
		const records = readSessionFileEntries(path);
		deepStrictEqual(records, [{ type: "session", version: 2 }]);

		// Append corruption
		writeFileSync(path, `${readFileSync(path, "utf8")}{corrupt\n`, "utf8");
		const recovered = readSessionFileEntries(path, { onWarning: () => {} });
		deepStrictEqual(recovered, [{ type: "session", version: 2 }]);
	});

	it("supports session fork and path-history resume primitives", () => {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;

		contract.create({ cwd: scratch });
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "first question" } });
		const a1 = contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "first reply" } });
		contract.append({ parentId: a1.id, kind: "user", payload: { text: "alternative branch" } });

		// Fork the session at the first assistant response
		const forkedMeta = contract.fork(a1.id);
		const reader = openSession(forkedMeta.id);

		// Verified child session has parent pointer and pre-fork history
		const header = reader.header();
		ok(header);
		strictEqual(header.parentTurnId, a1.id);

		const turns = reader.turns();
		strictEqual(turns.length, 2);
		const first = turns[0];
		const second = turns[1];
		ok(isSessionEntry(first));
		ok(isSessionEntry(second));
		strictEqual(first.kind, "message");
		strictEqual(second.kind, "message");
		if (first.kind === "message") strictEqual(payloadText(first.payload), "first question");
		if (second.kind === "message") strictEqual(payloadText(second.payload), "first reply");
	});

	it("switches the current append point to a selected turn", () => {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;

		contract.create({ cwd: scratch });
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "first question" } });
		const a1 = contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "first reply" } });
		const u2 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "latest branch" } });

		strictEqual(contract.tree().leafId, u2.id);

		contract.switchTurn(a1.id);
		strictEqual(contract.tree().leafId, a1.id);

		const parentId = contract.tree().leafId;
		const u3 = contract.append({ parentId, kind: "user", payload: { text: "alternate branch" } });
		strictEqual(u3.parentId, a1.id);
		strictEqual(contract.tree().leafId, u3.id);
	});
});
