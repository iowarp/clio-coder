import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	SESSION_ENTRY_KINDS,
	type SessionEntry,
	fromLegacyTurn,
	isSessionEntry,
} from "../../src/domains/session/entries.js";
import type { SessionMeta } from "../../src/domains/session/index.js";
import { CURRENT_SESSION_FORMAT_VERSION, runMigrations } from "../../src/domains/session/migrations/index.js";
import { migrateV1ToV2 } from "../../src/domains/session/migrations/v1-to-v2.js";
import {
	getLocalRegisteredModel,
	registerLocalProviders,
	resolveLocalModelId,
} from "../../src/engine/local-model-registry.js";
import type { ClioTurnRecord } from "../../src/engine/session.js";

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
