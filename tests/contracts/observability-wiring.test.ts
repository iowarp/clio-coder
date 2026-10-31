/**
 * Telemetry facts whose writer and reader disagreed: a failed or aborted
 * prewarm was read back as a zero-cost success.
 */
import { deepStrictEqual, equal } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import {
	createChatTurnUsage,
	createTurnObservations,
	subscribeExtensionObservations,
} from "../../src/domains/extensions/bus-observations.js";
import type { ExtensionObservationV2 } from "../../src/domains/extensions/public-api-v2.js";

const scratch = mkdtempSync(join(tmpdir(), "clio-coder-telemetry-wiring-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe("turn observations", () => {
	it("sends a turn's provider-reported usage as turn_end, never an aborted call's display estimate", () => {
		const observations: ExtensionObservationV2[] = [];
		const turns = createTurnObservations((observation) => observations.push(observation));
		const usage = createChatTurnUsage();
		const settled = (message: Record<string, unknown>) => usage.observe({ type: "message_end", message });
		usage.observe({ type: "agent_start" });
		settled({ role: "assistant", model: "m", stopReason: "toolUse", usage: { input: 100, output: 20, cacheRead: 5 } });
		settled({ role: "toolResult", usage: { input: 999 } });
		// An interrupted call keeps the provider's zeros.
		settled({
			role: "assistant",
			model: "m",
			stopReason: "aborted",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		// The terminal reads the fold and takes how the turn ended from its own summary.
		turns.turnEnd({ ...usage.current(), modelId: "m", targetId: "t", stopReason: "cancelled" });
		const end = observations.at(-1);
		deepStrictEqual(end?.event === "turn_end" ? end.usage : null, {
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 5,
			cacheWriteTokens: 0,
			costUsd: null,
			model: "m",
			target: "t",
		});
		equal(end?.event === "turn_end" ? end.outcome : null, "aborted");
		usage.observe({ type: "agent_start" });
		deepStrictEqual(usage.current(), {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			modelId: "",
			stopReason: "completed",
		});
	});
});

describe("compaction observations", () => {
	it("maps terminal outcomes and keeps unreported legacy outcomes unknown", () => {
		const bus = createTelemetryHub();
		const observations: ExtensionObservationV2[] = [];
		const unsubscribe = subscribeExtensionObservations(bus, (observation) => observations.push(observation));
		for (const outcome of ["completed", "unchanged", "failed", "cancelled", undefined] as const)
			bus.emit("compaction.ended", { trigger: "force", at: 0, ...(outcome === undefined ? {} : { outcome }) });
		deepStrictEqual(
			observations.map((observation) => (observation.event === "compaction_end" ? observation.outcome : null)),
			["ok", "ok", "failed", "failed", "unknown"],
		);
		unsubscribe();
	});
});
