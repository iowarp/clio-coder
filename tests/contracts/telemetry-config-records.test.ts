import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import type { ConfigChangePayload } from "../../src/core/bus-events.js";
import { BusChannels } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { readTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import type { Payload } from "../../src/core/telemetry/schemas.js";
import { settingsFingerprintCommitment } from "../../src/core/telemetry/schemas.js";
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
	before.targets = [
		{
			id: "proxy",
			runtime: "litellm",
			url: "http://127.0.0.1:4000",
			auth: { headers: { Authorization: "Bearer leaked-proxy-token-0123456789" } },
		},
	];
	const after = structuredClone(before);
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
		// The digest a route decision carries, labelled as R7 asks; a version 1 record's bare digest reads labelled too.
		deepStrictEqual(snapshots[0]?.settingsFingerprint, settingsFingerprintCommitment(computeSettingsFingerprint(before)));
		const v1 = { ...records.find((record) => record.k === "config.snapshot"), kv: 1 } as Record<string, unknown>;
		const bare = { ...(v1.data as object), settingsFingerprint: computeSettingsFingerprint(before) };
		const upcast = readTelemetryRecord({ ...v1, data: bare });
		ok(upcast.kind === "record" && upcast.record.k === "config.snapshot");
		deepStrictEqual(upcast.record.data.settingsFingerprint, snapshots[0]?.settingsFingerprint);
		const [opened] = snapshots as [Payload<"config.snapshot">];
		const stored = await readTelemetryObject(directory, opened.settings);
		ok(stored.kind === "resolved");
		const storedText = JSON.stringify(stored.value);
		ok(!storedText.includes("leaked-proxy-token"), "a target header value never enters objects/");
		ok(storedText.includes('"Authorization":"[redacted:headers]"'), "the header name stays as structure");
		strictEqual(changes.length, 1, "a change is journaled once whatever kinds it touches");
		const [changed] = changes as [Payload<"config.changed">];
		strictEqual(changed.source, "settings-ui");
		deepStrictEqual(changed.paths.hotReload, ["safety.limits.sessionCostUsd"]);
		strictEqual(changed.settingsFingerprint.hash, computeSettingsFingerprint(after));
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

it("a session's lifecycle events become session.opened, session.resumed and session.closed records (#434)", async () => {
	const env = await isolateClioEnv("clio-coder-lifecycle-records-");
	const bus = createSafeEventBus();
	const { extension } = createObservabilityBundle({ bus, getContract: () => undefined } as unknown as DomainContext, {
		dispatchTrace: false,
	});
	const origin = { id: "lifecycle-session", cwdHash: "lifecycle-repo" };
	try {
		await extension.start();
		bus.emit(BusChannels.SessionOpened, { sessionId: origin.id, cwdHash: origin.cwdHash, at: Date.now() });
		bus.emit(BusChannels.SessionParked, {
			sessionId: origin.id,
			reason: "resume_other",
			cwdHash: origin.cwdHash,
			at: Date.now(),
		});
		bus.emit(BusChannels.SessionResumed, {
			sessionId: origin.id,
			via: "resume",
			cwdHash: origin.cwdHash,
			at: Date.now(),
		});
		// Without the workspace hash there is no journal to name; nothing is recorded and nothing throws.
		bus.emit(BusChannels.SessionParked, { sessionId: origin.id, reason: "close", at: Date.now() });
		// Shutdown stops this domain before the session domain parks the live session, so stop() journals its close.
		const live = { id: "lifecycle-live", cwdHash: origin.cwdHash };
		bus.emit(BusChannels.SessionOpened, { sessionId: live.id, cwdHash: live.cwdHash, at: Date.now() });
		// An edit for this session alone is journaled into its journal with the surface and scope that made it.
		const sessionAfter = structuredClone(DEFAULT_SETTINGS);
		sessionAfter.chat.thinkingLevel = "high";
		bus.emit(BusChannels.ConfigSessionChanged, {
			sessionId: live.id,
			diff: { hotReload: [], nextTurn: ["chat.thinkingLevel"], restartRequired: [] },
			settings: sessionAfter,
			previous: DEFAULT_SETTINGS,
			source: "slash-command",
			scope: "session",
		});
		await extension.stop?.();
		const records = (await readCallJournal(join(clioStateDir(), "sessions", origin.cwdHash, origin.id))).records.map(
			({ record }) => record,
		);
		deepStrictEqual(records.flatMap((record) => (record.k.startsWith("session.") ? [record.k] : [])).sort(), [
			"session.closed",
			"session.opened",
			"session.resumed",
		]);
		ok(records.every((record) => record.ctx.sessionId === origin.id));
		const liveRecords = (await readCallJournal(join(clioStateDir(), "sessions", live.cwdHash, live.id))).records;
		deepStrictEqual(
			liveRecords.flatMap(({ record }) => (record.k.startsWith("session.") ? [record.k] : [])),
			["session.opened", "session.closed"],
		);
		const sessionChange = liveRecords.find(({ record }) => record.k === "config.changed")?.record.data as
			| Payload<"config.changed">
			| undefined;
		strictEqual(sessionChange?.source, "slash-command");
		strictEqual(sessionChange?.scope, "session");
		deepStrictEqual(sessionChange?.paths.nextTurn, ["chat.thinkingLevel"]);
	} finally {
		env.restore();
	}
});
