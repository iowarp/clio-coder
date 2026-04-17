/**
 * Phase 6 slice 5 diag. Exercises the wired DispatchDomainModule end-to-end
 * against a hermetic CLIO_HOME with the pi-ai faux provider. Validates that:
 *   - dispatch() spawns a worker, emits dispatch.enqueued + dispatch.started,
 *     streams NDJSON events back through the returned async iterator, and
 *     resolves finalPromise to a shape-checked RunReceipt.
 *   - The ledger reports the run as completed, the state file on disk reflects
 *     it, and a per-run receipt file was written under receipts/.
 *   - A second dispatch that is aborted immediately resolves to status
 *     "interrupted".
 *   - drain() returns cleanly when no runs remain in flight.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-dispatch] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-dispatch] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function run(): Promise<void> {
	const projectRoot = process.cwd();
	const workerJs = join(projectRoot, "dist/worker/entry.js");
	if (!existsSync(workerJs)) {
		process.stdout.write("[diag-dispatch] building dist/ ...\n");
		execFileSync("npm", ["run", "build"], { stdio: "inherit", cwd: projectRoot });
	}
	if (!existsSync(workerJs)) {
		process.stderr.write(`[diag-dispatch] build did not produce ${workerJs}\n`);
		process.exit(1);
	}

	const home = mkdtempSync(join(tmpdir(), "clio-diag-dispatch-"));
	const ENV_KEYS = [
		"CLIO_HOME",
		"CLIO_DATA_DIR",
		"CLIO_CONFIG_DIR",
		"CLIO_CACHE_DIR",
		"CLIO_WORKER_FAUX",
		"CLIO_WORKER_FAUX_MODEL",
		"CLIO_WORKER_FAUX_TEXT",
	] as const;
	const snapshot = new Map<string, string | undefined>();
	for (const k of ENV_KEYS) snapshot.set(k, process.env[k]);
	for (const k of ["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const) {
		delete process.env[k];
	}
	process.env.CLIO_HOME = home;
	process.env.CLIO_WORKER_FAUX = "1";
	process.env.CLIO_WORKER_FAUX_MODEL = "faux-model";
	process.env.CLIO_WORKER_FAUX_TEXT = "hello from faux worker";

	try {
		const { resetXdgCache, clioDataDir } = await import("../src/core/xdg.js");
		resetXdgCache();
		const dataDir = clioDataDir();
		check("xdg:data-dir-under-home", dataDir === join(home, "data"), `dataDir=${dataDir}`);

		const { resetSharedBus, getSharedBus } = await import("../src/core/shared-bus.js");
		resetSharedBus();
		const { resetPackageRootCache } = await import("../src/core/package-root.js");
		resetPackageRootCache();

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
		const { BusChannels } = await import("../src/core/bus-events.js");

		const bus = getSharedBus();
		const busEventTypes: string[] = [];
		bus.on(BusChannels.DispatchEnqueued, () => busEventTypes.push("enqueued"));
		bus.on(BusChannels.DispatchStarted, () => busEventTypes.push("started"));
		bus.on(BusChannels.DispatchCompleted, () => busEventTypes.push("completed"));
		bus.on(BusChannels.DispatchFailed, () => busEventTypes.push("failed"));

		const loaded = await loadDomains([
			ConfigDomainModule,
			ProvidersDomainModule,
			SafetyDomainModule,
			ModesDomainModule,
			PromptsDomainModule,
			AgentsDomainModule,
			DispatchDomainModule,
			SessionDomainModule,
			ObservabilityDomainModule,
		]);
		check("domain:loaded", loaded.loaded.includes("dispatch"), `loaded=${loaded.loaded.join(",")}`);

		type DispatchContractType = import("../src/domains/dispatch/contract.js").DispatchContract;
		const dispatch = loaded.getContract<DispatchContractType>("dispatch");
		check("domain:contract-exposed", dispatch !== undefined);
		if (!dispatch) {
			await loaded.stop();
			return;
		}

		for (const runtime of ["sdk", "cli"] as const) {
			try {
				const unsupportedReq = {
					agentId: "scout",
					task: "reject unsupported runtime",
					providerId: "faux",
					modelId: "faux-model",
					runtime,
				} as unknown as Parameters<typeof dispatch.dispatch>[0];
				await dispatch.dispatch(unsupportedReq);
				check(`dispatch:rejects-runtime-${runtime}`, false, "dispatch unexpectedly accepted the runtime");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				check(`dispatch:rejects-runtime-${runtime}`, message.includes(`runtime=${runtime} not supported in v0.1`), message);
			}
		}

		// ---- 1st dispatch: expect clean completion ------------------------------
		const res = await dispatch.dispatch({
			agentId: "scout",
			task: "hello",
			providerId: "faux",
			modelId: "faux-model",
		});
		check("dispatch:returned-runId", typeof res.runId === "string" && res.runId.length > 0, `runId=${res.runId}`);

		const workerEventTypes: string[] = [];
		for await (const ev of res.events) {
			const obj = ev as { type?: unknown };
			if (obj && typeof obj.type === "string") workerEventTypes.push(obj.type);
		}
		const receipt = await res.finalPromise;

		check(
			"dispatch:worker-events-agent_start",
			workerEventTypes.includes("agent_start"),
			`types=${JSON.stringify(workerEventTypes)}`,
		);
		check(
			"dispatch:worker-events-agent_end",
			workerEventTypes.includes("agent_end"),
			`types=${JSON.stringify(workerEventTypes)}`,
		);

		check(
			"bus:enqueued-and-started",
			busEventTypes.includes("enqueued") && busEventTypes.includes("started"),
			`events=${JSON.stringify(busEventTypes)}`,
		);
		check("bus:completed-fired", busEventTypes.includes("completed"), `events=${JSON.stringify(busEventTypes)}`);

		check("receipt:runId-matches", receipt.runId === res.runId, `runId=${receipt.runId}`);
		check("receipt:agentId", receipt.agentId === "scout", `agentId=${receipt.agentId}`);
		check("receipt:exit-code-zero", receipt.exitCode === 0, `exit=${receipt.exitCode}`);
		check("receipt:provider+model", receipt.providerId === "faux" && receipt.modelId === "faux-model");
		check("receipt:runtime-native", receipt.runtime === "native", `runtime=${receipt.runtime}`);
		check(
			"receipt:has-clio-and-pimono-versions",
			typeof receipt.clioVersion === "string" &&
				receipt.clioVersion.length > 0 &&
				typeof receipt.piMonoVersion === "string" &&
				receipt.piMonoVersion.length > 0,
			`clio=${receipt.clioVersion} pi=${receipt.piMonoVersion}`,
		);
		check("receipt:platform-and-node", receipt.platform === process.platform && receipt.nodeVersion === process.version);
		check("receipt:endedAt-non-empty", typeof receipt.endedAt === "string" && receipt.endedAt.length > 0);
		check(
			"receipt:tokenCount-from-usage",
			typeof receipt.tokenCount === "number" && receipt.tokenCount > 0,
			`tokenCount=${receipt.tokenCount}`,
		);
		check(
			"receipt:costUsd-non-negative",
			typeof receipt.costUsd === "number" && receipt.costUsd >= 0,
			`costUsd=${receipt.costUsd}`,
		);

		// ---- ledger / filesystem checks -----------------------------------------
		const completedRuns = dispatch.listRuns("completed");
		check(
			"ledger:listRuns-completed-has-one",
			completedRuns.length === 1 && completedRuns[0]?.id === res.runId,
			`len=${completedRuns.length} ids=${completedRuns.map((r) => r.id).join(",")}`,
		);

		const runsPath = join(dataDir, "state", "runs.json");
		check("ledger:runs.json-exists", existsSync(runsPath), runsPath);
		const persisted = JSON.parse(readFileSync(runsPath, "utf8")) as Array<{ id: string; status: string }>;
		check(
			"ledger:runs.json-contains-run",
			Array.isArray(persisted) && persisted.some((r) => r.id === res.runId && r.status === "completed"),
			JSON.stringify(persisted.map((r) => ({ id: r.id, status: r.status }))),
		);

		const receiptPath = join(dataDir, "receipts", `${res.runId}.json`);
		check("receipt:file-exists", existsSync(receiptPath), receiptPath);
		const onDiskReceipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { runId: string };
		check("receipt:file-runId-matches", onDiskReceipt.runId === res.runId, `runId=${onDiskReceipt.runId}`);

		// ---- observability sees enriched DispatchCompleted payload --------------
		type ObservabilityContractType = import("../src/domains/observability/contract.js").ObservabilityContract;
		const obs = loaded.getContract<ObservabilityContractType>("observability");
		check("observability:contract-exposed", obs !== undefined);
		if (obs) {
			const entries = obs.costEntries();
			const matching = entries.find((e) => e.providerId === "faux" && e.modelId === "faux-model");
			check("observability:cost-entry-for-completed-run", matching !== undefined, `entries=${JSON.stringify(entries)}`);
			check(
				"observability:cost-entry-tokens-non-zero",
				matching !== undefined && matching.tokens > 0,
				`tokens=${matching?.tokens ?? 0}`,
			);
			const snapshot = obs.metrics();
			const hist = snapshot.histograms["dispatch.duration_ms"];
			check(
				"observability:duration-histogram-from-real-dispatch",
				hist !== undefined && hist.count >= 1,
				`hist=${JSON.stringify(hist)}`,
			);
		}

		// ---- 2nd dispatch: abort immediately, expect "interrupted" --------------
		const res2 = await dispatch.dispatch({
			agentId: "scout",
			task: "hang",
			providerId: "faux",
			modelId: "faux-model",
		});
		dispatch.abort(res2.runId);
		// Drain events so the readline stream finishes and worker.promise resolves.
		(async () => {
			for await (const _ev of res2.events) {
				// discard
			}
		})().catch(() => {});
		const receipt2 = await res2.finalPromise;
		const envelope2 = dispatch.getRun(res2.runId);
		check("abort:receipt-returned", typeof receipt2.runId === "string");
		check(
			"abort:ledger-status-interrupted",
			envelope2?.status === "interrupted",
			`status=${envelope2?.status ?? "null"}`,
		);

		// ---- drain cleanly when nothing is active --------------------------------
		await dispatch.drain();
		check("drain:clean-when-idle", true);

		await loaded.stop();
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
}

async function main(): Promise<void> {
	await run();
	if (failures.length > 0) {
		process.stderr.write(`[diag-dispatch] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-dispatch] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-dispatch] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
