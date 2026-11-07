import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { QueryClient } from "@tanstack/react-query";
import { createClient } from "../client/api/client.js";
import { subscribe } from "../client/api/events.js";
import { telemetryInvalidations } from "../client/telemetry/live-model.js";
import type { Event } from "../contracts/events.js";
import { routes } from "../contracts/routes.js";
import { sessionUpdateTelemetry } from "../server/acp/telemetry.js";
import { harness, json } from "./harness/app.js";
import { credentialFetch } from "./harness/browser-fetch.js";
import { coldParityDtos, parityUsageFrame, seedParitySession } from "./harness/telemetry-fixture.js";

test("a telemetry_update names the reads to refresh and folds nothing (#434)", () => {
	assert.deepEqual(telemetryInvalidations({ topics: ["session", "cost"] }), ["telemetry", "session-usage"]);
	assert.deepEqual(telemetryInvalidations({ topics: ["cache", "timeline", "runs"] }), ["telemetry"]);
	assert.deepEqual(telemetryInvalidations({ topics: ["quota", "health"] }), []);
	assert.deepEqual(telemetryInvalidations({ topics: [] }), []);
});

test("the browser subscribes to named telemetry updates and invalidates only their session", async (t) => {
	let source: Source | undefined;
	let stop = () => {};
	t.after(() => stop());
	class Source extends EventTarget {
		onerror: (() => void) | null = null;
		constructor() {
			super();
			source = this;
		}
		close() {}
	}
	for (const [name, value] of [
		["EventSource", Source],
		["document", Object.assign(new EventTarget(), { visibilityState: "visible" })],
	] as const) {
		const previous = Object.getOwnPropertyDescriptor(globalThis, name);
		Object.defineProperty(globalThis, name, { configurable: true, value });
		t.after(() => {
			if (previous) Object.defineProperty(globalThis, name, previous);
			else Reflect.deleteProperty(globalThis, name);
		});
	}
	const queries = new QueryClient();
	t.after(() => queries.clear());
	queries.setQueryData(["meta"], { epoch: "epoch-1" });
	queries.setQueryData(["session-overview"], { sessions: [] });
	for (const key of ["telemetry", "session-usage"]) {
		queries.setQueryData([key, "session-1"], {});
		queries.setQueryData([key, "session-2"], {});
	}
	let url = "";
	const client = createClient("token", credentialFetch());
	t.after(() => client.credentials.dispose());
	const eventsUrl = client.eventsUrl;
	client.eventsUrl = async (after) => {
		url = await eventsUrl(after);
		return url;
	};
	stop = subscribe(client, queries, () => {});
	for (let turn = 0; turn < 50 && !source; turn += 1) await setTimeout(1);
	assert.ok(source);
	// The stream opens on a single-use ticket; neither the launch token nor the credential is in the URL.
	assert.equal(url, `/api/events?ticket=${"t".repeat(43)}`);
	const event: Event = {
		v: 1,
		epoch: "epoch-1",
		seq: 1,
		at: new Date().toISOString(),
		type: "telemetry.updated",
		payload: {
			resource: "session-1",
			update: {
				v: 1,
				kind: "telemetry_update",
				sessionId: "session-1",
				seq: 1,
				generatedAt: new Date().toISOString(),
				topics: ["session", "cost"],
			},
		},
	};
	source.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) }));
	for (const key of ["telemetry", "session-usage"]) {
		assert.equal(queries.getQueryState([key, "session-1"])?.isInvalidated, true, key);
		assert.equal(queries.getQueryState([key, "session-2"])?.isInvalidated, false, key);
	}
	const previous = source;
	previous.onerror?.();
	for (let turn = 0; turn < 150 && source === previous; turn += 1) await setTimeout(10);
	assert.notEqual(source, previous);
	assert.ok(source);
	source.dispatchEvent(
		new MessageEvent("hello", {
			data: JSON.stringify({ v: 1, epoch: "epoch-1", seq: 2, at: new Date().toISOString(), type: "hello", payload: {} }),
		}),
	);
	assert.equal(
		queries.getQueryState(["meta"])?.isInvalidated,
		true,
		"reconnect refreshes runtime metadata without polling",
	);
	assert.equal(
		queries.getQueryState(["session-overview"])?.isInvalidated,
		true,
		"reconnect refreshes the live inventory",
	);
});

test("the live usage DTO carries the parity fixture's session totals as the read model words them (#434 §13.2)", async (t) => {
	const state = mkdtempSync(join(tmpdir(), "clio-gui-live-parity-"));
	t.after(() => rmSync(state, { recursive: true, force: true }));
	await seedParitySession(state);
	const { tokens, usd } = coldParityDtos(state).session.totals;
	const session = sessionUpdateTelemetry(await parityUsageFrame(state))?.usage?.session;
	assert.ok(session && !("kind" in tokens.fact) && !("kind" in usd.fact));
	assert.deepEqual(session.totals.tokens, tokens);
	assert.deepEqual(session.totals.usd, usd);
});

test("the agent's telemetry_update reaches the browser as a telemetry.updated event for its session", {
	timeout: 20_000,
}, async (t) => {
	const h = await harness({}, { scenario: "telemetry" });
	t.after(h.close);
	const events: Event[] = [];
	t.after(h.hub.connect(undefined, (event) => events.push(event)));
	const workspace = await json(await h.post("/api/workspaces", { path: h.home.path }), routes.openWorkspace.response);
	const session = await json(
		await h.post(`/api/workspaces/${workspace.id}/sessions`, {}, "new-session"),
		routes.newSession.response,
	);
	const capabilities = await json(
		await h.request(`/api/sessions/${session.id}/capabilities`),
		routes.sessionCapabilities.response,
	);
	assert.equal(capabilities.telemetry?.update, "_clio-coder/telemetry/update");
	await h.post(`/api/sessions/${session.id}/turns`, { text: "Hello" }, "prompt");
	const updated = () => events.find((event) => event.type === "telemetry.updated");
	for (let i = 0; i < 200 && !updated(); i++) await setTimeout(25);
	const event = updated();
	assert.ok(event && event.type === "telemetry.updated", "telemetry.updated arrived");
	assert.equal(event.payload.resource, session.id);
	assert.deepEqual(event.payload.update.topics, ["session", "cost"]);
	assert.equal(event.payload.update.sessionId, session.id);
});
