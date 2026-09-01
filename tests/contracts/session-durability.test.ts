import { ok, strictEqual, throws } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { recoverOrphanReceipts } from "../../src/domains/dispatch/orphan-recovery.js";
import { readRunEventJournal } from "../../src/domains/dispatch/run-event-journal.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import { appendTurn, persistSessionMeta, resumeSessionState, startSession } from "../../src/domains/session/manager.js";
import {
	reconcilePendingProtectedArtifacts,
	stagePendingProtectedArtifact,
} from "../../src/domains/session/protected-artifact-journal.js";
import {
	createSession,
	readSessionFileEntries,
	readSessionMeta,
	resumeSession,
	sessionPaths,
} from "../../src/engine/session.js";
import { runTailEntryFromEvent } from "../../src/tools/dispatch-run-events.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("session durability boundary", () => {
	let scratch: IsolatedClioEnv;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-session-contract-");
	});

	afterEach(() => scratch.restore());

	it("makes atomic appends immediately visible and recovers a torn tail on reopen", () => {
		const { meta, writer } = createSession({ cwd: scratch.dir });
		writer.append({
			id: "t1",
			parentId: null,
			at: "2026-06-11T00:00:00.000Z",
			kind: "user",
			payload: { text: "before crash" },
		});
		const path = sessionPaths(meta).current;
		strictEqual(readSessionFileEntries(path).length, 2);
		writeFileSync(path, `${readFileSync(path, "utf8")}{"kind":"mess`, "utf8");

		const resumed = resumeSession(meta.id);
		resumed.writer.append({
			id: "t2",
			parentId: "t1",
			at: "2026-06-11T00:00:01.000Z",
			kind: "user",
			payload: { text: "after crash" },
		});
		const warnings: string[] = [];
		const entries = readSessionFileEntries(path, { onWarning: (warning) => warnings.push(warning.message) });
		strictEqual(warnings.length, 1);
		strictEqual((entries[1] as { turnId?: string }).turnId, "t1");
		strictEqual((entries[2] as { turnId?: string }).turnId, "t2");
	});

	it("normalizes released event ids while leaving session and journal history unchanged", () => {
		const sessionPath = join(scratch.dir, "legacy-session.jsonl");
		const sessionLine = '{"type":"event","event":{"type":"clio_tool_start","payload":{"tool":"read"}}}\n';
		writeFileSync(sessionPath, sessionLine, "utf8");
		const [sessionEntry] = readSessionFileEntries(sessionPath) as Array<{ event?: { type?: string } }>;
		strictEqual(sessionEntry?.event?.type, "clio_coder_tool_start");
		strictEqual(readFileSync(sessionPath, "utf8"), sessionLine);

		const journalRoot = join(scratch.dir, "runs");
		const journalDir = join(journalRoot, "legacy-run");
		mkdirSync(journalDir, { recursive: true });
		const journalLine =
			'{"seq":1,"at":"2026-09-01T00:00:00.000Z","kind":"event","type":"clio_tool_finish","detail":"read ok"}\n';
		writeFileSync(join(journalDir, "events.ndjson"), journalLine, "utf8");
		const journal = readRunEventJournal("legacy-run", { root: journalRoot });
		strictEqual(journal.lines[0]?.kind, "event");
		strictEqual(journal.lines[0]?.kind === "event" ? journal.lines[0].type : null, "clio_coder_tool_finish");
		strictEqual(readFileSync(join(journalDir, "events.ndjson"), "utf8"), journalLine);
		strictEqual(
			runTailEntryFromEvent({ type: "clio_tool_finish", payload: { tool: "read", outcome: "ok" } })?.type,
			"clio_coder_tool_finish",
		);
	});

	it("writes canonical session provenance and normalizes released metadata only in memory", async () => {
		const { meta, writer } = createSession({ cwd: scratch.dir });
		const metaPath = sessionPaths(meta).meta;
		await writer.close();
		const canonical = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
		strictEqual(typeof canonical.clioCoderVersion, "string");
		strictEqual("clioVersion" in canonical, false);
		const legacy = { ...canonical, clioVersion: canonical.clioCoderVersion };
		Reflect.deleteProperty(legacy, "clioCoderVersion");
		writeFileSync(metaPath, JSON.stringify(legacy, null, 2), "utf8");
		const before = readFileSync(metaPath, "utf8");
		const normalized = readSessionMeta(meta.id);
		strictEqual(normalized.clioCoderVersion, legacy.clioVersion);
		strictEqual("clioVersion" in (normalized as unknown as Record<string, unknown>), false);
		strictEqual(readFileSync(metaPath, "utf8"), before);
	});

	it("writes canonical protected-artifact seals and accepts a released seal without rewriting it", () => {
		const handle = stagePendingProtectedArtifact("legacy-protection-session", {
			kind: "protect",
			artifact: {
				path: join(scratch.dir, "REPORT.md"),
				protectedAt: "2026-09-01T00:00:00.000Z",
				reason: "verified",
				source: "validation",
				validationCommand: "npm test",
				validationExitCode: 0,
			},
			toolName: "verify",
			turnId: "turn-1",
		});
		const record = JSON.parse(readFileSync(handle.path, "utf8")) as typeof handle.record;
		const payload = (contract: string) => ({
			contract,
			version: record.version,
			id: record.id,
			sessionId: record.sessionId,
			artifact: {
				path: record.artifact.path,
				protectedAt: record.artifact.protectedAt,
				reason: record.artifact.reason,
				source: record.artifact.source,
				validationCommand: record.artifact.validationCommand,
				validationExitCode: record.artifact.validationExitCode,
			},
			context: {
				parentTurnId: record.context.parentTurnId,
				toolName: record.context.toolName,
			},
			createdAt: record.createdAt,
		});
		const digest = (contract: string): string =>
			createHash("sha256")
				.update(JSON.stringify(payload(contract)), "utf8")
				.digest("hex");
		strictEqual(record.integrity.digest, digest("clio-coder.protectedArtifact.pending"));
		record.integrity.digest = digest("clio.protectedArtifact.pending");
		writeFileSync(handle.path, JSON.stringify(record, null, 2), "utf8");

		let appended = 0;
		const reconciled = reconcilePendingProtectedArtifacts({
			current: () => ({ id: record.sessionId }),
			appendEntry: () => {
				appended += 1;
				return {};
			},
			flushAppends: () => {},
		} as never);
		strictEqual(reconciled, 1);
		strictEqual(appended, 1);
		strictEqual(existsSync(handle.path), false);
	});

	it("persists a selected branch across close and resumes appends from that leaf", async () => {
		const first = startSession({ cwd: scratch.dir });
		const u1 = appendTurn(first, { id: "u1", parentId: null, kind: "user", payload: { text: "u1" } });
		const a1 = appendTurn(first, { id: "a1", parentId: u1.id, kind: "assistant", payload: { text: "a1" } });
		appendTurn(first, { id: "u2", parentId: a1.id, kind: "user", payload: { text: "abandoned" } });
		first.meta.pinnedLeafTurnId = a1.id;
		persistSessionMeta(first);
		await first.writer.close();

		const reopened = resumeSessionState(first.meta.id).state;
		strictEqual(reopened.meta.pinnedLeafTurnId, a1.id);
		const alternate = appendTurn(reopened, {
			id: "u3",
			parentId: a1.id,
			kind: "user",
			payload: { text: "alternate" },
		});
		strictEqual(alternate.parentId, a1.id);
		await reopened.writer.close();
	});

	it("keeps the current session open when a resume target cannot be opened", async () => {
		const current = startSession({ cwd: scratch.dir });
		appendTurn(current, { id: "current", parentId: null, kind: "user", payload: { text: "current" } });
		const broken = startSession({ cwd: scratch.dir });
		await broken.writer.close();
		const brokenMeta = sessionPaths(broken.meta).meta;
		const document = JSON.parse(readFileSync(brokenMeta, "utf8")) as Record<string, unknown>;
		document.sessionFormatVersion = 2;
		writeFileSync(brokenMeta, JSON.stringify(document));

		throws(() => resumeSessionState(broken.meta.id), /unsupported format version/u);
		appendTurn(current, {
			id: "still-current",
			parentId: "current",
			kind: "user",
			payload: { text: "still writable" },
		});
		const entries = readSessionFileEntries(sessionPaths(current.meta).current);
		strictEqual((entries.at(-1) as { turnId?: string }).turnId, "still-current");
		strictEqual(current.meta.endedAt, null);
		await current.writer.close();
	});

	it("closes an abandoned run deterministically during restart recovery", async () => {
		const ledger = openLedger({ maxRuns: 10 });
		const run = ledger.create({
			agentId: "coder",
			executionRole: "builder",
			task: "interrupted work",
			targetId: "local",
			wireModelId: "model",
			runtimeId: "openai",
			runtimeKind: "http",
			sessionId: null,
			cwd: scratch.dir,
		});
		ledger.update(run.id, { status: "running", pid: 999_999, heartbeatAt: run.startedAt });
		await ledger.persist();

		const reopened = openLedger({ maxRuns: 10 });
		const recovered = recoverOrphanReceipts(reopened);
		strictEqual(recovered.abandoned, 1);
		strictEqual(reopened.get(run.id)?.status, "dead");
		strictEqual(reopened.get(run.id)?.outcome, "stalled");
		ok(reopened.get(run.id)?.endedAt !== null);
	});
});
