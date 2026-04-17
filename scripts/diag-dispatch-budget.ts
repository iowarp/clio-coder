/**
 * Phase 10 diag. End-to-end check that scheduling.preflight() actually gates
 * dispatch admission on the session budget ceiling. Two scenarios:
 *
 *  1. ceiling = 0.00 USD + non-zero session cost => dispatch() must reject with
 *     the "budget ceiling crossed" admission error.
 *  2. ceiling = 1000 USD + the same session cost => dispatch() must succeed.
 *
 * The worker is the pi-ai faux provider (same shape as scripts/diag-dispatch.ts),
 * so the gate is exercised against the real domain graph rather than a mock.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-dispatch-budget] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-dispatch-budget] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

const ENV_KEYS = [
	"CLIO_HOME",
	"CLIO_DATA_DIR",
	"CLIO_CONFIG_DIR",
	"CLIO_CACHE_DIR",
	"CLIO_WORKER_FAUX",
	"CLIO_WORKER_FAUX_MODEL",
	"CLIO_WORKER_FAUX_TEXT",
] as const;

async function withHarness(
	ceilingUsd: number,
	body: (ctx: {
		dispatch: import("../src/domains/dispatch/contract.js").DispatchContract;
		obs: import("../src/domains/observability/contract.js").ObservabilityContract;
		sched: import("../src/domains/scheduling/contract.js").SchedulingContract;
	}) => Promise<void>,
): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "clio-diag-dispatch-budget-"));
	const snapshot = new Map<string, string | undefined>();
	for (const k of ENV_KEYS) snapshot.set(k, process.env[k]);
	for (const k of ["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const) {
		delete process.env[k];
	}
	process.env.CLIO_HOME = home;
	process.env.CLIO_WORKER_FAUX = "1";
	process.env.CLIO_WORKER_FAUX_MODEL = "faux-model";
	process.env.CLIO_WORKER_FAUX_TEXT = "hello from faux worker";

	// Seed settings.yaml so config reads our ceiling (merge into defaults).
	writeFileSync(
		join(home, "settings.yaml"),
		`budget:\n  sessionCeilingUsd: ${ceilingUsd}\n  concurrency: auto\n`,
		"utf8",
	);

	try {
		const { resetXdgCache } = await import("../src/core/xdg.js");
		resetXdgCache();
		const { resetPackageRootCache } = await import("../src/core/package-root.js");
		resetPackageRootCache();
		const { resetSharedBus } = await import("../src/core/shared-bus.js");
		resetSharedBus();

		const { loadDomains } = await import("../src/core/domain-loader.js");
		const { ConfigDomainModule } = await import("../src/domains/config/index.js");
		const { ProvidersDomainModule } = await import("../src/domains/providers/index.js");
		const { SafetyDomainModule } = await import("../src/domains/safety/index.js");
		const { ModesDomainModule } = await import("../src/domains/modes/index.js");
		const { PromptsDomainModule } = await import("../src/domains/prompts/index.js");
		const { AgentsDomainModule } = await import("../src/domains/agents/index.js");
		const { DispatchDomainModule } = await import("../src/domains/dispatch/index.js");
		const { SessionDomainModule } = await import("../src/domains/session/index.js");
		const { ObservabilityDomainModule } = await import("../src/domains/observability/index.js");
		const { SchedulingDomainModule } = await import("../src/domains/scheduling/index.js");

		const loaded = await loadDomains([
			ConfigDomainModule,
			ProvidersDomainModule,
			SafetyDomainModule,
			ModesDomainModule,
			PromptsDomainModule,
			AgentsDomainModule,
			SessionDomainModule,
			ObservabilityDomainModule,
			SchedulingDomainModule,
			DispatchDomainModule,
		]);

		type DispatchContractType = import("../src/domains/dispatch/contract.js").DispatchContract;
		type ObservabilityContractType = import("../src/domains/observability/contract.js").ObservabilityContract;
		type SchedulingContractType = import("../src/domains/scheduling/contract.js").SchedulingContract;
		const dispatch = loaded.getContract<DispatchContractType>("dispatch");
		const obs = loaded.getContract<ObservabilityContractType>("observability");
		const sched = loaded.getContract<SchedulingContractType>("scheduling");
		if (!dispatch || !obs || !sched) {
			check("domain:contracts-exposed", false, "missing dispatch/observability/scheduling contract");
			await loaded.stop();
			return;
		}

		await body({ dispatch, obs, sched });
		await loaded.stop();
	} finally {
		for (const [k, v] of snapshot) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}
}

async function run(): Promise<void> {
	const projectRoot = process.cwd();
	const workerJs = join(projectRoot, "dist/worker/entry.js");
	if (!existsSync(workerJs)) {
		process.stdout.write("[diag-dispatch-budget] building dist/ ...\n");
		execFileSync("npm", ["run", "build"], { stdio: "inherit", cwd: projectRoot });
	}
	if (!existsSync(workerJs)) {
		process.stderr.write(`[diag-dispatch-budget] build did not produce ${workerJs}\n`);
		process.exit(1);
	}

	// --- Scenario 1: ceiling crossed -> dispatch must refuse -----------------
	await withHarness(0, async ({ dispatch, obs, sched }) => {
		check("scenario1:ceiling-zero", sched.ceilingUsd() === 0, `ceiling=${sched.ceilingUsd()}`);
		// Drive session cost above zero.
		obs.recordTokens("anthropic", "claude-sonnet-4-6", 10_000);
		check("scenario1:session-cost-positive", obs.sessionCost() > 0, `cost=${obs.sessionCost()}`);

		const preflight = sched.preflight();
		check(
			"scenario1:preflight-over",
			preflight.verdict === "over",
			`verdict=${preflight.verdict} current=${preflight.currentUsd} ceiling=${preflight.ceilingUsd}`,
		);

		let caught: unknown = null;
		try {
			await dispatch.dispatch({
				agentId: "scout",
				task: "should be gated",
				providerId: "faux",
				modelId: "faux-model",
			});
		} catch (err) {
			caught = err;
		}
		const msg = caught instanceof Error ? caught.message : String(caught);
		check("scenario1:dispatch-rejects", caught !== null, "dispatch() resolved instead of throwing");
		check(
			"scenario1:error-mentions-budget",
			typeof msg === "string" && msg.includes("budget ceiling crossed"),
			`message=${msg}`,
		);
		check("scenario1:no-run-created", dispatch.listRuns().length === 0, `runs=${dispatch.listRuns().length}`);
	});

	// --- Scenario 2: generous ceiling -> dispatch succeeds -------------------
	await withHarness(1000, async ({ dispatch, obs, sched }) => {
		check("scenario2:ceiling-high", sched.ceilingUsd() === 1000, `ceiling=${sched.ceilingUsd()}`);
		obs.recordTokens("anthropic", "claude-sonnet-4-6", 10_000);
		const preflight = sched.preflight();
		check("scenario2:preflight-under", preflight.verdict === "under", `verdict=${preflight.verdict}`);

		const res = await dispatch.dispatch({
			agentId: "scout",
			task: "should pass",
			providerId: "faux",
			modelId: "faux-model",
		});
		// Drain worker events so the child exits and finalPromise resolves.
		for await (const _ev of res.events) {
			// discard
		}
		const receipt = await res.finalPromise;
		check("scenario2:dispatch-completed", receipt.exitCode === 0, `exit=${receipt.exitCode}`);
	});
}

async function main(): Promise<void> {
	await run();
	if (failures.length > 0) {
		process.stderr.write(`[diag-dispatch-budget] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-dispatch-budget] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-dispatch-budget] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
