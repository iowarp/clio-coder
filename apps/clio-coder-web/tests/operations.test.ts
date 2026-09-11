import assert from "node:assert/strict";
import { test } from "node:test";
import { EventHub } from "../server/services/event-hub.js";
import { fingerprint, OperationRegistry } from "../server/services/operations.js";
import { terminal } from "./harness/app.js";

test("canonical fingerprints, bounded progress, terminal retention and live-operation protection", async () => {
	assert.equal(fingerprint({ b: true, a: { y: 2, x: 1 } }), fingerprint({ a: { x: 1, y: 2 }, b: true }));
	const registry = new OperationRegistry(new EventHub());
	let release: (value: { id: string; message: string }) => void = () => {};
	const live = registry.create({
		kind: "install",
		scope: "installation",
		key: "live",
		fingerprint: "one",
		run: () =>
			new Promise((resolve) => {
				release = resolve;
			}),
	});
	const noisy = registry.create({
		kind: "install",
		scope: "installation",
		key: "noisy",
		fingerprint: "two",
		run: async (progress) => {
			for (let i = 0; i < 400; i++) progress(`line ${i} ${"é".repeat(500)}`);
			return { id: "herdr", message: "done" };
		},
	});
	const record = await terminal(registry, noisy);
	assert.ok(record.progress.length <= 256);
	assert.ok(Buffer.byteLength(JSON.stringify(record.progress)) <= 65536);
	assert.match(record.progress[0]?.message ?? "", /earlier lines omitted/);
	assert.match(record.progress.at(-1)?.message ?? "", /line 399/);
	let last = "";
	for (let i = 0; i < 260; i++)
		last = registry.create({
			kind: "install",
			scope: "installation",
			key: String(i),
			fingerprint: String(i),
			run: async () => ({ id: "herdr", message: "done" }),
		});
	await terminal(registry, last);
	assert.equal(registry.get(live).status, "running");
	assert.throws(() => registry.get(noisy), /no longer retained/);
	// Keep idempotency tombstones for the epoch even after the terminal snapshot is evicted.
	assert.equal(
		registry.create({
			kind: "install",
			scope: "installation",
			key: "noisy",
			fingerprint: "two",
			run: async () => {
				throw new Error("must not run");
			},
		}),
		noisy,
	);
	release({ id: "herdr", message: "done" });
	await terminal(registry, live);
});

test("large operation inventories use REST snapshots and byte-bounded terminal retention", async () => {
	const hub = new EventHub(),
		registry = new OperationRegistry(hub);
	const events: import("../contracts/events.js").Event[] = [];
	const disconnect = hub.connect(undefined, (event) => events.push(event));
	let first = "",
		last = "";
	for (let i = 0; i < 34; i++) {
		last = registry.create({
			kind: "inventory",
			scope: "test",
			key: String(i),
			fingerprint: String(i),
			run: async () => ({ id: "fixture", message: "x".repeat(512 * 1024) }),
		});
		first ||= last;
		await terminal(registry, last);
	}
	assert.throws(() => registry.get(first), /no longer retained/);
	const record = registry.get(last);
	assert.ok(record.status === "succeeded" && record.result.message.length === 512 * 1024);
	assert.ok(events.filter((event) => event.type === "operation.finished").every((event) => !event.payload.operation));
	assert.ok(hub.byteSize < 16_000);
	disconnect();
});
