import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Empty, Problem } from "../contracts/common.js";
import { MemoryPending, TrustPreview } from "../contracts/review.js";
import { harness, json } from "./harness/app.js";
import { sourceCliEnv } from "./harness/library-fixture.js";

test("project settings are previewed, refused on a stale hash and trusted through the CLI", async () => {
	const h = await harness({}, { env: sourceCliEnv });
	try {
		await mkdir(join(h.home.path, ".clio-coder"), { recursive: true });
		await writeFile(join(h.home.path, ".clio-coder/settings.yaml"), "version: 1\n");
		const workspace = await h.workspaces.open(h.home.path),
			path = `/api/workspaces/${workspace.id}/trust/settings`;
		const read = async () => {
			const response = await h.request(path);
			assert.equal(response.status, 200, await response.clone().text());
			return json(response, TrustPreview);
		};
		const before = await read();
		assert.match(before.files[0]?.path ?? "", /settings\.yaml$/u);
		assert.equal(before.verdict, "untrusted");
		assert.ok(before.contentHash);

		const stale = await h.post(path, { hash: "0".repeat(64) });
		assert.equal(stale.status, 409, await stale.clone().text());
		const problem = await json(stale, Problem);
		assert.equal(problem.code, "conflict");
		assert.equal(problem.detail, "The files changed after you opened this review.");

		const approved = await h.post(path, { hash: before.contentHash });
		assert.equal(approved.status, 200, await approved.clone().text());
		assert.deepEqual(await json(approved, Empty), {});
		assert.equal((await read()).verdict, "trusted");
		assert.equal((await h.post(path, { hash: "not-a-hash" })).status, 422);
		assert.equal((await h.request(`/api/workspaces/${workspace.id}/trust/secrets`)).status, 422);
	} finally {
		await h.close();
	}
});

test("pending lessons list only unapproved records and an approval removes one", async () => {
	const h = await harness({}, { env: sourceCliEnv });
	try {
		const record = (id: string, approved: boolean, patch: Record<string, unknown> = {}) => ({
			id,
			scope: "global",
			key: `lesson-${id}`,
			lesson: `Lesson ${id}.`,
			evidenceRefs: ["run:synthetic"],
			appliesWhen: ["installing dependencies"],
			avoidWhen: [],
			confidence: 0.8,
			createdAt: "2026-09-21T00:00:00.000Z",
			approved,
			...patch,
		});
		// The scratch home's CLIO_CODER_DATA_DIR.
		const dataDir = join(h.home.path, "data");
		await mkdir(join(dataDir, "memory"), { recursive: true });
		await writeFile(
			join(dataDir, "memory/records.json"),
			JSON.stringify({
				version: 1,
				records: [
					record("mem-00000000000000a1", false),
					record("mem-00000000000000a2", true),
					record("mem-00000000000000a3", false, { rejectedAt: "2026-09-22T00:00:00.000Z" }),
					record("mem-00000000000000a4", false, { createdAt: "2026-09-23T00:00:00.000Z" }),
				],
			}),
		);
		const workspace = await h.workspaces.open(h.home.path),
			base = `/api/workspaces/${workspace.id}/memory`;
		const pending = async () => {
			const response = await h.request(`${base}/pending`);
			assert.equal(response.status, 200, await response.clone().text());
			return (await json(response, MemoryPending)).records.map((row) => row.id);
		};
		assert.deepEqual(await pending(), ["mem-00000000000000a4", "mem-00000000000000a1"]);

		const approved = await h.post(`${base}/mem-00000000000000a1`, { decision: "approve" });
		assert.equal(approved.status, 200, await approved.clone().text());
		assert.deepEqual(await json(approved, Empty), {});
		assert.deepEqual(await pending(), ["mem-00000000000000a4"]);

		const missing = await h.post(`${base}/mem-00000000000000ff`, { decision: "reject" });
		assert.equal(missing.status, 409, await missing.clone().text());
		assert.equal((await json(missing, Problem)).detail, "Lesson mem-00000000000000ff is no longer waiting for review.");
		assert.equal((await h.post(`${base}/--help`, { decision: "approve" })).status, 422);
	} finally {
		await h.close();
	}
});
