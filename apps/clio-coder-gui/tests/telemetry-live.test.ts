import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { QueryClient } from "@tanstack/react-query";
import { createClient } from "../client/api/client.js";
import { subscribe } from "../client/api/events.js";
import { TELEMETRY_REFRESH_MS, telemetryInvalidations, telemetryRefresh } from "../client/telemetry/live-model.js";
import type { Event } from "../contracts/events.js";
import { routes } from "../contracts/routes.js";
import type { SessionDelta } from "../contracts/sessions.js";
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

test("named telemetry updates refresh their session and operator windows, not other session reads", async (t) => {
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
	queries.setQueryData(["operator-metrics", ""], {});
	queries.setQueryData(["operator-metrics", "workspace-1"], {});
	for (const key of ["telemetry", "session-usage"]) {
		queries.setQueryData([key, "session-1"], {});
		queries.setQueryData([key, "session-2"], {});
	}
	let url = "";
	const client = createClient({ ticket: "ticket" }, credentialFetch());
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
	for (const workspace of ["", "workspace-1"])
		assert.equal(queries.getQueryState(["operator-metrics", workspace])?.isInvalidated, true);
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

test("a session's pushed telemetry refreshes now, then at most once per interval", () => {
	assert.deepEqual(telemetryRefresh(5_000, undefined), { refresh: "now" });
	assert.deepEqual(telemetryRefresh(5_200, 5_000), { refresh: "defer", delayMs: TELEMETRY_REFRESH_MS - 200 });
	assert.deepEqual(telemetryRefresh(5_000 + TELEMETRY_REFRESH_MS, 5_000), { refresh: "now" });
	assert.deepEqual(telemetryRefresh(9_000, 5_000), { refresh: "now" });
});

/** Opens a subscription on a fake event stream and returns a way to deliver frames to it. */
async function liveStream(t: TestContext, queries: QueryClient, timers?: Parameters<typeof subscribe>[5]) {
	// After-hooks run in registration order; the dispose touches `document`, so it must run before the globals go.
	let stop = () => {};
	t.after(() => stop());
	let source: EventTarget | undefined;
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
	const client = createClient({ ticket: "ticket" }, credentialFetch());
	t.after(() => client.credentials.dispose());
	stop = subscribe(client, queries, () => {}, undefined, undefined, timers);
	for (let turn = 0; turn < 50 && !source; turn += 1) await setTimeout(1);
	const opened = source;
	assert.ok(opened);
	let seq = 0;
	return {
		deliver(event: { type: string; payload: unknown }) {
			seq += 1;
			const frame = { v: 1, epoch: "epoch-live", seq, at: new Date().toISOString(), ...event };
			opened.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(frame) }));
		},
		raw(type: string, data: string) {
			opened.dispatchEvent(new MessageEvent(type, { data, lastEventId: "epoch-live:99" }));
		},
	};
}

const finishedTurn = (resource: string, revision: number): SessionDelta => ({
	type: "turn.finished",
	payload: {
		resource,
		revision,
		turnId: "turn-1",
		stopReason: "end_turn",
		usage: null,
		problem: null,
		finishedAt: null,
	},
});
const telemetryUpdate = (resource: string, seq: number) => ({
	type: "telemetry.updated",
	payload: {
		resource,
		update: {
			v: 1,
			kind: "telemetry_update",
			sessionId: resource,
			seq,
			generatedAt: new Date().toISOString(),
			topics: ["session", "cost"],
		},
	},
});

test("only a label or a task leaving the held set refreshes the saved-task list", async (t) => {
	const queries = new QueryClient();
	t.after(() => queries.clear());
	const stream = await liveStream(t, queries);
	const settle = () => {
		queries.setQueryData(["sessions"], []);
		queries.setQueryData(["session-history", "workspace-1"], []);
	};
	const history = () => queries.getQueryState(["session-history", "workspace-1"])?.isInvalidated;
	settle();
	stream.deliver(finishedTurn("history-session", 1));
	assert.equal(queries.getQueryState(["sessions"])?.isInvalidated, true, "a finished turn refreshes the live list");
	assert.equal(history(), false, "a finished turn in an open task leaves the saved-task list alone");
	const changed = (revision: number, state: "open" | "parked" | "closed", recoveredOrphan: boolean): SessionDelta => ({
		type: "session.changed",
		payload: { resource: "history-session", revision, state, recoveredOrphan },
	});
	for (const [revision, state] of [
		[2, "open"],
		[3, "parked"],
	] as const) {
		settle();
		stream.deliver(changed(revision, state, false));
		assert.equal(history(), false, state);
	}
	settle();
	stream.deliver(changed(4, "closed", false));
	assert.equal(history(), true, "a closed task returns to the saved-task list");
	settle();
	stream.deliver(changed(5, "open", true));
	assert.equal(history(), true, "a recovered orphan refreshes the saved-task list");
	settle();
	stream.deliver({ type: "session.labelled", payload: { resource: "history-session", revision: 6, label: "Renamed" } });
	assert.equal(history(), true, "a rename refreshes the saved-task list");
});

test("a burst of telemetry pushes refreshes a session's reads at most once per interval", async (t) => {
	let now = 0;
	const scheduled: { run: () => void; ms: number; cancelled: boolean }[] = [];
	const timers = {
		now: () => now,
		schedule(run: () => void, ms: number) {
			const entry = { run, ms, cancelled: false };
			scheduled.push(entry);
			return () => {
				entry.cancelled = true;
			};
		},
	};
	const queries = new QueryClient();
	t.after(() => queries.clear());
	const invalidated = t.mock.method(queries, "invalidateQueries");
	const cancelled = t.mock.method(queries, "cancelQueries");
	const stream = await liveStream(t, queries, timers);
	const reads = (key: string, calls: readonly { arguments: readonly unknown[] }[]) => {
		const wanted = JSON.stringify(key === "operator-metrics" ? [key] : [key, "burst"]);
		return calls.filter((call) => JSON.stringify((call.arguments[0] as { queryKey?: unknown })?.queryKey) === wanted)
			.length;
	};
	for (let push = 0; push < 10; push += 1) {
		now = push * 100;
		stream.deliver(telemetryUpdate("burst", push + 1));
	}
	assert.equal(reads("session-usage", invalidated.mock.calls), 1, "the first push refreshes at once");
	assert.equal(scheduled.length, 1, "later pushes share one trailing refresh");
	assert.equal(scheduled[0]?.ms, TELEMETRY_REFRESH_MS - 100);
	now = TELEMETRY_REFRESH_MS;
	scheduled[0]?.run();
	assert.equal(reads("session-usage", invalidated.mock.calls), 2, "ten pushes in one second make two reads");
	assert.equal(reads("telemetry", invalidated.mock.calls), 2);
	assert.equal(reads("operator-metrics", invalidated.mock.calls), 2, "the operator window follows the same throttle");
	now += 100;
	stream.deliver(telemetryUpdate("burst", 11));
	assert.equal(reads("session-usage", invalidated.mock.calls), 2, "a push inside the interval waits");
	assert.equal(scheduled.length, 2);
	now += 100;
	stream.deliver(finishedTurn("burst", 1));
	assert.equal(reads("session-usage", invalidated.mock.calls), 3, "the finished turn flushes what was waiting");
	assert.equal(scheduled[1]?.cancelled, true, "the flush retires the trailing refresh");
	now += 100;
	stream.deliver(finishedTurn("burst", 2));
	assert.equal(reads("session-usage", invalidated.mock.calls), 3, "nothing waiting, nothing more to read");
	assert.equal(reads("session-usage", cancelled.mock.calls), 0, "a throttled read is never cancelled and restarted");
});

test("a malformed event frame is skipped and the stream carries on", async (t) => {
	const queries = new QueryClient();
	t.after(() => queries.clear());
	const errors = t.mock.method(console, "error", () => {});
	const stream = await liveStream(t, queries);
	queries.setQueryData(["session-history", "workspace-1"], []);
	stream.raw("session.labelled", '{"secret-payload":');
	assert.equal(errors.mock.callCount(), 1);
	const logged = String(errors.mock.calls[0]?.arguments[0]);
	assert.match(logged, /session\.labelled/);
	assert.doesNotMatch(logged, /secret-payload/);
	assert.equal(queries.getQueryState(["session-history", "workspace-1"])?.isInvalidated, false);
	stream.deliver({ type: "session.labelled", payload: { resource: "malformed-session", revision: 1, label: "Next" } });
	assert.equal(queries.getQueryState(["session-history", "workspace-1"])?.isInvalidated, true, "the next frame applies");
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
