import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import type { ConfigChangePayload } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { Payload } from "../../src/core/telemetry/schemas.js";
import { clioStateDir } from "../../src/core/xdg.js";
import type { ConfigContract } from "../../src/domains/config/index.js";
import { computeSettingsFingerprint } from "../../src/domains/dispatch/settings-fingerprint.js";
import { readCallJournal } from "../../src/domains/observability/call-journal.js";
import { createObservabilityBundle } from "../../src/domains/observability/extension.js";
import { readTelemetryObject } from "../../src/domains/observability/objects.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

it("a session writer opens with its settings and journals each change once, with both documents (#434)", async () => {
	const env = await isolateClioEnv("clio-coder-config-records-");
	const before = structuredClone(DEFAULT_SETTINGS);
	const after = structuredClone(DEFAULT_SETTINGS);
	after.safety.limits.sessionCostUsd = 42;
	let current = before;
	const listeners: Array<(payload: ConfigChangePayload) => void> = [];
	const config = {
		get: () => current,
		onChange: (_kind: string, listener: (payload: ConfigChangePayload) => void) => {
			listeners.push(listener);
			return () => {};
		},
	} as unknown as ConfigContract;
	const { contract, extension } = createObservabilityBundle(
		{
			bus: createSafeEventBus(),
			getContract: (name: string) => (name === "config" ? config : undefined),
		} as DomainContext,
		{ dispatchTrace: false },
	);
	const origin = { id: "config-session", cwdHash: "config-repo" };
	const directory = join(clioStateDir(), "sessions", origin.cwdHash, origin.id);
	try {
		await extension.start();
		const lease = await contract.acquireTelemetrySession?.(origin, "main");
		ok(lease);
		current = after;
		const change: ConfigChangePayload = {
			diff: { hotReload: ["safety.limits.sessionCostUsd"], nextTurn: [], restartRequired: [] },
			settings: after,
			previous: before,
			source: "settings-ui",
		};
		// One change reaches a listener once per effect kind it touches.
		for (const listener of listeners) listener(change);
		await lease.release();
		await extension.stop?.();
		const records = (await readCallJournal(directory)).records.map(({ record }) => record);
		const snapshots = records.flatMap((record) => (record.k === "config.snapshot" ? [record.data] : []));
		const changes = records.flatMap((record) => (record.k === "config.changed" ? [record.data] : []));
		strictEqual(snapshots.length, 1);
		strictEqual(snapshots[0]?.settingsFingerprint, computeSettingsFingerprint(before));
		strictEqual(changes.length, 1, "a change is journaled once whatever kinds it touches");
		const [changed] = changes as [Payload<"config.changed">];
		strictEqual(changed.source, "settings-ui");
		deepStrictEqual(changed.paths.hotReload, ["safety.limits.sessionCostUsd"]);
		strictEqual(changed.settingsFingerprint, computeSettingsFingerprint(after));
		deepStrictEqual(changed.before, snapshots[0]?.settings);
		const resolved = await readTelemetryObject(directory, changed.after);
		ok(resolved.kind === "resolved");
		strictEqual(
			(resolved.value as typeof DEFAULT_SETTINGS).safety.limits.sessionCostUsd,
			42,
			"the after document resolves from objects/",
		);
	} finally {
		env.restore();
	}
});
