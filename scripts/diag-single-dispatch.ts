/**
 * Phase 6 slice 7 diag. Single in-process dispatch cycle end-to-end with full
 * receipt fidelity checks. Loads the dispatch stack against a hermetic
 * CLIO_HOME, dispatches one faux run, walks the event stream, and asserts the
 * resulting RunReceipt carries a runId, agentId, timestamps, versions, and an
 * exit code of 0.
 *
 * Complements diag-dispatch.ts (which covers enqueue/started/completed bus
 * events and abort semantics); this diag focuses on receipt-shape fidelity.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-single-dispatch] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-single-dispatch] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

function isIsoTimestamp(value: unknown): boolean {
	if (typeof value !== "string" || value.length === 0) return false;
	const d = new Date(value);
	return !Number.isNaN(d.getTime()) && value.includes("T");
}

async function main(): Promise<void> {
	const projectRoot = process.cwd();
	const workerJs = join(projectRoot, "dist/worker/entry.js");
	if (!existsSync(workerJs)) {
		process.stdout.write("[diag-single-dispatch] building dist/ ...\n");
		execFileSync("npm", ["run", "build"], { stdio: "inherit", cwd: projectRoot });
	}
	if (!existsSync(workerJs)) {
		process.stderr.write(`[diag-single-dispatch] build did not produce ${workerJs}\n`);
		process.exit(1);
	}

	const home = mkdtempSync(join(tmpdir(), "clio-diag-single-dispatch-"));
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
	process.env.CLIO_WORKER_FAUX_TEXT = "single-dispatch receipt";

	try {
		const { resetXdgCache, clioDataDir } = await import("../src/core/xdg.js");
		resetXdgCache();
		const dataDir = clioDataDir();

		const { resetSharedBus } = await import("../src/core/shared-bus.js");
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

		const loaded = await loadDomains([
			ConfigDomainModule,
			ProvidersDomainModule,
			SafetyDomainModule,
			ModesDomainModule,
			PromptsDomainModule,
			AgentsDomainModule,
			DispatchDomainModule,
		]);

		type DispatchContractType = import("../src/domains/dispatch/contract.js").DispatchContract;
		const dispatch = loaded.getContract<DispatchContractType>("dispatch");
		check("dispatch:contract-exposed", dispatch !== undefined);
		if (!dispatch) {
			await loaded.stop();
			return;
		}

		const res = await dispatch.dispatch({
			agentId: "scout",
			task: "single-dispatch",
			providerId: "faux",
			modelId: "faux-model",
		});
		check("dispatch:runId-nonempty", typeof res.runId === "string" && res.runId.length > 0, `runId=${res.runId}`);

		for await (const _ev of res.events) {
			// drain; shape checks live on the final receipt.
		}
		const receipt = await res.finalPromise;

		check(
			"receipt:runId-matches-dispatch",
			receipt.runId === res.runId,
			`receipt=${receipt.runId} dispatch=${res.runId}`,
		);
		check("receipt:agentId", receipt.agentId === "scout", `got=${receipt.agentId}`);
		check("receipt:task", receipt.task === "single-dispatch", `got=${receipt.task}`);
		check(
			"receipt:provider+model",
			receipt.providerId === "faux" && receipt.modelId === "faux-model",
			`provider=${receipt.providerId} model=${receipt.modelId}`,
		);
		check("receipt:runtime-native", receipt.runtime === "native", `got=${receipt.runtime}`);
		check("receipt:exit-code-zero", receipt.exitCode === 0, `exit=${receipt.exitCode}`);
		check("receipt:startedAt-iso", isIsoTimestamp(receipt.startedAt), `startedAt=${receipt.startedAt}`);
		check("receipt:endedAt-iso", isIsoTimestamp(receipt.endedAt), `endedAt=${receipt.endedAt}`);
		check(
			"receipt:endedAt-after-startedAt",
			new Date(receipt.endedAt).getTime() >= new Date(receipt.startedAt).getTime(),
			`start=${receipt.startedAt} end=${receipt.endedAt}`,
		);
		check(
			"receipt:clio-and-pimono-versions",
			typeof receipt.clioVersion === "string" &&
				receipt.clioVersion.length > 0 &&
				typeof receipt.piMonoVersion === "string" &&
				receipt.piMonoVersion.length > 0,
			`clio=${receipt.clioVersion} pi=${receipt.piMonoVersion}`,
		);
		check(
			"receipt:platform+node",
			receipt.platform === process.platform && receipt.nodeVersion === process.version,
			`platform=${receipt.platform} node=${receipt.nodeVersion}`,
		);

		const receiptPath = join(dataDir, "receipts", `${res.runId}.json`);
		check("receipt:file-on-disk", existsSync(receiptPath), receiptPath);
		const onDisk = JSON.parse(readFileSync(receiptPath, "utf8")) as typeof receipt;
		check("receipt:on-disk-runId-matches", onDisk.runId === res.runId, `on-disk=${onDisk.runId}`);
		check("receipt:on-disk-exit-zero", onDisk.exitCode === 0, `exit=${onDisk.exitCode}`);

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

	if (failures.length > 0) {
		process.stderr.write(`[diag-single-dispatch] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-single-dispatch] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-single-dispatch] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
