/**
 * Tier-2 telemetry coverage for T2.2a: every mode transition emitted by the
 * modes domain on `BusChannels.ModeChanged` must persist as a `mode_change`
 * row in the audit jsonl. The safety extension owns the audit writer and
 * subscribes to the bus during start(); on the same shared SafeEventBus the
 * modes extension fans transitions into the same NDJSON file used for
 * tool-call rows.
 *
 * The audit file shape is a discriminated union over `kind` so existing
 * tool_call rows and new mode_change rows coexist without breaking
 * downstream parsers.
 */

import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus, type SafeEventBus } from "../../src/core/event-bus.js";
import { initializeClioHome } from "../../src/core/init.js";
import { clioDataDir, resetXdgCache } from "../../src/core/xdg.js";
import { createModesBundle } from "../../src/domains/modes/extension.js";
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

describe("audit jsonl: mode transitions land in the audit file", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-audit-mode-"));
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

	it("writes a mode_change audit row when modes.setMode flips default → advise", async () => {
		const bus = createSafeEventBus();
		const safety = createSafetyBundle(makeContextOn(bus));
		const modes = createModesBundle(makeContextOn(bus));
		await safety.extension.start();
		await modes.extension.start();
		try {
			modes.contract.setMode("advise", "test-cycle");
			await safety.extension.stop?.();
			await modes.extension.stop?.();

			const rows = readAuditRows();
			const modeChanges = rows.filter(
				(r): r is { kind: string; from: string | null; to: string; reason: string | null } =>
					typeof r === "object" && r !== null && (r as { kind?: unknown }).kind === "mode_change",
			);
			ok(modeChanges.length >= 1, `expected at least one mode_change row, got rows=${JSON.stringify(rows)}`);
			const transition = modeChanges.find((r) => r.from === "default" && r.to === "advise");
			ok(transition, `expected default→advise row in ${JSON.stringify(modeChanges)}`);
			strictEqual(transition.reason, "test-cycle");
		} finally {
			// Best-effort cleanup if the assertion above threw before stop().
			await safety.extension.stop?.();
			await modes.extension.stop?.();
		}
	});

	it("writes a mode_change row for the boot announcement (from=null) so first-mode telemetry is captured", async () => {
		const bus = createSafeEventBus();
		const safety = createSafetyBundle(makeContextOn(bus));
		const modes = createModesBundle(makeContextOn(bus));
		await safety.extension.start();
		await modes.extension.start();
		try {
			await safety.extension.stop?.();
			await modes.extension.stop?.();

			const rows = readAuditRows();
			const bootRow = rows.find(
				(r): r is { kind: string; from: string | null; to: string; reason: string | null } =>
					typeof r === "object" &&
					r !== null &&
					(r as { kind?: unknown }).kind === "mode_change" &&
					(r as { reason?: unknown }).reason === "boot",
			);
			ok(bootRow, `expected a boot mode_change row, got ${JSON.stringify(rows)}`);
			strictEqual(bootRow.from, null);
		} finally {
			await safety.extension.stop?.();
			await modes.extension.stop?.();
		}
	});

	it("requestSuper writes an audit row tagged requiresConfirmation=true so Alt+S overlays leave a trail", async () => {
		const bus = createSafeEventBus();
		const safety = createSafetyBundle(makeContextOn(bus));
		const modes = createModesBundle(makeContextOn(bus));
		await safety.extension.start();
		await modes.extension.start();
		try {
			modes.contract.requestSuper("keybind");
			await safety.extension.stop?.();
			await modes.extension.stop?.();

			const rows = readAuditRows();
			const requestRow = rows.find(
				(
					r,
				): r is {
					kind: string;
					from: string | null;
					to: string;
					reason: string | null;
					requestedBy?: string;
					requiresConfirmation?: boolean;
				} =>
					typeof r === "object" &&
					r !== null &&
					(r as { kind?: unknown }).kind === "mode_change" &&
					(r as { reason?: unknown }).reason === "request",
			);
			ok(requestRow, `expected a request mode_change row, got ${JSON.stringify(rows)}`);
			strictEqual(requestRow.to, "super");
			strictEqual(requestRow.requestedBy, "keybind");
			strictEqual(requestRow.requiresConfirmation, true);
		} finally {
			await safety.extension.stop?.();
			await modes.extension.stop?.();
		}
	});
});
