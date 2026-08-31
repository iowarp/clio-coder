import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	readTargetModelSnapshot,
	recordTargetModelSnapshot,
	targetModelSnapshotPath,
} from "../../src/domains/providers/target-model-cache.js";

describe("contracts/target model probe cache", () => {
	it("stores a deduplicated catalog outside settings and reads it for the same target identity", () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "clio-target-models-"));
		try {
			const target = { id: "local/target", runtime: "openai-compat", url: "http://127.0.0.1:8080" };
			strictEqual(
				recordTargetModelSnapshot(target, ["alpha", "beta", "alpha", "  beta  "], {
					cacheDir,
					nowMs: Date.parse("2026-08-31T12:00:00.000Z"),
				}),
				true,
			);
			const path = targetModelSnapshotPath(target.id, cacheDir);
			ok(path.startsWith(cacheDir));
			ok(!path.endsWith("local/target.json"), "target ids cannot become path segments");
			const snapshot = readTargetModelSnapshot(target, {
				cacheDir,
				nowMs: Date.parse("2026-08-31T13:00:00.000Z"),
			});
			deepStrictEqual(snapshot?.models, ["alpha", "beta"]);
			strictEqual(snapshot?.targetId, target.id);
		} finally {
			rmSync(cacheDir, { recursive: true, force: true });
		}
	});

	it("rejects stale, foreign-identity, and malformed snapshots", () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "clio-target-models-invalid-"));
		try {
			const target = { id: "local", runtime: "llamacpp", url: "http://127.0.0.1:8080" };
			const observedAt = Date.parse("2026-08-30T12:00:00.000Z");
			recordTargetModelSnapshot(target, ["alpha"], { cacheDir, nowMs: observedAt });
			strictEqual(readTargetModelSnapshot(target, { cacheDir, nowMs: observedAt + 1_000, ttlMs: 1_000 }), null);
			strictEqual(readTargetModelSnapshot({ ...target, runtime: "lmstudio" }, { cacheDir, nowMs: observedAt }), null);
			strictEqual(
				readTargetModelSnapshot({ ...target, url: "http://127.0.0.1:1234" }, { cacheDir, nowMs: observedAt }),
				null,
			);

			writeFileSync(targetModelSnapshotPath(target.id, cacheDir), "{not json\n");
			strictEqual(readTargetModelSnapshot(target, { cacheDir, nowMs: observedAt }), null);
		} finally {
			rmSync(cacheDir, { recursive: true, force: true });
		}
	});
});
