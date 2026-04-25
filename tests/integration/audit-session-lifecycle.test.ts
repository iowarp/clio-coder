/**
 * Tier-2 telemetry coverage for T2.2d: session park (suspend the current
 * session because the user opened another one or shut down) and session
 * resume (load a prior session from /resume or a /tree branch switch) must
 * leave audit jsonl rows so post-mortem replay can reconstruct which
 * session was active at any wall-clock instant.
 *
 * The audit record gains two more arms of the discriminated union:
 *   - session_park: sessionId + reason (create_new, resume_other, fork,
 *     switch_branch, close, shutdown).
 *   - session_resume: sessionId + via (resume, switch_branch).
 *
 * Safety subscribes to BusChannels.SessionParked and SessionResumed on
 * start() and writes one row per event. The session extension fans every
 * lifecycle transition through the shared bus.
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
import { createSessionBundle } from "../../src/domains/session/extension.js";

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

interface ParkRow {
	kind: string;
	sessionId?: unknown;
	reason?: unknown;
}

interface ResumeRow {
	kind: string;
	sessionId?: unknown;
	via?: unknown;
}

function isParkRow(value: unknown): value is ParkRow {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "session_park";
}

function isResumeRow(value: unknown): value is ResumeRow {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "session_resume";
}

describe("audit jsonl: session park/resume lifecycle", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-audit-session-"));
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

	it("writes a session_park row when the current session is replaced by a fresh /new", async () => {
		const bus = createSafeEventBus();
		const safety = createSafetyBundle(makeContextOn(bus));
		const session = createSessionBundle(makeContextOn(bus));
		await safety.extension.start();
		await session.extension.start();
		try {
			const first = session.contract.create({ cwd: scratch });
			session.contract.create({ cwd: scratch });
			await safety.extension.stop?.();
			await session.extension.stop?.();

			const rows = readAuditRows();
			const parks = rows.filter(isParkRow);
			ok(parks.length >= 1, `expected at least one session_park row, got ${JSON.stringify(rows)}`);
			const firstPark = parks.find((r) => r.sessionId === first.id);
			ok(firstPark, `expected park row for first session ${first.id}, got ${JSON.stringify(parks)}`);
			strictEqual(firstPark.reason, "create_new");
		} finally {
			await safety.extension.stop?.();
			await session.extension.stop?.();
		}
	});

	it("writes a session_resume row when an existing session is reopened via resume()", async () => {
		const bus = createSafeEventBus();
		const safety = createSafetyBundle(makeContextOn(bus));
		const session = createSessionBundle(makeContextOn(bus));
		await safety.extension.start();
		await session.extension.start();
		try {
			const original = session.contract.create({ cwd: scratch });
			session.contract.create({ cwd: scratch });
			session.contract.resume(original.id);
			await safety.extension.stop?.();
			await session.extension.stop?.();

			const rows = readAuditRows();
			const resumes = rows.filter(isResumeRow);
			const resumeRow = resumes.find((r) => r.sessionId === original.id);
			ok(resumeRow, `expected resume row for ${original.id}, got ${JSON.stringify(resumes)}`);
			strictEqual(resumeRow.via, "resume");
		} finally {
			await safety.extension.stop?.();
			await session.extension.stop?.();
		}
	});

	it("writes a session_park row tagged shutdown when stop() closes the current session", async () => {
		const bus = createSafeEventBus();
		const safety = createSafetyBundle(makeContextOn(bus));
		const session = createSessionBundle(makeContextOn(bus));
		await safety.extension.start();
		await session.extension.start();
		try {
			const meta = session.contract.create({ cwd: scratch });
			await session.extension.stop?.();
			await safety.extension.stop?.();

			const rows = readAuditRows();
			const parks = rows.filter(isParkRow);
			const shutdownPark = parks.find((r) => r.sessionId === meta.id && r.reason === "shutdown");
			ok(shutdownPark, `expected shutdown park row for ${meta.id}, got ${JSON.stringify(parks)}`);
		} finally {
			await safety.extension.stop?.();
			await session.extension.stop?.();
		}
	});

	it("writes a session_resume row tagged switch_branch when switchBranch reopens a session", async () => {
		const bus = createSafeEventBus();
		const safety = createSafetyBundle(makeContextOn(bus));
		const session = createSessionBundle(makeContextOn(bus));
		await safety.extension.start();
		await session.extension.start();
		try {
			const original = session.contract.create({ cwd: scratch });
			session.contract.create({ cwd: scratch });
			session.contract.switchBranch(original.id);
			await safety.extension.stop?.();
			await session.extension.stop?.();

			const rows = readAuditRows();
			const resumes = rows.filter(isResumeRow);
			const switchRow = resumes.find((r) => r.sessionId === original.id && r.via === "switch_branch");
			ok(switchRow, `expected switch_branch resume row, got ${JSON.stringify(resumes)}`);
		} finally {
			await safety.extension.stop?.();
			await session.extension.stop?.();
		}
	});
});
