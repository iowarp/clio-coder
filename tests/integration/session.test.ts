import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import {
	fromLegacyTurn,
	isSessionEntry,
	isSessionHeader,
	SESSION_ENTRY_KINDS,
	type SessionEntry,
	type TaskLedgerEntry,
} from "../../src/domains/session/entries.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import type { SessionContract, SessionMeta } from "../../src/domains/session/index.js";
import { CURRENT_SESSION_FORMAT_VERSION, runMigrations } from "../../src/domains/session/migrations/index.js";
import { migrateV1ToV2 } from "../../src/domains/session/migrations/v1-to-v2.js";
import { protectedArtifactStateFromSessionEntries } from "../../src/domains/session/protected-artifacts.js";
import { resolveLabelMap } from "../../src/domains/session/tree/manager.js";
import { buildTreeSnapshot, computeLeafId } from "../../src/domains/session/tree/navigator.js";
import {
	type ClioTurnRecord,
	openSession,
	readSessionFileEntries,
	type SessionTreeNode,
	sessionPaths,
	writeJsonlFileAtomic,
} from "../../src/engine/session.js";

function buildMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
	return {
		id: "00000000-0000-7000-8000-000000000000",
		cwd: "/tmp/clio-test",
		cwdHash: "abc123",
		createdAt: "2026-04-17T00:00:00.000Z",
		endedAt: null,
		model: null,
		endpoint: null,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.1.0-exp",
		piMonoVersion: "0.68.1",
		platform: "linux",
		nodeVersion: "v20.0.0",
		...overrides,
	};
}

describe("session/entries union", () => {
	it("SESSION_ENTRY_KINDS matches the canonical list", () => {
		deepStrictEqual(
			[...SESSION_ENTRY_KINDS],
			[
				"message",
				"bashExecution",
				"custom",
				"modelChange",
				"thinkingLevelChange",
				"fileEntry",
				"branchSummary",
				"compactionSummary",
				"sessionInfo",
				"label",
				"protectedArtifact",
				"taskLedger",
			],
		);
	});

	function validEntry(kind: (typeof SESSION_ENTRY_KINDS)[number]): SessionEntry {
		const base = {
			turnId: `t-${kind}`,
			parentTurnId: null,
			timestamp: "2026-04-17T00:00:00.000Z",
		};
		switch (kind) {
			case "message":
				return { ...base, kind, role: "user", payload: { text: "hi" } };
			case "bashExecution":
				return { ...base, kind, command: "npm test", output: "ok", exitCode: 0, cancelled: false, truncated: false };
			case "custom":
				return { ...base, kind, customType: "fixture", data: { ok: true } };
			case "modelChange":
				return { ...base, kind, provider: "local", modelId: "mini" };
			case "thinkingLevelChange":
				return { ...base, kind, thinkingLevel: "high" };
			case "fileEntry":
				return { ...base, kind, path: "README.md", operation: "read" };
			case "branchSummary":
				return { ...base, kind, fromTurnId: "t-parent", summary: "branched" };
			case "compactionSummary":
				return { ...base, kind, summary: "summary", tokensBefore: 10, firstKeptTurnId: "t-1" };
			case "sessionInfo":
				return { ...base, kind, name: "fixture" };
			case "label":
				return { ...base, kind, targetTurnId: "t-1", label: "pin" };
			case "protectedArtifact":
				return {
					...base,
					kind,
					action: "protect",
					artifact: {
						path: "README.md",
						protectedAt: "2026-04-17T00:00:00.000Z",
						reason: "validated",
						source: "validation",
					},
				};
			case "taskLedger":
				return {
					...base,
					kind,
					goals: [{ id: "g1", title: "goal", status: "active" }],
					subgoals: [{ id: "sg1", title: "subgoal", status: "pending", parentGoalId: "g1" }],
					activeRunIds: ["run-1"],
					requiredValidationEvidence: [{ id: "ev1", description: "npm test", status: "required" }],
				};
		}
	}

	it("isSessionEntry accepts a well-formed MessageEntry", () => {
		const entry: SessionEntry = {
			kind: "message",
			turnId: "t1",
			parentTurnId: null,
			timestamp: "2026-04-17T00:00:00.000Z",
			role: "user",
			payload: { text: "hi" },
		};
		strictEqual(isSessionEntry(entry), true);
	});

	it("isSessionEntry accepts each kind in SESSION_ENTRY_KINDS", () => {
		for (const kind of SESSION_ENTRY_KINDS) {
			strictEqual(isSessionEntry(validEntry(kind)), true, `kind ${kind} should be recognized`);
		}
	});

	it("isSessionEntry rejects a legacy ClioTurnRecord shape", () => {
		const legacy: ClioTurnRecord = {
			id: "legacy-1",
			parentId: null,
			at: "2026-04-17T00:00:00.000Z",
			kind: "user",
			payload: { text: "legacy" },
		};
		strictEqual(isSessionEntry(legacy), false);
	});

	it("isSessionEntry rejects unknown kinds and missing fields", () => {
		strictEqual(isSessionEntry({ kind: "bogus", turnId: "x" }), false);
		strictEqual(isSessionEntry({ kind: "message" }), false);
		strictEqual(
			isSessionEntry({ kind: "message", turnId: "x", parentTurnId: null, timestamp: "now", role: "user" }),
			false,
		);
		strictEqual(isSessionEntry({ kind: "bashExecution", turnId: "x", parentTurnId: null, timestamp: "now" }), false);
		strictEqual(isSessionEntry(null), false);
		strictEqual(isSessionEntry("string"), false);
	});

	it("isSessionHeader accepts the standard JSONL header shape", () => {
		strictEqual(
			isSessionHeader({
				type: "session",
				version: 2,
				id: "s1",
				timestamp: "2026-04-17T00:00:00.000Z",
				cwd: "/tmp/project",
				parentSession: "/tmp/parent/current.jsonl",
				parentTurnId: "t1",
			}),
			true,
		);
		strictEqual(isSessionHeader({ type: "session", id: "s1" }), false);
		strictEqual(
			isSessionHeader({
				type: "session",
				version: 2.5,
				id: "s1",
				timestamp: "2026-04-17T00:00:00.000Z",
				cwd: "/tmp/project",
			}),
			false,
		);
	});

	it("fromLegacyTurn maps id/at/kind to turnId/timestamp/role", () => {
		const legacy: ClioTurnRecord = {
			id: "legacy-42",
			parentId: "parent-1",
			at: "2026-04-17T03:14:15.000Z",
			kind: "assistant",
			payload: { text: "pong" },
		};
		const entry = fromLegacyTurn(legacy);
		strictEqual(entry.kind, "message");
		strictEqual(entry.turnId, "legacy-42");
		strictEqual(entry.parentTurnId, "parent-1");
		strictEqual(entry.timestamp, "2026-04-17T03:14:15.000Z");
		strictEqual(entry.role, "assistant");
		deepStrictEqual(entry.payload, { text: "pong" });
	});

	it("fromLegacyTurn preserves optional dynamicInputs / renderedPromptHash", () => {
		const legacy: ClioTurnRecord = {
			id: "legacy-99",
			parentId: null,
			at: "2026-04-17T00:00:00.000Z",
			kind: "user",
			payload: { text: "hi" },
			dynamicInputs: { cwd: "/tmp" },
			renderedPromptHash: "deadbeef",
		};
		const entry = fromLegacyTurn(legacy);
		deepStrictEqual(entry.dynamicInputs, { cwd: "/tmp" });
		strictEqual(entry.renderedPromptHash, "deadbeef");
	});

	it("rehydrates protected artifact state from session entries deterministically", () => {
		const entries: SessionEntry[] = [
			{
				kind: "message",
				turnId: "m1",
				parentTurnId: null,
				timestamp: "2026-04-17T00:00:00.000Z",
				role: "user",
				payload: { text: "validate" },
			},
			{
				kind: "protectedArtifact",
				turnId: "p2",
				parentTurnId: "m1",
				timestamp: "2026-04-17T00:00:02.000Z",
				action: "protect",
				artifact: {
					path: "b.txt",
					protectedAt: "2026-04-17T00:00:02.000Z",
					reason: "older duplicate",
					source: "middleware",
				},
			},
			{
				kind: "protectedArtifact",
				turnId: "p1",
				parentTurnId: "m1",
				timestamp: "2026-04-17T00:00:01.000Z",
				action: "protect",
				artifact: {
					path: "a.txt",
					protectedAt: "2026-04-17T00:00:01.000Z",
					reason: "validated",
					validationCommand: "npm test",
					validationExitCode: 0,
					source: "middleware",
				},
			},
			{
				kind: "protectedArtifact",
				turnId: "p3",
				parentTurnId: "m1",
				timestamp: "2026-04-17T00:00:03.000Z",
				action: "protect",
				artifact: {
					path: "b.txt",
					protectedAt: "2026-04-17T00:00:03.000Z",
					reason: "newer duplicate",
					source: "session",
				},
			},
		];

		const state = protectedArtifactStateFromSessionEntries(entries);

		deepStrictEqual(
			state.artifacts.map((artifact) => [artifact.path, artifact.reason, artifact.source]),
			[
				["a.txt", "validated", "middleware"],
				["b.txt", "newer duplicate", "session"],
			],
		);
		strictEqual(state.artifacts[0]?.validationCommand, "npm test");
		strictEqual(state.artifacts[0]?.validationExitCode, 0);
	});
});

describe("session/migrations", () => {
	it("CURRENT_SESSION_FORMAT_VERSION is 2", () => {
		strictEqual(CURRENT_SESSION_FORMAT_VERSION, 2);
	});

	it("runMigrations is a no-op on v2 meta", () => {
		const meta = buildMeta({ sessionFormatVersion: 2 });
		const result = runMigrations(meta);
		strictEqual(result.migrated, false);
		strictEqual(result.from, 2);
		strictEqual(result.to, 2);
		strictEqual(meta.sessionFormatVersion, 2);
	});

	it("runMigrations upgrades v1 (missing version) to v2", () => {
		const meta = buildMeta();
		strictEqual(meta.sessionFormatVersion, undefined);
		const result = runMigrations(meta);
		strictEqual(result.migrated, true);
		strictEqual(result.from, 1);
		strictEqual(result.to, 2);
		strictEqual(meta.sessionFormatVersion, 2);
	});

	it("runMigrations is idempotent across multiple calls", () => {
		const meta = buildMeta();
		runMigrations(meta);
		const second = runMigrations(meta);
		strictEqual(second.migrated, false);
		strictEqual(meta.sessionFormatVersion, 2);
	});

	it("migrateV1ToV2 is a no-op when meta already reports v2", () => {
		const meta = buildMeta({ sessionFormatVersion: 2 });
		migrateV1ToV2(meta);
		strictEqual(meta.sessionFormatVersion, 2);
	});

	it("migrateV1ToV2 accepts explicit v1 marker", () => {
		const meta = buildMeta({ sessionFormatVersion: 1 });
		migrateV1ToV2(meta);
		strictEqual(meta.sessionFormatVersion, 2);
	});
});

// ---------------------------------------------------------------------------
// tree / fork / branch-switch (slice 12b-1)
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };

function stubContext(): DomainContext {
	return {
		bus: { emit: () => {}, on: () => () => {} } as unknown as DomainContext["bus"],
		getContract: () => undefined,
	};
}

function fakeTreeNodes(count: number, startAt = "2026-04-17T00:00:00.000Z"): SessionTreeNode[] {
	const base = Date.parse(startAt);
	const nodes: SessionTreeNode[] = [];
	let prev: string | null = null;
	for (let i = 0; i < count; i++) {
		const id = `n${i}`;
		nodes.push({
			id,
			parentId: prev,
			at: new Date(base + i * 1000).toISOString(),
			kind: i % 2 === 0 ? "user" : "assistant",
		});
		prev = id;
	}
	return nodes;
}

describe("session/tree navigator (pure)", () => {
	it("computeLeafId returns null for an empty tree", () => {
		strictEqual(computeLeafId([]), null);
	});

	it("computeLeafId returns the only childless node on a linear chain", () => {
		const nodes = fakeTreeNodes(3);
		strictEqual(computeLeafId(nodes), "n2");
	});

	it("computeLeafId picks the most-recent leaf when multiple branches exist", () => {
		const nodes: SessionTreeNode[] = [
			{ id: "root", parentId: null, at: "2026-04-17T00:00:00.000Z", kind: "user" },
			{ id: "a", parentId: "root", at: "2026-04-17T00:00:01.000Z", kind: "assistant" },
			{ id: "b", parentId: "root", at: "2026-04-17T00:00:02.000Z", kind: "assistant" },
		];
		strictEqual(computeLeafId(nodes), "b");
	});

	it("buildTreeSnapshot returns expected shape with labels + leafId", () => {
		const nodes = fakeTreeNodes(2);
		const labels = new Map([["n0", { label: "pin", timestamp: "2026-04-17T00:00:05.000Z" }]]);
		const snap = buildTreeSnapshot({
			meta: buildMeta({ id: "sess-1" }),
			nodes,
			labels,
		});
		strictEqual(snap.sessionId, "sess-1");
		strictEqual(snap.leafId, "n1");
		deepStrictEqual(snap.rootIds, ["n0"]);
		strictEqual(snap.nodesById.n0?.label, "pin");
		strictEqual(snap.nodesById.n1?.label, undefined);
		deepStrictEqual(snap.nodesById.n0?.children, ["n1"]);
		deepStrictEqual(snap.nodesById.n1?.children, []);
	});

	it("buildTreeSnapshot orders siblings by timestamp ascending", () => {
		const nodes: SessionTreeNode[] = [
			{ id: "root", parentId: null, at: "2026-04-17T00:00:00.000Z", kind: "user" },
			{ id: "late", parentId: "root", at: "2026-04-17T00:00:05.000Z", kind: "assistant" },
			{ id: "early", parentId: "root", at: "2026-04-17T00:00:01.000Z", kind: "assistant" },
		];
		const snap = buildTreeSnapshot({ meta: buildMeta(), nodes, labels: new Map() });
		deepStrictEqual(snap.nodesById.root?.children, ["early", "late"]);
	});

	it("buildTreeSnapshot drops tombstone (empty-string) labels", () => {
		const nodes = fakeTreeNodes(1);
		const labels = new Map([["n0", { label: "", timestamp: "2026-04-17T00:00:05.000Z" }]]);
		const snap = buildTreeSnapshot({ meta: buildMeta(), nodes, labels });
		strictEqual(snap.nodesById.n0?.label, undefined);
	});
});

describe("session/tree resolveLabelMap (pure)", () => {
	function infoEntry(targetTurnId: string, label: string, timestamp: string): SessionEntry {
		return {
			kind: "sessionInfo",
			turnId: `info-${targetTurnId}-${timestamp}`,
			parentTurnId: null,
			timestamp,
			targetTurnId,
			label,
		} as SessionEntry;
	}

	it("last-wins by timestamp for forward-ordered entries", () => {
		const labels = resolveLabelMap([
			infoEntry("t1", "first", "2026-04-17T00:00:01.000Z"),
			infoEntry("t1", "second", "2026-04-17T00:00:02.000Z"),
		]);
		strictEqual(labels.get("t1")?.label, "second");
	});

	it("stores a tombstone for empty-string label so older entries cannot resurrect", () => {
		// Reproduces the ordering bug: clear at ts=3 arrives before an older
		// set at ts=2. Without the tombstone the older label would win.
		const labels = resolveLabelMap([
			infoEntry("t1", "x", "2026-04-17T00:00:01.000Z"),
			infoEntry("t1", "", "2026-04-17T00:00:03.000Z"),
			infoEntry("t1", "y", "2026-04-17T00:00:02.000Z"),
		]);
		const resolved = labels.get("t1");
		strictEqual(resolved?.label, "");
		strictEqual(resolved?.timestamp, "2026-04-17T00:00:03.000Z");
	});

	it("a newer label overrides a prior tombstone at the same target", () => {
		const labels = resolveLabelMap([
			infoEntry("t1", "x", "2026-04-17T00:00:01.000Z"),
			infoEntry("t1", "", "2026-04-17T00:00:02.000Z"),
			infoEntry("t1", "z", "2026-04-17T00:00:03.000Z"),
		]);
		strictEqual(labels.get("t1")?.label, "z");
	});

	it("ignores sessionInfo entries without targetTurnId", () => {
		const labels = resolveLabelMap([
			{
				kind: "sessionInfo",
				turnId: "info-noop",
				parentTurnId: null,
				timestamp: "2026-04-17T00:00:01.000Z",
				name: "pretty-name-only",
			} as SessionEntry,
		]);
		strictEqual(labels.size, 0);
	});
});

describe("session/contract tree + switchBranch + editLabel + deleteSession", () => {
	let scratch: string;
	let bundle: ReturnType<typeof createSessionBundle>;
	let contract: SessionContract;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-session-tree-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
		bundle = createSessionBundle(stubContext());
		contract = bundle.contract;
	});

	afterEach(async () => {
		try {
			await contract.close();
		} catch {
			// already closed
		}
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("tree() returns a snapshot for the current session with the appended turn", () => {
		const meta = contract.create({ cwd: scratch });
		const turn = contract.append({ parentId: null, kind: "user", payload: { text: "hi" } });
		const snap = contract.tree();
		strictEqual(snap.sessionId, meta.id);
		strictEqual(snap.leafId, turn.id);
		deepStrictEqual(snap.rootIds, [turn.id]);
		strictEqual(snap.nodesById[turn.id]?.kind, "user");
	});

	it("persists the workspace snapshot to meta.json at session create time", () => {
		const meta = contract.create({ cwd: scratch });
		const persisted = JSON.parse(readFileSync(sessionPaths(meta).meta, "utf8")) as SessionMeta;
		strictEqual(persisted.workspace?.cwd, scratch);
		strictEqual(persisted.workspace?.isGit, false);
		strictEqual(persisted.workspace?.projectType, "unknown");
	});

	it("writes a standard session header as the first JSONL record", () => {
		const meta = contract.create({ cwd: scratch });
		const header = openSession(meta.id).header();
		ok(header, "session header should be present");
		strictEqual(header.type, "session");
		strictEqual(header.id, meta.id);
		strictEqual(header.cwd, scratch);
		strictEqual(header.version, 2);
	});

	it("writeJsonlFileAtomic leaves the original JSONL intact if interrupted before rename", () => {
		const path = join(scratch, "atomic.jsonl");
		writeJsonlFileAtomic(path, [{ ok: "original" }]);
		const original = readFileSync(path, "utf8");

		throws(
			() =>
				writeJsonlFileAtomic(path, [{ ok: "replacement" }], {
					beforeRename: () => {
						throw new Error("simulated interruption");
					},
				}),
			/simulated interruption/,
		);

		strictEqual(readFileSync(path, "utf8"), original);
	});

	it("recovers current.jsonl from its temp file when the canonical file is missing", () => {
		const meta = contract.create({ cwd: scratch });
		contract.append({ parentId: null, kind: "user", payload: { text: "recover me" } });
		const current = sessionPaths(meta).current;
		const tmp = `${current}.tmp`;
		const original = readFileSync(current, "utf8");
		rmSync(current, { force: true });
		writeFileSync(tmp, original, "utf8");

		const entries = readSessionFileEntries(current);

		strictEqual(existsSync(current), true, "temp file should be promoted to current.jsonl");
		strictEqual(existsSync(tmp), false, "temp file should be consumed");
		strictEqual(entries.length, 2, "header plus user turn should recover");
		strictEqual(openSession(meta.id).turns().length, 1);
	});

	it("skips a corrupt trailing JSONL record with an explicit warning", () => {
		const meta = contract.create({ cwd: scratch });
		contract.append({ parentId: null, kind: "user", payload: { text: "first" } });
		contract.append({ parentId: null, kind: "assistant", payload: { text: "second" } });
		const current = sessionPaths(meta).current;
		appendFileSync(current, "{not-json");
		const warnings: string[] = [];

		const entries = readSessionFileEntries(current, {
			onWarning: (warning) => warnings.push(`${warning.line}:${warning.message}`),
		});

		strictEqual(entries.length, 3, "header plus two valid records should survive");
		ok(
			warnings.some((warning) => warning.includes("invalid JSON skipped")),
			warnings.join("\n"),
		);
		strictEqual(openSession(meta.id).turns().length, 2, "openSession loads up to the last valid line");
	});

	it("recovers tree state from JSONL if tree.json is stale", () => {
		const meta = contract.create({ cwd: scratch });
		const turn = contract.append({ parentId: null, kind: "user", payload: { text: "survives" } });
		writeFileSync(sessionPaths(meta).tree, "[]", "utf8");

		const tree = openSession(meta.id).tree();
		strictEqual(tree.length, 1);
		strictEqual(tree[0]?.id, turn.id);
		strictEqual(tree[0]?.kind, "user");
	});

	it("drops stale extra tree nodes that are not present in current.jsonl", () => {
		const meta = contract.create({ cwd: scratch });
		const turn = contract.append({ parentId: null, kind: "user", payload: { text: "only valid node" } });
		writeFileSync(
			sessionPaths(meta).tree,
			JSON.stringify([
				{ id: turn.id, parentId: null, at: turn.at, kind: "user" },
				{ id: "stale-extra", parentId: turn.id, at: "2026-04-17T00:00:10.000Z", kind: "assistant" },
			]),
			"utf8",
		);

		const tree = openSession(meta.id).tree();
		strictEqual(tree.length, 1);
		strictEqual(tree[0]?.id, turn.id);
	});

	it("rebuilds tree state from JSONL when tree.json is malformed", () => {
		const meta = contract.create({ cwd: scratch });
		const turn = contract.append({ parentId: null, kind: "user", payload: { text: "malformed tree" } });
		writeFileSync(sessionPaths(meta).tree, "{not-json", "utf8");

		const tree = openSession(meta.id).tree();
		strictEqual(tree.length, 1);
		strictEqual(tree[0]?.id, turn.id);
	});

	it("persists taskLedger entries in the session JSONL stream", () => {
		const meta = contract.create({ cwd: scratch });
		const user = contract.append({ parentId: null, kind: "user", payload: { text: "ship the goal" } });

		contract.appendEntry({
			kind: "taskLedger",
			parentTurnId: user.id,
			goals: [{ id: "goal-1", title: "Build session manager", status: "active" }],
			subgoals: [{ id: "subgoal-1", title: "Validate JSONL replay", status: "pending", parentGoalId: "goal-1" }],
			activeRunIds: ["run-1"],
			requiredValidationEvidence: [{ id: "evidence-1", description: "npm run test", status: "required" }],
		});

		const ledger = readSessionFileEntries(sessionPaths(meta).current).find(
			(entry): entry is TaskLedgerEntry =>
				typeof entry === "object" && entry !== null && (entry as { kind?: unknown }).kind === "taskLedger",
		);
		ok(ledger, "taskLedger line should be present");
		ok(isSessionEntry(ledger), "taskLedger line should satisfy the schema guard");
		strictEqual(ledger.parentTurnId, user.id);
		strictEqual(ledger.goals[0]?.title, "Build session manager");
		strictEqual(ledger.requiredValidationEvidence[0]?.description, "npm run test");
	});

	it("switchBranch() makes the target session current", () => {
		const first = contract.create({ cwd: scratch });
		contract.append({ parentId: null, kind: "user", payload: { text: "first" } });
		const second = contract.create({ cwd: scratch });
		strictEqual(contract.current()?.id, second.id);
		const restored = contract.switchBranch(first.id);
		strictEqual(restored.id, first.id);
		strictEqual(contract.current()?.id, first.id);
	});

	it("editLabel() persists a label that survives a switchBranch round-trip", () => {
		const meta = contract.create({ cwd: scratch });
		const turn = contract.append({ parentId: null, kind: "user", payload: { text: "label me" } });

		contract.editLabel(turn.id, "pinned");

		// Flush to disk before reopening. The writer fsyncs on every append so
		// the sessionInfo line is already durable; a resume (via switchBranch)
		// rebuilds from disk and should reveal the label via tree().
		const other = contract.create({ cwd: scratch });
		strictEqual(other.id !== meta.id, true);
		contract.switchBranch(meta.id);

		const snap = contract.tree();
		strictEqual(snap.nodesById[turn.id]?.label, "pinned");
	});

	it("editLabel() can target a non-current session by id", () => {
		const target = contract.create({ cwd: scratch });
		const turn = contract.append({ parentId: null, kind: "user", payload: { text: "hi" } });

		const other = contract.create({ cwd: scratch });
		strictEqual(contract.current()?.id, other.id);

		contract.editLabel(turn.id, "remote-label", target.id);

		const snap = contract.tree(target.id);
		strictEqual(snap.nodesById[turn.id]?.label, "remote-label");
	});

	it("deleteSession() wipes the session directory by default", async () => {
		const keep = contract.create({ cwd: scratch });
		contract.append({ parentId: null, kind: "user", payload: { text: "keep" } });
		const doomed = contract.create({ cwd: scratch });
		contract.append({ parentId: null, kind: "user", payload: { text: "doomed" } });
		// switch to `keep` so `doomed` is closed and eligible for deletion.
		contract.switchBranch(keep.id);

		const doomedDir = join(scratch, "data", "sessions", keep.cwdHash, doomed.id);
		ok(existsSync(doomedDir), "session dir exists before delete");

		contract.deleteSession(doomed.id);

		ok(!existsSync(doomedDir), "session dir removed");
		const ids = contract.history().map((m) => m.id);
		ok(!ids.includes(doomed.id), "session falls out of history()");
	});

	it("deleteSession({ keepFiles: true }) tombstones meta and retains transcript", () => {
		const keep = contract.create({ cwd: scratch });
		contract.append({ parentId: null, kind: "user", payload: { text: "keep" } });
		const tombstoned = contract.create({ cwd: scratch });
		contract.append({ parentId: null, kind: "user", payload: { text: "tombstone" } });
		contract.switchBranch(keep.id);

		const baseDir = join(scratch, "data", "sessions", keep.cwdHash, tombstoned.id);
		const originalMeta = join(baseDir, "meta.json");
		const tombstonedMeta = join(baseDir, "meta.deleted.json");
		const transcript = join(baseDir, "current.jsonl");

		contract.deleteSession(tombstoned.id, { keepFiles: true });

		ok(!existsSync(originalMeta), "meta.json renamed");
		ok(existsSync(tombstonedMeta), "meta.deleted.json in place");
		ok(existsSync(transcript), "current.jsonl retained");
		const ids = contract.history().map((m) => m.id);
		ok(!ids.includes(tombstoned.id), "tombstoned session falls out of history()");

		// Transcript still contains the original user line.
		const text = readFileSync(transcript, "utf8");
		ok(text.includes("tombstone"), "transcript preserved");
	});

	it("deleteSession() refuses to delete the currently open session", () => {
		const current = contract.create({ cwd: scratch });
		throws(() => contract.deleteSession(current.id), /refusing to delete/);
	});
});
