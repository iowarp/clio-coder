/**
 * Tier-2 telemetry coverage for T2.2c: every abort/cancel path must persist
 * an audit jsonl row carrying source, runId, startedAt, and elapsedMs so
 * /audit consumers can reconstruct who killed which run and how long it ran
 * before the kill.
 *
 * The audit record is a third arm of the discriminated union introduced for
 * tool_call (slice 6) and mode_change (slice 12.5). Safety subscribes to
 * BusChannels.RunAborted on start() and writes one kind: "abort" row per
 * event. Emit sites are dispatch.abort (single run), dispatch.drain (every
 * active run on shutdown), and chat-loop cancel (orchestrator stream cancel,
 * which has no dispatch runId so runId is null).
 */

import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus, type SafeEventBus } from "../../src/core/event-bus.js";
import { initializeClioHome } from "../../src/core/init.js";
import { clioDataDir, resetXdgCache } from "../../src/core/xdg.js";
import { createSafetyBundle } from "../../src/domains/safety/extension.js";

const ORIGINAL_ENV = { ...process.env };

function makeContextOn(bus: SafeEventBus): DomainContext {
	return {
		bus,
		getContract: () => undefined,
	};
}

function readAuditRows(): unknown[] {
	const auditDir = join(clioDataDir(), "audit");
	let files: string[] = [];
	try {
		files = readdirSync(auditDir).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const rows: unknown[] = [];
	for (const file of files) {
		const text = readFileSync(join(auditDir, file), "utf8");
		for (const line of text.split("\n")) {
			if (line.length === 0) continue;
			rows.push(JSON.parse(line));
		}
	}
	return rows;
}

interface AbortRow {
	kind: string;
	source?: unknown;
	runId?: unknown;
	startedAt?: unknown;
	elapsedMs?: unknown;
	reason?: unknown;
}

function isAbortRow(value: unknown): value is AbortRow {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "abort";
}

describe("audit jsonl: run aborts land in the audit file", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-audit-abort-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
		initializeClioHome();
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, key);
		}
		for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
			if (value !== undefined) process.env[key] = value;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("writes an abort row with runId + elapsedMs when dispatch.abort fires", async () => {
		const bus = createSafeEventBus();
		const safety = createSafetyBundle(makeContextOn(bus));
		await safety.extension.start();
		try {
			const startedAt = new Date(Date.now() - 4321).toISOString();
			bus.emit(BusChannels.RunAborted, {
				source: "dispatch_abort",
				runId: "run-abc",
				startedAt,
				elapsedMs: 4321,
				at: Date.now(),
				reason: "user requested",
			});
			await safety.extension.stop?.();

			const rows = readAuditRows();
			const aborts = rows.filter(isAbortRow);
			ok(aborts.length === 1, `expected exactly one abort row, got ${JSON.stringify(rows)}`);
			const row = aborts[0];
			ok(row, "expected first abort row");
			strictEqual(row.source, "dispatch_abort");
			strictEqual(row.runId, "run-abc");
			strictEqual(row.startedAt, startedAt);
			strictEqual(row.elapsedMs, 4321);
			strictEqual(row.reason, "user requested");
		} finally {
			await safety.extension.stop?.();
		}
	});

	it("writes an abort row per run when dispatch.drain is emitted on shutdown", async () => {
		const bus = createSafeEventBus();
		const safety = createSafetyBundle(makeContextOn(bus));
		await safety.extension.start();
		try {
			const startedAt = new Date(Date.now() - 1500).toISOString();
			bus.emit(BusChannels.RunAborted, {
				source: "dispatch_drain",
				runId: "run-1",
				startedAt,
				elapsedMs: 1500,
				at: Date.now(),
			});
			bus.emit(BusChannels.RunAborted, {
				source: "dispatch_drain",
				runId: "run-2",
				startedAt,
				elapsedMs: 1500,
				at: Date.now(),
			});
			await safety.extension.stop?.();

			const rows = readAuditRows();
			const aborts = rows.filter(isAbortRow);
			strictEqual(aborts.length, 2, `expected two drain abort rows, got ${JSON.stringify(rows)}`);
			const ids = aborts.map((r) => r.runId).sort();
			ok(ids.includes("run-1") && ids.includes("run-2"), `expected run-1 + run-2 in ${JSON.stringify(ids)}`);
			for (const row of aborts) strictEqual(row.source, "dispatch_drain");
		} finally {
			await safety.extension.stop?.();
		}
	});

	it("writes an abort row with no runId when chat-loop cancels the orchestrator stream", async () => {
		const bus = createSafeEventBus();
		const safety = createSafetyBundle(makeContextOn(bus));
		await safety.extension.start();
		try {
			bus.emit(BusChannels.RunAborted, {
				source: "stream_cancel",
				runId: null,
				startedAt: null,
				elapsedMs: null,
				at: Date.now(),
				reason: "Esc on stream",
			});
			await safety.extension.stop?.();

			const rows = readAuditRows();
			const aborts = rows.filter(isAbortRow);
			strictEqual(aborts.length, 1, `expected one stream_cancel abort row, got ${JSON.stringify(rows)}`);
			const row = aborts[0];
			ok(row);
			strictEqual(row.source, "stream_cancel");
			strictEqual(row.runId, null);
			strictEqual(row.startedAt, null);
			strictEqual(row.elapsedMs, null);
			strictEqual(row.reason, "Esc on stream");
		} finally {
			await safety.extension.stop?.();
		}
	});
});
