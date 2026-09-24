import { strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import { writeEvidenceIndexRowQueued } from "../../src/domains/observability/evidence-index.js";
import { createObservabilityBundle } from "../../src/domains/observability/extension.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("footer accountability follows the current session, excluding sibling, foreign, and legacy runs", async () => {
	const home = await isolateClioEnv("clio-session-accountability-");
	try {
		const project = join(home.dir, "project");
		const otherProject = join(home.dir, "other-project");
		mkdirSync(project);
		mkdirSync(otherProject);
		const ledger = openLedger();
		const runs = [
			{ sessionId: "session-a", cwd: project, success: true },
			{ sessionId: "session-b", cwd: project, success: false },
			{ sessionId: "session-c", cwd: otherProject, success: true },
			{ sessionId: null, cwd: project, success: false },
		] as const;
		for (const [index, item] of runs.entries()) {
			const run = ledger.create({
				agentId: `worker-${index}`,
				executionRole: "builder",
				task: "accountability fixture",
				targetId: "local",
				wireModelId: "model",
				runtimeId: "openai",
				runtimeKind: "http",
				sessionId: item.sessionId,
				cwd: item.cwd,
			});
			await writeEvidenceIndexRowQueued(clioStateDir(), {
				runId: run.id,
				evidenceId: `evidence-${index}`,
				tags: [],
				firstPassSuccess: item.success,
				findingCount: 0,
				generatedAt: new Date().toISOString(),
			});
		}
		await ledger.persist();
		let active = "session-a";
		const context = {
			bus: createSafeEventBus(),
			getContract: (name: string) => (name === "session" ? { current: () => ({ id: active }) } : undefined),
		} as unknown as DomainContext;
		const bundle = createObservabilityBundle(context, { dispatchTrace: false });
		await bundle.extension.start();
		const observability = bundle.contract;
		strictEqual(observability.accountability().totalRuns, 1);
		strictEqual(observability.accountability().firstPassRate, 1);
		strictEqual(observability.snapshot().accountability.totalRuns, 1);
		active = "session-b";
		context.bus.emit(BusChannels.SessionResumed, { sessionId: active, via: "resume", at: Date.now() });
		strictEqual(observability.accountability().totalRuns, 1);
		strictEqual(observability.accountability().firstPassRate, 0);
		strictEqual(observability.snapshot().accountability.firstPassRate, 0);
		await bundle.extension.stop?.();
	} finally {
		home.restore();
	}
});
