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

interface AgentStatusAuditRow {
	kind: string;
	runId?: unknown;
	phase?: unknown;
	prevPhase?: unknown;
	watchdogTier?: unknown;
	metadata?: unknown;
}

function isAgentStatusRow(value: unknown): value is AgentStatusAuditRow {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "agent_status_change";
}

describe("audit jsonl: agent status transitions", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-audit-status-"));
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

	it("writes an agent_status_change row when phase becomes stuck", async () => {
		const bus = createSafeEventBus();
		const safety = createSafetyBundle(makeContextOn(bus));
		await safety.extension.start();
		try {
			bus.emit(BusChannels.AgentStatusChanged, {
				runId: "session-1",
				phase: "stuck",
				prevPhase: "thinking",
				at: Date.now(),
				elapsedFromStart: 181_000,
				watchdogTier: 4,
				metadata: { reason: "watchdog" },
			});
			await safety.extension.stop?.();

			const rows = readAuditRows();
			const statusRows = rows.filter(isAgentStatusRow);
			strictEqual(statusRows.length, 1, `expected one status row, got ${JSON.stringify(rows)}`);
			const row = statusRows[0];
			ok(row);
			strictEqual(row.runId, "session-1");
			strictEqual(row.phase, "stuck");
			strictEqual(row.prevPhase, "thinking");
			strictEqual(row.watchdogTier, 4);
		} finally {
			await safety.extension.stop?.();
		}
	});

	it("ignores non-alarmable status transitions", async () => {
		const bus = createSafeEventBus();
		const safety = createSafetyBundle(makeContextOn(bus));
		await safety.extension.start();
		try {
			bus.emit(BusChannels.AgentStatusChanged, {
				runId: "session-1",
				phase: "thinking",
				prevPhase: "preparing",
				at: Date.now(),
				elapsedFromStart: 50,
				watchdogTier: 0,
			});
			await safety.extension.stop?.();
			strictEqual(readAuditRows().filter(isAgentStatusRow).length, 0);
		} finally {
			await safety.extension.stop?.();
		}
	});
});
