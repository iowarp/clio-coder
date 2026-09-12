import { deepStrictEqual, ok } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type SettingsMutator, updateSettings } from "../../src/core/config.js";
import { ensureClioState } from "../../src/domains/lifecycle/index.js";
import { createStdioTransport } from "../../src/engine/acp/transport.js";
import { isolateClioEnv, scratchClioEnvVars } from "../harness/scratch-env.js";

test("saved next-turn settings reach the running guardrail and journal consumers", async () => {
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
				import { existsSync } from "node:fs";
				import { BusChannels } from ${JSON.stringify(source("core/bus-events.ts"))};
				import { getSharedBus } from ${JSON.stringify(source("core/shared-bus.ts"))};
				import { resolveGuardrail } from ${JSON.stringify(source("core/guardrails.ts"))};
				import { defaultRunEventJournal, runEventJournalPath } from ${JSON.stringify(source("domains/dispatch/run-event-journal.ts"))};
				import { createStdioServerTransport } from ${JSON.stringify(source("engine/acp/transport.ts"))};
				import { bootOrchestrator } from ${JSON.stringify(source("entry/orchestrator.ts"))};
				const transport = createStdioServerTransport();
				let observation = 0;
				getSharedBus().on(BusChannels.ConfigNextTurn, () => {
					queueMicrotask(() => {
						const runId = "projection-fixture-" + (++observation);
						defaultRunEventJournal().open(runId, "fixture");
						transport.notify("probe/settings", {
							readMaxBytes: resolveGuardrail("readMaxBytes"),
							journalWritten: existsSync(runEventJournalPath(runId)),
						});
					});
				});
				await bootOrchestrator({ acp: { transport } });
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
					settings.fleet.history.journal = false;
				}),
				{ readMaxBytes: 1024, journalWritten: false },
			);
			deepStrictEqual(
				await change((settings) => {
					settings.safety.limits.readBytesPerCall = 8192;
					settings.fleet.history.journal = true;
				}),
				{ readMaxBytes: 8192, journalWritten: true },
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
