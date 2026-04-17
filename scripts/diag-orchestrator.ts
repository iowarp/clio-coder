/**
 * Phase 6 slice 7 diag. Boots the full orchestrator domain stack in-process
 * (no CLI subprocess) and asserts:
 *   - all 9 domains load (config, providers, safety, modes, prompts, agents,
 *     dispatch, session, lifecycle).
 *   - the topological order is respected (dependencies precede dependents).
 *   - a shutdown driven through the termination coordinator runs the four
 *     DRAIN -> TERMINATE -> PERSIST -> EXIT phases within 5s.
 *
 * The coordinator calls process.exit() at the tail of the EXIT phase, so we
 * swap process.exit with a throw-based sentinel for the duration of the
 * shutdown call and catch it to measure the elapsed budget without terminating
 * the diag.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-orchestrator] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-orchestrator] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

const EXPECTED_DOMAINS = [
	"config",
	"providers",
	"safety",
	"modes",
	"prompts",
	"agents",
	"dispatch",
	"session",
	"lifecycle",
];

async function main(): Promise<void> {
	const projectRoot = process.cwd();
	const workerJs = join(projectRoot, "dist/worker/entry.js");
	if (!existsSync(workerJs)) {
		process.stdout.write("[diag-orchestrator] building dist/ ...\n");
		execFileSync("npm", ["run", "build"], { stdio: "inherit", cwd: projectRoot });
	}
	if (!existsSync(workerJs)) {
		process.stderr.write(`[diag-orchestrator] build did not produce ${workerJs}\n`);
		process.exit(1);
	}

	const home = mkdtempSync(join(tmpdir(), "clio-diag-orchestrator-"));
	const ENV_KEYS = ["CLIO_HOME", "CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const;
	const snapshot = new Map<string, string | undefined>();
	for (const k of ENV_KEYS) snapshot.set(k, process.env[k]);
	for (const k of ["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const) {
		delete process.env[k];
	}
	process.env.CLIO_HOME = home;

	try {
		const { resetXdgCache } = await import("../src/core/xdg.js");
		resetXdgCache();
		const { resetSharedBus, getSharedBus } = await import("../src/core/shared-bus.js");
		resetSharedBus();
		const { resetPackageRootCache } = await import("../src/core/package-root.js");
		resetPackageRootCache();
		const { resetTerminationCoordinator, getTerminationCoordinator } = await import("../src/core/termination.js");
		resetTerminationCoordinator();

		const { loadDomains } = await import("../src/core/domain-loader.js");
		const { BusChannels } = await import("../src/core/bus-events.js");
		const { ConfigDomainModule } = await import("../src/domains/config/index.js");
		const { ProvidersDomainModule } = await import("../src/domains/providers/index.js");
		const { SafetyDomainModule } = await import("../src/domains/safety/index.js");
		const { ModesDomainModule } = await import("../src/domains/modes/index.js");
		const { PromptsDomainModule } = await import("../src/domains/prompts/index.js");
		const { AgentsDomainModule } = await import("../src/domains/agents/index.js");
		const { DispatchDomainModule } = await import("../src/domains/dispatch/index.js");
		const { SessionDomainModule } = await import("../src/domains/session/index.js");
		const { LifecycleDomainModule } = await import("../src/domains/lifecycle/index.js");

		type DispatchContractType = import("../src/domains/dispatch/contract.js").DispatchContract;

		const bus = getSharedBus();
		const termination = getTerminationCoordinator();

		const loadOrder: string[] = [];
		bus.on(BusChannels.DomainLoaded, (ev) => {
			const name = (ev as { name?: string } | undefined)?.name;
			if (typeof name === "string") loadOrder.push(name);
		});

		const shutdownPhases: string[] = [];
		bus.on(BusChannels.ShutdownRequested, () => shutdownPhases.push("requested"));
		bus.on(BusChannels.ShutdownDrained, () => shutdownPhases.push("drained"));
		bus.on(BusChannels.ShutdownTerminated, () => shutdownPhases.push("terminated"));
		bus.on(BusChannels.ShutdownPersisted, () => shutdownPhases.push("persisted"));
		let sessionEndFired = false;
		bus.on(BusChannels.SessionEnd, () => {
			sessionEndFired = true;
		});

		const loaded = await loadDomains([
			ConfigDomainModule,
			ProvidersDomainModule,
			SafetyDomainModule,
			ModesDomainModule,
			PromptsDomainModule,
			AgentsDomainModule,
			DispatchDomainModule,
			SessionDomainModule,
			LifecycleDomainModule,
		]);

		for (const name of EXPECTED_DOMAINS) {
			check(`domain:${name}-loaded`, loaded.loaded.includes(name), `loaded=${loaded.loaded.join(",")}`);
		}
		check(
			"domain:count-matches",
			loaded.loaded.length === EXPECTED_DOMAINS.length,
			`got=${loaded.loaded.length} expected=${EXPECTED_DOMAINS.length}`,
		);

		// Topo assertions: every dependency must appear before its dependent in loadOrder.
		const depsByName: Record<string, ReadonlyArray<string>> = {
			config: [],
			providers: ["config"],
			safety: ["config"],
			modes: ["config", "safety"],
			prompts: ["config", "modes"],
			agents: ["config", "modes"],
			dispatch: ["config", "safety", "modes", "agents", "providers"],
			session: ["config", "modes"],
			lifecycle: ["config"],
		};
		for (const [dependent, deps] of Object.entries(depsByName)) {
			const dependentIdx = loadOrder.indexOf(dependent);
			for (const dep of deps) {
				const depIdx = loadOrder.indexOf(dep);
				check(
					`topo:${dep}-before-${dependent}`,
					depIdx >= 0 && dependentIdx >= 0 && depIdx < dependentIdx,
					`order=${loadOrder.join(",")}`,
				);
			}
		}

		// Wire dispatch into the termination coordinator same as the orchestrator entry does.
		const dispatch = loaded.getContract<DispatchContractType>("dispatch");
		if (dispatch) {
			termination.onDrain(async () => {
				await dispatch.drain();
			});
		}
		termination.onPersist(async () => {
			await loaded.stop();
		});

		// Stub process.exit so termination.shutdown doesn't kill the diag.
		const SENTINEL = Symbol("diag-orchestrator-exit-sentinel");
		const originalExit = process.exit;
		let exitCodeSeen: number | null = null;
		const stubbedExit = ((code?: number | string | null): never => {
			exitCodeSeen = typeof code === "number" ? code : 0;
			throw SENTINEL;
		}) as typeof process.exit;
		process.exit = stubbedExit;

		const shutdownStart = Date.now();
		try {
			await termination.shutdown(0);
		} catch (err) {
			if (err !== SENTINEL) {
				process.exit = originalExit;
				throw err;
			}
		} finally {
			process.exit = originalExit;
		}
		const shutdownElapsedMs = Date.now() - shutdownStart;

		check("shutdown:under-5s", shutdownElapsedMs < 5000, `elapsed=${shutdownElapsedMs}ms`);
		check(
			"shutdown:phases-in-order",
			shutdownPhases.join(",") === "requested,drained,terminated,persisted",
			`phases=${shutdownPhases.join(",")}`,
		);
		check("shutdown:session-end-fired", sessionEndFired);
		check("shutdown:exit-code-captured", exitCodeSeen === 0, `exitCode=${exitCodeSeen}`);
		check("shutdown:coordinator-phase-exiting", termination.getPhase() === "exiting", `phase=${termination.getPhase()}`);
	} finally {
		for (const [k, v] of snapshot) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}

	if (failures.length > 0) {
		process.stderr.write(`[diag-orchestrator] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-orchestrator] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-orchestrator] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
