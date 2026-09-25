/**
 * The out-of-turn usage store writes only the fields `clio-coder usage report`
 * reads. `sessionId`, `timing`, `promptCache` and `usage.costProvenance` had no
 * reader, so new rows omit them, while rows an earlier build wrote with them
 * still parse.
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, it } from "node:test";
import { backgroundMemoryUsageRow } from "../../src/domains/observability/background-memory-usage.js";
import { recordFailedCompactionCalls } from "../../src/domains/observability/compaction-usage.js";
import { outOfTurnUsagePath, readOutOfTurnUsageRows } from "../../src/domains/observability/out-of-turn-usage.js";

const scratch = mkdtempSync(join(tmpdir(), "clio-coder-out-of-turn-fields-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const UNREAD = ["sessionId", "timing", "promptCache"];

function assertOnlyReadFields(row: Record<string, unknown>): void {
	for (const key of UNREAD) equal(key in row, false, `${key} must not be written`);
	const usage = row.usage as Record<string, unknown>;
	equal("costProvenance" in usage, false, "usage.costProvenance must not be written");
}

it("background-memory rows carry no unread fields", () => {
	const row = backgroundMemoryUsageRow(
		{
			targetId: "local",
			attributedModelId: "model",
			input: 10,
			output: 2,
			cacheRead: 4,
			cacheWrite: 0,
			reasoning: 0,
			totalTokens: 16,
			costUsd: 0,
			costProvenance: "known_free",
		},
		{ repoIdentity: "repo-1" },
	);
	assertOnlyReadFields(row as unknown as Record<string, unknown>);
	equal(row.repoIdentity, "repo-1");
	equal(row.usage.totalTokens, 16);
});

it("failed-compaction rows carry no unread fields and keep their outcome", () => {
	const stateDir = join(scratch, "compaction");
	recordFailedCompactionCalls({ stateDir, repoIdentity: "repo-1", target: "local", model: "model" }, [
		{
			outcome: "error",
			timestamp: "2026-09-25T12:00:00.000Z",
			usage: { input: 5, output: 0, cost: { total: 0 } },
		},
	]);
	const [line] = readFileSync(outOfTurnUsagePath(stateDir), "utf8").trim().split("\n");
	ok(line);
	const written = JSON.parse(line) as Record<string, unknown>;
	assertOnlyReadFields(written);
	equal(written.callOutcome, "error");
});

it("rows an earlier build wrote with the retired fields still parse", () => {
	const stateDir = join(scratch, "legacy");
	const path = outOfTurnUsagePath(stateDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({
			label: "background-memory",
			sessionId: "session-1",
			repoIdentity: "repo-1",
			timestamp: "2026-09-25T12:00:00.000Z",
			target: "local",
			attributedModelId: "model",
			usage: {
				input: 3,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				reasoning: 0,
				totalTokens: 4,
				costUsd: 0.001,
				costProvenance: "known",
			},
			timing: { durationMs: 900 },
			promptCache: { promptTokens: 3, cachedTokens: 0, uncachedPrefillTokens: 3, promptMs: 10, source: "llamacpp" },
		})}\n`,
	);
	const read = readOutOfTurnUsageRows(stateDir);
	deepStrictEqual(read.errors, []);
	const [row] = read.rows;
	ok(row);
	equal(row.repoIdentity, "repo-1");
	equal(row.usage.totalTokens, 4);
	equal(row.usage.costUsd, 0.001);
	assertOnlyReadFields(row as unknown as Record<string, unknown>);
});
