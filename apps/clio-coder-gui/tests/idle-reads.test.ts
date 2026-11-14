import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "../client/api/client.js";
import { afterStreamHello, releaseStreamReads } from "../client/api/stream-gate.js";
import { QUEUE_POLL_MS, queuePollInterval } from "../client/chat/queue-poll-model.js";

const empty = { steer: [], followUp: [] };

test("an idle, empty queue is not polled; activity or waiting entries resume polling", () => {
	assert.equal(queuePollInterval(true, false, false, empty), false);
	assert.equal(queuePollInterval(true, false, false, undefined), false);
	assert.equal(queuePollInterval(true, false, true, empty), QUEUE_POLL_MS);
	assert.equal(queuePollInterval(true, false, false, { steer: [], followUp: ["next"] }), QUEUE_POLL_MS);
	assert.equal(queuePollInterval(true, true, true, { steer: ["now"], followUp: [] }), false, "push replaces polling");
	assert.equal(queuePollInterval(false, false, true, empty), false);
});

test("an overview read waits for the event stream's hello, then reads at once", async () => {
	const client = createClient({ ticket: "gate-ticket" });
	assert.equal(client.signedIn, true);
	let read = false;
	const waiting = afterStreamHello(client).then(() => {
		read = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(read, false, "the read is held before the stream opens");
	releaseStreamReads(client);
	await waiting;
	assert.equal(read, true);
	await afterStreamHello(client);
});

test("a held read that the hello cancels never proceeds to the network", async () => {
	const client = createClient({ ticket: "gate-ticket" });
	const controller = new AbortController();
	const waiting = afterStreamHello(client, controller.signal);
	controller.abort(new Error("superseded"));
	await assert.rejects(waiting, /superseded/);
});

test("a document without credentials reads without waiting", async () => {
	const client = createClient({});
	assert.equal(client.signedIn, false);
	await afterStreamHello(client);
});
