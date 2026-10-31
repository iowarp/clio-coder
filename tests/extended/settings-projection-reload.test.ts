import { deepStrictEqual, ok } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type SettingsMutator, updateSettings } from "../../src/core/config.js";
import { ensureClioState } from "../../src/domains/lifecycle/index.js";
import { createStdioTransport } from "../../src/engine/acp/transport.js";
import { isolateClioEnv, scratchClioEnvVars } from "../harness/scratch-env.js";

test("saved next-turn settings reach the running guardrail consumer", async () => {
	const scratch = await isolateClioEnv("clio-coder-settings-projection-");
	const originalCwd = process.cwd();
	try {
		const cwd = join(scratch.dir, "workspace");
		mkdirSync(cwd);
		process.chdir(cwd);
		ensureClioState();
		const source = (path: string) => new URL(`../../src/${path}`, import.meta.url).href;
		const transport = createStdioTransport(
			process.execPath,
			[
				"--import",
				import.meta.resolve("tsx"),
				"--input-type=module",
				"--eval",
				`
				import { telemetryHub } from ${JSON.stringify(source("core/telemetry/hub.ts"))};
				import { resolveGuardrail } from ${JSON.stringify(source("core/guardrails.ts"))};
				import { createStdioServerTransport } from ${JSON.stringify(source("engine/acp/transport.ts"))};
				import { bootOrchestrator } from ${JSON.stringify(source("entry/orchestrator.ts"))};
				const transport = createStdioServerTransport();
				telemetryHub().subscribe("config.next_turn_scheduled", () => {
					queueMicrotask(() => {
						transport.notify("probe/settings", {
							readMaxBytes: resolveGuardrail("readMaxBytes"),
						});
					});
				});
				await bootOrchestrator({ acp: { transport, onReady: () => transport.notify("probe/ready", {}) } });
				`,
			],
			{
				cwd,
				env: Object.fromEntries(
					Object.entries(scratchClioEnvVars(scratch.dir)).filter(
						(entry): entry is [string, string] => entry[1] !== undefined,
					),
				),
			},
		);
		try {
			// The transport exists before ACP registers initialize. Await the
			// server's readiness callback instead of racing its cold boot.
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("ACP fixture did not become ready")), 30_000);
				const unsubscribe = transport.onNotification("probe/ready", () => {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				});
			});
			await transport.request("initialize", { protocolVersion: 1 });
			const change = async (mutate: SettingsMutator): Promise<unknown> => {
				let unsubscribe = () => {};
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					return await new Promise((resolve, reject) => {
						timer = setTimeout(() => reject(new Error("settings watcher did not publish the change")), 15_000);
						unsubscribe = transport.onNotification("probe/settings", resolve);
						updateSettings(mutate);
					});
				} finally {
					clearTimeout(timer);
					unsubscribe();
				}
			};
			deepStrictEqual(
				await change((settings) => {
					settings.safety.limits.readBytesPerCall = 1024;
				}),
				{ readMaxBytes: 1024 },
			);
			deepStrictEqual(
				await change((settings) => {
					settings.safety.limits.readBytesPerCall = 8192;
				}),
				{ readMaxBytes: 8192 },
			);
			transport.close();
			ok(await transport.waitForExit(5_000));
		} finally {
			await transport.forceTerminate();
		}
	} finally {
		process.chdir(originalCwd);
		scratch.restore();
	}
});
