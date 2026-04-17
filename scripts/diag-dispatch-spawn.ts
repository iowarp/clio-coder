/**
 * End-to-end diag for the dispatch subprocess spawn + heartbeat watchdog.
 *
 * Builds the worker bundle, spawns it via spawnNativeWorker with the pi-ai
 * faux provider (no network, no credentials), asserts the NDJSON event stream
 * carries the expected agent + heartbeat events, exercises classifyHeartbeat
 * for all three states, and confirms abort() tears the subprocess down within
 * the grace budget.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-dispatch-spawn] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-dispatch-spawn] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function main(): Promise<void> {
	const projectRoot = process.cwd();
	const workerJs = join(projectRoot, "dist/worker/entry.js");

	process.stdout.write("[diag-dispatch-spawn] building dist/ ...\n");
	execFileSync("npm", ["run", "build"], { stdio: "inherit", cwd: projectRoot });
	if (!existsSync(workerJs)) {
		process.stderr.write(`[diag-dispatch-spawn] build did not produce ${workerJs}\n`);
		process.exit(1);
	}

	const home = mkdtempSync(join(tmpdir(), "clio-diag-dispatch-spawn-"));
	const ENV_KEYS = ["CLIO_HOME", "CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const;
	const snapshot = new Map<string, string | undefined>();
	for (const k of ENV_KEYS) snapshot.set(k, process.env[k]);
	for (const k of ["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const) {
		delete process.env[k];
	}
	process.env.CLIO_HOME = home;

	try {
		const { spawnNativeWorker } = await import("../src/domains/dispatch/worker-spawn.js");
		const { classifyHeartbeat } = await import("../src/domains/dispatch/heartbeat.js");

		// Step 1: spawn a faux worker end-to-end.
		const childEnv: NodeJS.ProcessEnv = {
			...process.env,
			CLIO_WORKER_FAUX: "1",
			CLIO_WORKER_FAUX_MODEL: "faux-model",
			CLIO_WORKER_FAUX_TEXT: "hello from faux worker",
		};

		const worker = spawnNativeWorker(
			{
				providerId: "faux",
				modelId: "faux-model",
				task: "hi",
				systemPrompt: "You are a faux agent.",
			},
			{ env: childEnv, cwd: projectRoot },
		);

		check("spawn:pid-positive", typeof worker.pid === "number" && worker.pid > 0, `pid=${worker.pid}`);
		const heartbeatTouchedBefore = worker.heartbeatAt.current;

		const eventTypes: string[] = [];
		for await (const ev of worker.events) {
			const obj = ev as { type?: unknown };
			if (obj && typeof obj.type === "string") eventTypes.push(obj.type);
		}
		const result = await worker.promise;

		check("spawn:exit-code-zero", result.exitCode === 0, `exit=${result.exitCode} signal=${result.signal}`);
		check("events:has-agent_start", eventTypes.includes("agent_start"), `types=${JSON.stringify(eventTypes)}`);
		check("events:has-agent_end", eventTypes.includes("agent_end"), `types=${JSON.stringify(eventTypes)}`);
		const heartbeatCount = eventTypes.filter((t) => t === "heartbeat").length;
		check("events:has-heartbeat", heartbeatCount >= 1, `count=${heartbeatCount}`);
		check(
			"heartbeatAt:bumped",
			worker.heartbeatAt.current >= heartbeatTouchedBefore,
			`before=${heartbeatTouchedBefore} after=${worker.heartbeatAt.current}`,
		);

		// Step 2: classifyHeartbeat spans alive/stale/dead.
		const nowA = Date.now();
		const spec = { windowMs: 5000, graceMs: 10000 };
		check("classify:alive", classifyHeartbeat(nowA, nowA, spec) === "alive");
		check(
			"classify:stale",
			classifyHeartbeat(nowA - 7000, nowA, spec) === "stale",
			`got=${classifyHeartbeat(nowA - 7000, nowA, spec)}`,
		);
		check(
			"classify:dead",
			classifyHeartbeat(nowA - 20000, nowA, spec) === "dead",
			`got=${classifyHeartbeat(nowA - 20000, nowA, spec)}`,
		);

		// Step 3: abort a second worker immediately, expect non-zero / signal exit within 5s.
		const worker2 = spawnNativeWorker(
			{
				providerId: "faux",
				modelId: "faux-model",
				task: "hang",
				systemPrompt: "You are a faux agent.",
			},
			{ env: childEnv, cwd: projectRoot, shutdownGraceMs: 500 },
		);
		worker2.abort();

		// Drain events so readline + the promise can resolve cleanly.
		(async () => {
			for await (const _ev of worker2.events) {
				// discard; we only care about exit behavior here.
			}
		})().catch(() => {});

		let timedOut = false;
		const abortResult = await Promise.race([
			worker2.promise,
			new Promise<{ exitCode: number; signal: NodeJS.Signals | null }>((resolve) => {
				const t = setTimeout(() => {
					timedOut = true;
					resolve({ exitCode: -1, signal: null });
				}, 5000);
				t.unref?.();
			}),
		]);

		check("abort:exited-within-5s", !timedOut, "timed out waiting for abort");
		const nonZeroOrSignal = abortResult.exitCode !== 0 || abortResult.signal !== null;
		check("abort:non-zero-or-signal", nonZeroOrSignal, `exit=${abortResult.exitCode} signal=${abortResult.signal}`);

		// Step 4: invalid cwd should surface a spawn_error event and resolve cleanly.
		const spawnErrorWorker = spawnNativeWorker(
			{
				providerId: "faux",
				modelId: "faux-model",
				task: "spawn error",
				systemPrompt: "You are a faux agent.",
			},
			{ env: childEnv, cwd: "/definitely/missing/path" },
		);

		const spawnErrorEvents: Array<{ type?: unknown; error?: unknown }> = [];
		for await (const ev of spawnErrorWorker.events) {
			if (typeof ev === "object" && ev !== null) {
				spawnErrorEvents.push(ev as { type?: unknown; error?: unknown });
			}
		}
		const spawnErrorResult = await spawnErrorWorker.promise;
		const spawnErrorEvent = spawnErrorEvents.find((ev) => ev.type === "spawn_error");
		check("spawn-error:pid-null", spawnErrorWorker.pid === null, `pid=${spawnErrorWorker.pid}`);
		check("spawn-error:event-emitted", spawnErrorEvent !== undefined, `events=${JSON.stringify(spawnErrorEvents)}`);
		check(
			"spawn-error:event-has-message",
			typeof spawnErrorEvent?.error === "string" && spawnErrorEvent.error.length > 0,
			`event=${JSON.stringify(spawnErrorEvent)}`,
		);
		check(
			"spawn-error:promise-resolved-null-exit",
			spawnErrorResult.exitCode === null && spawnErrorResult.signal === null,
			`exit=${spawnErrorResult.exitCode} signal=${spawnErrorResult.signal}`,
		);
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
		process.stderr.write(`[diag-dispatch-spawn] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-dispatch-spawn] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-dispatch-spawn] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
