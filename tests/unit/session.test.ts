import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import {
	SESSION_ENTRY_KINDS,
	type SessionEntry,
	fromLegacyTurn,
	isSessionEntry,
} from "../../src/domains/session/entries.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import type { SessionContract, SessionMeta } from "../../src/domains/session/index.js";
import { CURRENT_SESSION_FORMAT_VERSION, runMigrations } from "../../src/domains/session/migrations/index.js";
import { migrateV1ToV2 } from "../../src/domains/session/migrations/v1-to-v2.js";
import { buildTreeSnapshot, computeLeafId } from "../../src/domains/session/tree/navigator.js";
import {
	getLocalRegisteredModel,
	registerLocalProviders,
	resolveLocalModelId,
} from "../../src/engine/local-model-registry.js";
import type { ClioTurnRecord, SessionTreeNode } from "../../src/engine/session.js";

function buildMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
	return {
		id: "00000000-0000-7000-8000-000000000000",
		cwd: "/tmp/clio-test",
		cwdHash: "abc123",
		createdAt: "2026-04-17T00:00:00.000Z",
		endedAt: null,
		model: null,
		provider: null,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.1.0-dev",
		piMonoVersion: "0.67.4",
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
			],
		);
	});

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
			const entry = {
				kind,
				turnId: `t-${kind}`,
				parentTurnId: null,
				timestamp: "2026-04-17T00:00:00.000Z",
			} as unknown as SessionEntry;
			strictEqual(isSessionEntry(entry), true, `kind ${kind} should be recognized`);
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
		strictEqual(isSessionEntry(null), false);
		strictEqual(isSessionEntry("string"), false);
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

describe("session/local-model-resolution (Qwen3.6 fix)", () => {
	it("resolveLocalModelId composes modelId@endpoint for the Qwen3.6 case", () => {
		strictEqual(resolveLocalModelId("llamacpp", "Qwen3.6-35B-A3B-UD-Q4_K_XL", "mini"), "Qwen3.6-35B-A3B-UD-Q4_K_XL@mini");
	});

	it("resolveLocalModelId passes through when the id is already composed", () => {
		strictEqual(
			resolveLocalModelId("llamacpp", "Qwen3.6-35B-A3B-UD-Q4_K_XL@mini", "mini"),
			"Qwen3.6-35B-A3B-UD-Q4_K_XL@mini",
		);
	});

	it("registerLocalProviders + resolveLocalModelId yields a reasoning-capable Model for Qwen3.6", () => {
		registerLocalProviders({
			llamacpp: {
				endpoints: {
					mini: { default_model: "Qwen3.6-35B-A3B-UD-Q4_K_XL", url: "http://mini.local:8080" },
				},
			},
		});
		const lookupId = resolveLocalModelId("llamacpp", "Qwen3.6-35B-A3B-UD-Q4_K_XL", "mini");
		strictEqual(lookupId, "Qwen3.6-35B-A3B-UD-Q4_K_XL@mini");
		const model = getLocalRegisteredModel("llamacpp", lookupId);
		ok(model, "expected registered Model for llamacpp/Qwen3.6-35B-A3B-UD-Q4_K_XL@mini");
		// The llamacpp Qwen3 preset enables reasoning; this is the bug the
		// pre-phase fix unblocked. Without the fix, getOrchestratorModel
		// falls through to pi-ai's static catalog and supportsThinking returns
		// false, locking /thinking at [off].
		strictEqual(model?.reasoning, true);
		strictEqual((model as { compat?: { thinkingFormat?: string } })?.compat?.thinkingFormat, "qwen-chat-template");
	});

	it("cloud providers never carry an endpoint in the composed id", () => {
		strictEqual(resolveLocalModelId("anthropic", "claude-sonnet-4-6", "ignored"), "claude-sonnet-4-6");
		strictEqual(resolveLocalModelId("openai", "gpt-5", undefined), "gpt-5");
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
