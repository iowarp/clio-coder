import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import { Problem } from "../contracts/common.js";
import type { Event } from "../contracts/events.js";
import { Accepted, Operation } from "../contracts/operations.js";
import { Tools } from "../contracts/toolchain.js";
import { PINNED_TOOLS } from "./fixtures/toolchain.js";
import { harness, json, terminal } from "./harness/app.js";

test("real domain workers: inventory, fabricated install over SSE, idempotency, cancel, removal", async (t) => {
	const h = await harness();
	t.after(h.close);
	const list = await h.request("/api/toolchain/tools");
	const tools = await list.json();
	assert.ok(Value.Check(Tools, tools));
	assert.deepEqual(
		tools.map((row) => row.id),
		PINNED_TOOLS.map((row) => row.id),
	);
	assert.ok(Number(list.headers.get("X-Clio-Worker-Thread")) > 0);
	assert.equal(Number(list.headers.get("X-Clio-Worker-Thread")), h.reads.threadId);
	assert.notEqual(h.reads.threadId, h.ops.threadId);
	const stream = await h.request("/api/events");
	const reader = stream.body?.getReader();
	assert.ok(reader);
	t.after(() => reader.cancel());
	const events: Event[] = [];
	let pending = "";
	const received = (async () => {
		const decoder = new TextDecoder();
		while (true) {
			const result = await reader.read();
			if (result.done) return;
			pending += decoder.decode(result.value, { stream: true });
			let end = pending.indexOf("\n\n");
			while (end >= 0) {
				const frame = pending.slice(0, end);
				pending = pending.slice(end + 2);
				const data = frame.split("\n").find((line) => line.startsWith("data: "));
				if (data) events.push(JSON.parse(data.slice(6)));
				end = pending.indexOf("\n\n");
			}
		}
	})();
	const first = await h.post("/api/toolchain/tools/herdr/install", { force: false }, "install-key");
	assert.equal(first.status, 202);
	const { operationId } = await json(first, Accepted);
	assert.deepEqual(await (await h.post("/api/toolchain/tools/herdr/install", { force: false }, "install-key")).json(), {
		operationId,
	});
	assert.equal((await h.post("/api/toolchain/tools/herdr/install", { force: true }, "install-key")).status, 409);
	const cancel = await h.post(`/api/operations/${operationId}/cancel`);
	assert.equal(cancel.status, 409);
	assert.equal((await json(cancel, Problem)).code, "unsupported");
	const record = await terminal(h.operations, operationId);
	assert.equal(record.status, "succeeded");
	assert.equal(record.cancellable, false);
	assert.ok(Value.Check(Operation, record));
	const snapshot = await h.request(`/api/operations/${operationId}`);
	assert.deepEqual(await snapshot.json(), record);
	assert.equal(Number(snapshot.headers.get("X-Clio-Revision")), record.revision);
	await reader.cancel();
	await received;
	assert.ok(events.filter((event) => event.type === "operation.progress").length >= 2);
	const finished = events.find((event) => event.type === "operation.finished");
	assert.ok(finished?.type === "operation.finished");
	assert.deepEqual(finished.payload.operation, record);
	const installed = await json(await h.request("/api/toolchain/tools"), Tools);
	assert.equal(installed[0]?.installed, true);
	assert.equal(installed[0]?.resolution.source, "vendored");
	const file = join(h.home.path, "data/tools/herdr", PINNED_TOOLS[0]?.version ?? "", "herdr");
	assert.ok(existsSync(file));
	const removal = await h.post("/api/toolchain/tools/herdr/remove");
	assert.equal(removal.status, 202);
	assert.equal((await terminal(h.operations, (await json(removal, Accepted)).operationId)).status, "succeeded");
	assert.equal(existsSync(file), false);
	assert.equal((await h.post("/api/toolchain/tools/unknown/install")).status, 404);
	assert.equal((await h.post("/api/toolchain/tools/bad!/install")).status, 422);
	assert.equal((await h.post("/api/toolchain/tools/%2e%2e/install")).status, 404);
	assert.equal((await h.post("/api/toolchain/tools/herdr/install", { force: "yes" })).status, 422);
	assert.equal((await h.post("/api/toolchain/tools/herdr/install", { extra: true })).status, 422);
	assert.equal(
		(
			await h.request("/api/toolchain/tools/herdr/install", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			})
		).status,
		422,
	);
});

test("domain installation failure is a redacted terminal problem", async (t) => {
	const h = await harness({ failInstall: true });
	t.after(h.close);
	const { operationId } = await json(await h.post("/api/toolchain/tools/herdr/install"), Accepted);
	const record = await terminal(h.operations, operationId);
	assert.ok(record.status === "failed");
	assert.equal(record.problem.code, "operation_failed");
	assert.doesNotMatch(JSON.stringify(record), /private-stderr-sentinel|\n\s+at /);
});

test("production toolStatuses and removeTool execute in separate workers without fixture substitution", async (t) => {
	const h = await harness({ fixture: false });
	t.after(h.close);
	const response = await h.request("/api/toolchain/tools");
	const rows = await json(response, Tools);
	assert.deepEqual(
		rows.map((row) => row.id),
		PINNED_TOOLS.map((pin) => pin.id),
	);
	assert.deepEqual(
		rows.map((row) => row.summary),
		PINNED_TOOLS.map((pin) => pin.summary),
	);
	assert.equal(Number(response.headers.get("X-Clio-Worker-Thread")), h.reads.threadId);
	const accepted = await json(await h.post("/api/toolchain/tools/herdr/remove"), Accepted);
	assert.equal((await terminal(h.operations, accepted.operationId)).status, "succeeded");
	assert.ok((h.ops.threadId ?? 0) > 0);
	assert.notEqual(h.ops.threadId, h.reads.threadId);
});
