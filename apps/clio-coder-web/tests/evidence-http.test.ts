import assert from "node:assert/strict";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Static } from "typebox";
import { EvidenceDetail, EvidencePage } from "../contracts/evidence.js";
import { Accepted } from "../contracts/operations.js";
import { harness, json, terminal } from "./harness/app.js";
import { seedEvidence } from "./harness/evidence-fixture.js";

test("evidence REST preserves all 40 artifacts, historical unknown, provenance and bounded contained reads", async () => {
	const h = await harness();
	try {
		await seedEvidence(h.home.path, h.home.env);
		await writeFile(join(h.home.path, "data/evidence/incomplete-file"), "incomplete artifact");
		const visited: string[] = [],
			unknown: string[] = [];
		let cursor: string | null = null;
		do {
			const page: Static<typeof EvidencePage> = await json(
				await h.request(`/api/evidence?limit=7${cursor ? `&cursor=${cursor}` : ""}`),
				EvidencePage,
			);
			visited.push(...page.items.map((row) => row.overview.evidenceId));
			unknown.push(...page.items.filter((row) => row.verdict === "unknown").map((row) => row.overview.evidenceId));
			cursor = page.nextCursor;
		} while (cursor);
		assert.equal(visited.length, 40);
		assert.equal(new Set(visited).size, 40);
		assert.equal(visited[0], "evidence-039");
		assert.deepEqual(unknown, ["evidence-000"]);
		const detail = await json(await h.request("/api/evidence/evidence-039"), EvidenceDetail);
		assert.equal(detail.runs[0]?.summary.axes.artifactIntegrity, "verified");
		assert.equal(detail.runs[0]?.summary.verdict, detail.verdict);
		assert.equal(detail.gateDecisions.length, 1);
		assert.equal(detail.gateDecisions[0]?.outcome, "pass");
		assert.match(detail.provenance[0]?.lines.join(" ") ?? "", /step 2.*earlier-run/);
		assert.equal(
			(await json(await h.request("/api/evidence/evidence-000"), EvidenceDetail)).projection,
			"historical_format",
		);
		assert.equal((await h.request("/api/evidence/missing")).status, 404);
		for (const query of ["limit=0", "limit=101", "cursor=broken"])
			assert.equal((await h.request(`/api/evidence?${query}`)).status, 422);
		await writeFile(join(h.home.path, "outside.json"), '{"leak":true}');
		await symlink(join(h.home.path, "outside.json"), join(h.home.path, "data/evidence/evidence-000/trust-status.json"));
		assert.equal((await h.request("/api/evidence/evidence-000")).status, 503);
		assert.equal((await h.request("/api/evidence/evidence-039")).status, 200);
	} finally {
		await h.close();
	}
});

test("real CLI builds evidence once per key, follows typed storage, and rechecks a tampered receipt truthfully", async () => {
	const h = await harness();
	try {
		const seeded = await seedEvidence(h.home.path, h.home.env);
		const workspace = await h.workspaces.open(h.home.path);
		const path = `/api/workspaces/${workspace.id}/evidence/${seeded.runId}/build`;
		const accepted = await json(await h.post(path, {}, "build-once"), Accepted);
		assert.deepEqual(await json(await h.post(path, {}, "build-once"), Accepted), accepted);
		const operation = await terminal(h.operations, accepted.operationId, 30_000);
		assert.equal(operation.status, "succeeded", JSON.stringify(operation));
		assert.ok(operation.status === "succeeded" && "kind" in operation.result && operation.result.kind === "evidence");
		assert.equal(operation.result.artifact.overview.source.kind, "run");
		assert.equal((await json(await h.request("/api/evidence?limit=100"), EvidencePage)).items.length, 41);
		const verify = async () => {
			const accepted = await json(
				await h.post(`/api/workspaces/${workspace.id}/receipts/${seeded.runId}/verify`),
				Accepted,
			);
			const operation = await terminal(h.operations, accepted.operationId, 30_000);
			assert.ok(
				operation.status === "succeeded" && "kind" in operation.result && operation.result.kind === "receipt-verification",
				JSON.stringify(operation),
			);
			return operation.result.verification;
		};
		assert.equal((await verify()).state, "verified");
		const receiptPath = join(h.home.path, "state/receipts", `${seeded.runId}.json`);
		const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
		receipt.tokenCount += 1;
		await writeFile(receiptPath, JSON.stringify(receipt));
		const failed = await verify();
		assert.equal(failed.state, "failed");
		assert.equal(failed.reason, "ledger-mismatch");
		assert.equal((await h.post(path, { argv: ["--session", "escape"] })).status, 422);
		assert.equal(h.cli.activeCount, 0);
	} finally {
		await h.close();
	}
});
