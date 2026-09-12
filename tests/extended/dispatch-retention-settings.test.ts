import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { runClioRun } from "../../src/cli/run.js";
import { updateSettings } from "../../src/core/config.js";
import { loadDomains } from "../../src/core/domain-loader.js";
import { configureGuardrails } from "../../src/core/guardrails.js";
import { AgentsDomainModule } from "../../src/domains/agents/index.js";
import { type ConfigContract, ConfigDomainModule } from "../../src/domains/config/index.js";
import { createDispatchDomainModule, type DispatchContract } from "../../src/domains/dispatch/index.js";
import { type Ledger, openLedger } from "../../src/domains/dispatch/state.js";
import { ensureClioState } from "../../src/domains/lifecycle/index.js";
import { MiddlewareDomainModule } from "../../src/domains/middleware/index.js";
import { ObservabilityDomainModule } from "../../src/domains/observability/index.js";
import { createPromptsDomainModule } from "../../src/domains/prompts/index.js";
import { ProvidersDomainModule } from "../../src/domains/providers/index.js";
import { ResourcesDomainModule } from "../../src/domains/resources/index.js";
import { SafetyDomainModule } from "../../src/domains/safety/index.js";
import { SchedulingDomainModule } from "../../src/domains/scheduling/index.js";
import { SessionDomainModule } from "../../src/domains/session/index.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

let scratch: IsolatedClioEnv;
let originalCwd: string;
beforeEach(async () => {
	scratch = await isolateClioEnv("clio-coder-retention-settings-");
	originalCwd = process.cwd();
	const cwd = join(scratch.dir, "workspace");
	mkdirSync(cwd);
	process.chdir(cwd);
	ensureClioState();
});
afterEach(() => {
	configureGuardrails(undefined);
	process.chdir(originalCwd);
	scratch.restore();
});

function addRun(ledger: Ledger, id: string, finished = true): void {
	const run = ledger.create({
		id,
		agentId: "coder",
		executionRole: "builder",
		task: "retention fixture",
		targetId: "local",
		wireModelId: "fixture",
		runtimeId: "openai",
		runtimeKind: "http",
		sessionId: null,
		cwd: process.cwd(),
	});
	if (finished) ledger.update(run.id, { status: "completed", endedAt: new Date().toISOString(), exitCode: 0 });
}

test("headless CLI retention honors saved settings even when dispatch is rejected", async () => {
	updateSettings((settings) => {
		settings.fleet.history.maxRuns = 2;
	});
	const seed = openLedger({ maxRuns: 10 });
	for (const id of ["first", "second", "third"]) addRun(seed, id);
	await seed.persist();
	strictEqual(await runClioRun(["--agent", "missing-fixture", "audit"], { noContextFiles: true }), 2);
	strictEqual(openLedger().list().length, 2);
});

test("an open dispatch ledger follows config updates and effective session overrides", async () => {
	let override: ReturnType<ConfigContract["get"]> | undefined;
	const loaded = await loadDomains([
		ConfigDomainModule,
		ResourcesDomainModule,
		ProvidersDomainModule,
		SafetyDomainModule,
		AgentsDomainModule,
		createPromptsDomainModule({ noContextFiles: true }),
		MiddlewareDomainModule,
		SessionDomainModule,
		ObservabilityDomainModule,
		SchedulingDomainModule,
		createDispatchDomainModule({ getSettings: () => override }),
	]);
	try {
		const config = loaded.getContract<ConfigContract>("config");
		const dispatch = loaded.getContract<DispatchContract>("dispatch");
		ok(config?.update && dispatch);
		const seed = openLedger({ maxRuns: 10 });
		for (const id of ["first", "second", "third"]) addRun(seed, id);
		await seed.persist();
		config.update((settings) => {
			settings.fleet.history.maxRuns = 2;
		});
		await dispatch.drain();
		strictEqual(openLedger().list().length, 2);
		override = structuredClone(config.get());
		override.fleet.history.maxRuns = 1;
		await dispatch.drain();
		strictEqual(openLedger().list().length, 1);
	} finally {
		await loaded.stop();
	}
});

test("default ledger limits remain live while explicit limits and live-run protection hold", async () => {
	configureGuardrails({ maxDispatchRuns: 1 });
	const ledger = openLedger();
	addRun(ledger, "first");
	addRun(ledger, "second");
	addRun(ledger, "live", false);
	configureGuardrails({ maxDispatchRuns: 3 });
	await ledger.persist();
	strictEqual(openLedger().list().length, 3);
	const fixed = openLedger({ maxRuns: 3 });
	configureGuardrails({ maxDispatchRuns: 1 });
	await fixed.persist();
	strictEqual(openLedger().list().length, 3, "an explicit numeric limit remains authoritative");
	await ledger.persist();
	deepStrictEqual(
		openLedger()
			.list()
			.map((run) => run.id),
		["live"],
	);
});
