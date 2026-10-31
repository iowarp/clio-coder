import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { telemetryInvalidations } from "../client/telemetry/live-model.js";
import type { Event } from "../contracts/events.js";
import { routes } from "../contracts/routes.js";
import { sessionUpdateTelemetry } from "../server/acp/telemetry.js";
import { harness, json } from "./harness/app.js";
import { coldParityDtos, parityUsageFrame, seedParitySession } from "./harness/telemetry-fixture.js";

test("a telemetry_update names the reads to refresh and folds nothing (#434)", () => {
	assert.deepEqual(telemetryInvalidations({ topics: ["session", "cost"] }), ["telemetry", "session-usage"]);
	assert.deepEqual(telemetryInvalidations({ topics: ["cache", "timeline", "runs"] }), ["telemetry"]);
	assert.deepEqual(telemetryInvalidations({ topics: ["quota", "health"] }), []);
	assert.deepEqual(telemetryInvalidations({ topics: [] }), []);
});

test("the live usage DTO carries the parity fixture's session totals as the read model words them (#434 §13.2)", async (t) => {
	const state = mkdtempSync(join(tmpdir(), "clio-gui-live-parity-"));
	t.after(() => rmSync(state, { recursive: true, force: true }));
	await seedParitySession(state);
	const { tokens, usd } = coldParityDtos(state).session.totals;
	const session = sessionUpdateTelemetry(await parityUsageFrame(state))?.usage?.session;
	assert.ok(session && !("kind" in tokens.fact) && !("kind" in usd.fact));
	assert.equal(session.costDisplay, usd.display);
	// A partly unpriced cost has no amount to show; its words carry what is known.
	assert.equal(session.costProvenance, "unknown");
	assert.equal(session.costUsd, null);
	assert.equal(session.hasEstimatedCost, usd.fact.coverage.estimated > 0);
	assert.equal(session.totalTokens, tokens.fact.measured + tokens.fact.estimated);
	assert.equal(session.missingTokenCalls, tokens.fact.unknownCount);
});

test("a usage_update's unknowns reach the browser as null, never as 0 (R1)", () => {
	const usage = (size: number, session: Record<string, unknown>) =>
		sessionUpdateTelemetry({ sessionUpdate: "usage_update", used: 900, size, _meta: { "clio-coder/usage": { session } } })
			?.usage;
	const counts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 };
	const unknown = usage(0, { ...counts, calls: 2, missingTokenCalls: 2, costUsd: 0, costProvenance: "unknown" });
	assert.equal(unknown?.size, null, "a window the agent does not know");
	assert.equal(unknown?.used, 900);
	assert.equal(unknown?.session?.totalTokens, null, "every counted call reported no usage");
	assert.equal(unknown?.session?.costUsd, null);
	const partial = usage(200_000, {
		...counts,
		totalTokens: 50,
		calls: 2,
		missingTokenCalls: 1,
		costUsd: 0.1,
		costProvenance: "known",
	});
	assert.equal(partial?.size, 200_000);
	assert.equal(partial?.session?.totalTokens, 50, "a partial count stays beside its missing-usage count");
	assert.equal(partial?.session?.costUsd, 0.1);
	assert.equal(usage(1, { ...counts, calls: 0, costUsd: 0, costProvenance: "known" })?.session?.totalTokens, 0);
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
