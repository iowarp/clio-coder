import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readLayeredSettings } from "../core/settings-layers.js";
import type { SessionTelemetryV1 } from "../core/telemetry/dto.js";
import { clioStateDir } from "../core/xdg.js";
import { loadSessionTelemetrySourceAsync } from "../domains/session/telemetry-source.js";
import { workspaceTelemetryCapture } from "../domains/telemetry/consent.js";
import {
	TELEMETRY_BUNDLE_FILE,
	telemetryJournalFiles,
	telemetryProcessesDirectory,
	telemetryRunsDirectory,
	telemetrySessionsDirectory,
} from "../domains/telemetry/paths.js";
import { seal, sessionTelemetry } from "../domains/telemetry/read-model.js";
import { describeSealMismatch, readTelemetryScopeFiles } from "../domains/telemetry/seal.js";
import { printError } from "./shared.js";

type ScopeKind = "session" | "run" | "process";

interface ScopeSeal {
	kind: ScopeKind;
	id: string;
	path: string;
	status: "verified" | "unsealed" | "failed";
	detail: string | null;
}

export interface TelemetryDoctorReport {
	mode: { requested: string; effective: string; capture: Record<string, boolean> };
	consent: { workspace: string; covering: { workspace: string; grantedAt: string } | null; error: string | null };
	latestSession: { sessionId: string; journal: SessionTelemetryV1["journal"] } | null;
	seals: { verified: number; unsealed: number; failed: number; scopes: Record<ScopeKind, number> };
	failures: ScopeSeal[];
}

async function scopeDirectories(root: string): Promise<string[]> {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/** The newest journal write in a scope, or null for a scope with no journal. */
async function newestJournalMs(directory: string): Promise<number | null> {
	let newest: number | null = null;
	for (const name of telemetryJournalFiles(await readdir(directory))) {
		const mtime = (await stat(join(directory, name))).mtimeMs;
		if (newest === null || mtime > newest) newest = mtime;
	}
	return newest;
}

/**
 * Only a scope holding a bundle is verified; one without is live or was never sealed, which `seal` reports without
 * hashing its segments, so the doctor stays cheap on a large telemetry root (#434).
 */
async function scopeSeal(kind: ScopeKind, id: string, path: string): Promise<ScopeSeal> {
	try {
		const names = await readdir(path);
		if (!names.includes(TELEMETRY_BUNDLE_FILE)) {
			const reason = telemetryJournalFiles(names).length === 0 ? "no journal" : "live or never sealed";
			return { kind, id, path, status: "unsealed", detail: reason };
		}
		const verdict = seal(await readTelemetryScopeFiles(path));
		if (verdict.status === "failed")
			return { kind, id, path, status: "failed", detail: describeSealMismatch(verdict.mismatch) };
		return { kind, id, path, status: verdict.status, detail: null };
	} catch (error) {
		return { kind, id, path, status: "failed", detail: error instanceof Error ? error.message : String(error) };
	}
}

async function telemetryDoctorReport(stateDir: string, cwd: string): Promise<TelemetryDoctorReport> {
	const settings = readLayeredSettings(cwd).settings.telemetry;
	const { capture, covering, consent } = workspaceTelemetryCapture(settings, stateDir, cwd);
	const roots: Array<[ScopeKind, string]> = [
		["session", telemetrySessionsDirectory(stateDir)],
		["run", telemetryRunsDirectory(stateDir)],
		["process", telemetryProcessesDirectory(stateDir)],
	];
	const seals: ScopeSeal[] = [];
	const scopes: Record<ScopeKind, number> = { session: 0, run: 0, process: 0 };
	let latest: { id: string; at: number } | null = null;
	for (const [kind, root] of roots) {
		for (const id of await scopeDirectories(root)) {
			const path = join(root, id);
			scopes[kind] += 1;
			seals.push(await scopeSeal(kind, id, path));
			if (kind !== "session") continue;
			const at = await newestJournalMs(path).catch(() => null);
			if (at !== null && (latest === null || at > latest.at)) latest = { id, at };
		}
	}
	const source = latest ? await loadSessionTelemetrySourceAsync(stateDir, latest.id) : null;
	return {
		mode: { requested: settings.mode, effective: capture.mode, capture: { ...capture.capture } },
		consent: {
			workspace: cwd,
			covering: covering ? { workspace: covering.workspace, grantedAt: covering.grantedAt } : null,
			error: consent.error,
		},
		latestSession: source ? { sessionId: source.sessionId, journal: sessionTelemetry(source).journal } : null,
		seals: {
			verified: seals.filter((entry) => entry.status === "verified").length,
			unsealed: seals.filter((entry) => entry.status === "unsealed").length,
			failed: seals.filter((entry) => entry.status === "failed").length,
			scopes,
		},
		failures: seals.filter((entry) => entry.status === "failed"),
	};
}

function renderReport(report: TelemetryDoctorReport): string {
	const flags = Object.entries(report.mode.capture)
		.filter(([, on]) => on)
		.map(([flag]) => flag);
	const consent = report.consent.error
		? `store unreadable: ${report.consent.error}`
		: report.consent.covering
			? `granted for ${report.consent.covering.workspace} at ${report.consent.covering.grantedAt}`
			: `none covers ${report.consent.workspace}`;
	const journal = report.latestSession?.journal;
	const health = report.latestSession
		? journal?.present
			? `latest session ${report.latestSession.sessionId}: ${journal.records} records · ${journal.skipped} skipped · ${journal.damaged} damaged · ${journal.gapRecords} gaps (${journal.droppedRecords} dropped) · ${journal.duplicateRecords} duplicates · ${journal.conflictingAttempts} conflicting attempts`
			: `latest session ${report.latestSession.sessionId}: no journal`
		: "no session journal";
	const { scopes } = report.seals;
	const lines = [
		`mode      ${report.mode.effective}${report.mode.requested !== report.mode.effective ? ` (settings request ${report.mode.requested})` : ""} · capture ${flags.length > 0 ? flags.join(", ") : "none beyond standard"}`,
		`consent   ${consent}`,
		`journals  ${scopes.session} sessions · ${scopes.run} runs · ${scopes.process} processes`,
		`health    ${health}`,
		`seals     ${report.seals.verified} verified · ${report.seals.unsealed} unsealed (live, never sealed or no journal) · ${report.seals.failed} failed`,
		...report.failures.map((entry) => `          failed ${entry.kind} ${entry.id}: ${entry.detail ?? "unknown"}`),
	];
	return `${lines.join("\n")}\n`;
}

/** `telemetry doctor [--json]`: exit 0 when healthy, 1 when a seal fails, the consent store is unreadable or a journal is damaged. */
export async function runTelemetryDoctor(argv: ReadonlyArray<string>): Promise<number> {
	const json = argv.includes("--json");
	if (argv.some((arg) => arg !== "--json")) {
		printError("usage: clio-coder telemetry doctor [--json]");
		return 2;
	}
	let report: TelemetryDoctorReport;
	try {
		report = await telemetryDoctorReport(clioStateDir(), process.cwd());
	} catch (error) {
		printError(`cannot read telemetry: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
	const damaged = (report.latestSession?.journal.damaged ?? 0) > 0;
	return report.seals.failed > 0 || report.consent.error !== null || damaged ? 1 : 0;
}
