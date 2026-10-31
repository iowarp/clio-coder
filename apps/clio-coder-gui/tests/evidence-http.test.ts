import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Static } from "typebox";
import { EvidenceDetail, EvidencePage } from "../contracts/evidence.js";
import { Accepted } from "../contracts/operations.js";
import { harness, json, terminal } from "./harness/app.js";
import { seedEvidence } from "./harness/evidence-fixture.js";

test("evidence REST pages all 40 runs newest first with their sealed assessments and admitted provenance", async () => {
	const h = await harness();
	try {
		await seedEvidence(h.home.path, h.home.env);
		// The source worker imports the evidence adapter through tsx on its first call, which
		// under a parallel tier with a cold transform cache outlasts the 10 s read deadline.
		// Pay that import here on its own budget so every asserted read keeps the shipped deadline.
		await h.reads.call("evidence.read", { kind: "list", limit: 1 }, { deadlineMs: 60_000 });
		const visited: string[] = [];
		let cursor: string | null = null;
		do {
			const page: Static<typeof EvidencePage> = await json(
				await h.request(`/api/evidence?limit=7${cursor ? `&cursor=${cursor}` : ""}`),
				EvidencePage,
			);
			visited.push(...page.items.map((row) => row.run.runId));
			// Totals arrive worded by the server; the browser shows the strings and sums nothing (#434).
			for (const row of page.items) {
				assert.equal(row.run.integrity, "verified");
				assert.ok(row.run.assessedAt);
				assert.equal(typeof row.run.quantities?.tokens.display, "string");
				assert.equal(typeof row.run.quantities?.usd.display, "string");
			}
			cursor = page.nextCursor;
		} while (cursor);
		assert.equal(visited.length, 40);
		assert.equal(new Set(visited).size, 40);
		assert.equal(visited[0], "evidence-039");
		const detail = await json(await h.request("/api/evidence/evidence-039"), EvidenceDetail);
		assert.equal(detail.summary.axes.artifactIntegrity, "verified");
		assert.equal(Object.keys(detail.summary.axes).length, 5);
		assert.equal(detail.summary.verdict, detail.verdict);
		assert.match(detail.provenance.lines.join(" "), /step 2.*earlier-run/);
		// An id this host never served is refused, not looked up: 404 would claim a
		// search that did not happen. tests/artifact-window.test.ts owns that rule.
		assert.equal((await h.request("/api/evidence/missing")).status, 403);
		for (const query of ["limit=0", "limit=101", "cursor=broken"])
			assert.equal((await h.request(`/api/evidence?${query}`)).status, 422);
	} finally {
		await h.close();
	}
});

test("real CLI rechecks a tampered run seal truthfully", async () => {
	const h = await harness();
	try {
		const seeded = await seedEvidence(h.home.path, h.home.env);
		const workspace = await h.workspaces.open(h.home.path);
		// The dispatch listing is what makes the run id referenceable at all.
		await h.request("/api/fleet/dispatches");
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
		// A rewritten object: the seal lists the object's digest, which no longer matches (#434).
		const objects = join(h.home.path, "state/telemetry/runs", seeded.runId, "objects");
		const [object] = await readdir(objects);
		assert.ok(object);
		const stored = await readFile(join(objects, object), "utf8");
		await writeFile(join(objects, object), stored.replace('"version":1', '"version":2'));
		const failed = await verify();
		assert.equal(failed.state, "failed");
		assert.equal(failed.reason, "object-mismatch");
		assert.equal(h.cli.activeCount, 0);
	} finally {
		await h.close();
	}
});

test("evidence inventory distinguishes an absent run store from a present empty one", async () => {
	const h = await harness();
	try {
		const absent = await json(await h.request("/api/evidence"), EvidencePage);
		assert.equal(absent.present, false);
		assert.deepEqual(absent.items, []);
		await mkdir(join(h.home.path, "state/telemetry/runs"), { recursive: true });
		const empty = await json(await h.request("/api/evidence"), EvidencePage);
		assert.equal(empty.present, true);
		assert.deepEqual(empty.items, []);
	} finally {
		await h.close();
	}
});
