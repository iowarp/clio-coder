import assert from "node:assert/strict";
import { test } from "node:test";
import { Accepted } from "../contracts/operations.js";
import { restrictNetwork } from "../server/network-policy.js";
import { fixtureOptions } from "./fixtures/toolchain.js";
import { pinnedFetcher } from "./harness/adapter.js";
import { harness, json, terminal } from "./harness/app.js";

test("ambient network is denied; injected registry downloads complete across the worker boundary", async (t) => {
	await assert.rejects(globalThis.fetch("https://fixture.invalid"), /forbidden/);
	const previous = restrictNetwork();
	t.after(() => {
		globalThis.fetch = previous;
	});
	await assert.rejects(globalThis.fetch("https://fixture.invalid"), /pinned toolchain/);
	let calls = 0;
	const fixture = fixtureOptions();
	const fetcher = pinnedFetcher(fixture.pins, async () => {
		calls++;
		return Buffer.from("fixture");
	});
	for (const url of [
		"http://localhost:1234",
		"https://fixture.invalid/herdr?redirect=elsewhere",
		"https://fixture.invalid.evil/herdr",
	])
		await assert.rejects(fetcher(url), /outside the pinned/);
	assert.equal(calls, 0);
	await fetcher("https://fixture.invalid/herdr");
	assert.equal(calls, 1);
	const h = await harness();
	t.after(h.close);
	const operation = await json(await h.post("/api/toolchain/tools/herdr/install"), Accepted);
	assert.equal((await terminal(h.operations, operation.operationId)).status, "succeeded");
});
