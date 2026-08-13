import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeId } from "../../core/safe-id.js";
import { type GateDecisionArtifact, verifyGateDecisionArtifact } from "../dispatch/index.js";
import { hasRunProvenance, type RunProvenanceView, runProvenanceFromUnknown } from "./provenance.js";
import type { EvidenceFinding, EvidenceFindingsFile, EvidenceInspectable, EvidenceOverview } from "./types.js";

export const EVIDENCE_FILES = [
	"overview.json",
	"transcript.md",
	"trace.raw.jsonl",
	"trace.cleaned.jsonl",
	"tool-events.jsonl",
	"audit-linked.jsonl",
	"receipt.json",
	"gate-decisions.json",
	"protected-artifacts.json",
	"findings.json",
	"findings.md",
] as const;

export function evidenceRoot(dataDir: string): string {
	return join(dataDir, "evidence");
}

export function evidenceDirectory(dataDir: string, evidenceId: string): string {
	assertSafeId(evidenceId, "evidence");
	return join(evidenceRoot(dataDir), evidenceId);
}

/**
 * Thrown when a bundle id resolves to no bundle. Callers hold an id, not a
 * path, so the store names the id; the CLI adds the listing command that shows
 * which ids exist.
 */
export class EvidenceNotFoundError extends Error {
	constructor(readonly evidenceId: string) {
		super(`evidence artifact not found: ${evidenceId}`);
		this.name = "EvidenceNotFoundError";
	}
}

function isMissingFile(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function loadEvidenceOverview(dataDir: string, evidenceId: string): Promise<EvidenceOverview> {
	let raw: string;
	try {
		raw = await readFile(join(evidenceDirectory(dataDir, evidenceId), "overview.json"), "utf8");
	} catch (error) {
		if (isMissingFile(error)) throw new EvidenceNotFoundError(evidenceId);
		throw error;
	}
	const parsed = parseJson(raw, `${evidenceId}/overview.json`);
	return parseOverview(parsed, `${evidenceId}/overview.json`);
}

export async function inspectEvidence(dataDir: string, evidenceId: string): Promise<EvidenceInspectable> {
	const overview = await loadEvidenceOverview(dataDir, evidenceId);
	let findingsRaw: string;
	try {
		findingsRaw = await readFile(join(evidenceDirectory(dataDir, evidenceId), "findings.json"), "utf8");
	} catch (error) {
		// The overview above read, so the bundle exists and this one member of it
		// does not. That is a different fault from a missing bundle and says so.
		if (isMissingFile(error)) throw new Error(`evidence artifact ${evidenceId} is missing findings.json`);
		throw error;
	}
	const findingsParsed = parseJson(findingsRaw, `${evidenceId}/findings.json`);
	const findings = parseFindingsFile(findingsParsed, `${evidenceId}/findings.json`);
	return { overview, findings };
}

/** A bundle run whose receipt carries at least one provenance field set. */
export interface EvidenceRunProvenance {
	runId: string;
	view: RunProvenanceView;
}

/**
 * Read per-run provenance views from a bundle's `receipt.json`. Only runs whose
 * receipt carries at least one provenance field set are returned. A missing
 * receipt file produces an empty provenance list.
 */
export async function loadEvidenceRunProvenance(dataDir: string, evidenceId: string): Promise<EvidenceRunProvenance[]> {
	let raw: string;
	try {
		raw = await readFile(join(evidenceDirectory(dataDir, evidenceId), "receipt.json"), "utf8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return [];
		throw error;
	}
	const parsed = parseJson(raw, `${evidenceId}/receipt.json`);
	if (!isRecord(parsed) || !Array.isArray(parsed.receipts)) return [];
	const out: EvidenceRunProvenance[] = [];
	for (const entry of parsed.receipts) {
		if (!isRecord(entry) || typeof entry.runId !== "string") continue;
		const view = runProvenanceFromUnknown(entry);
		if (hasRunProvenance(view)) out.push({ runId: entry.runId, view });
	}
	return out;
}

/** Load only integrity-valid coordinator decisions linked into an evidence bundle. */
export async function loadEvidenceGateDecisions(dataDir: string, evidenceId: string): Promise<GateDecisionArtifact[]> {
	let raw: string;
	try {
		raw = await readFile(join(evidenceDirectory(dataDir, evidenceId), "gate-decisions.json"), "utf8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return [];
		throw error;
	}
	const parsed = parseJson(raw, `${evidenceId}/gate-decisions.json`);
	if (!isRecord(parsed) || !Array.isArray(parsed.decisions)) return [];
	return parsed.decisions.filter((entry): entry is GateDecisionArtifact => {
		if (!isRecord(entry)) return false;
		return verifyGateDecisionArtifact(entry as unknown as GateDecisionArtifact).ok;
	});
}

export async function listEvidenceOverviews(dataDir: string): Promise<EvidenceOverview[]> {
	let entries: string[];
	try {
		entries = await readdir(evidenceRoot(dataDir));
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return [];
		throw error;
	}
	const overviews: EvidenceOverview[] = [];
	for (const entry of entries.sort(compareStrings)) {
		try {
			overviews.push(await loadEvidenceOverview(dataDir, entry));
		} catch {
			// Ignore incomplete evidence directories so list stays scriptable.
		}
	}
	return overviews;
}

function parseOverview(value: unknown, source: string): EvidenceOverview {
	if (!isRecord(value)) throw new Error(`${source}: expected object`);
	if (value.version !== 1) throw new Error(`${source}: expected version 1`);
	const evidenceId = readString(value, source, "evidenceId");
	const sourceValue = readSource(value.source, `${source}.source`);
	const generatedAt = readString(value, source, "generatedAt");
	const runIds = readStringArray(value, source, "runIds");
	const sessionId = readNullableString(value, source, "sessionId");
	const statuses = readStringArray(value, source, "statuses");
	const startedAt = readNullableString(value, source, "startedAt");
	const endedAt = readNullableString(value, source, "endedAt");
	const tasks = readStringArray(value, source, "tasks");
	const cwds = readStringArray(value, source, "cwds");
	const agentIds = readStringArray(value, source, "agentIds");
	const targetIds = readStringArray(value, source, "targetIds");
	const runtimeIds = readStringArray(value, source, "runtimeIds");
	const modelIds = readStringArray(value, source, "modelIds");
	const totals = readTotals(value.totals, `${source}.totals`);
	const tags = readStringArray(value, source, "tags") as EvidenceOverview["tags"];
	const files = readStringArray(value, source, "files");
	return {
		version: 1,
		evidenceId,
		source: sourceValue,
		generatedAt,
		runIds,
		sessionId,
		statuses,
		startedAt,
		endedAt,
		tasks,
		cwds,
		agentIds,
		targetIds,
		runtimeIds,
		modelIds,
		totals,
		tags,
		files,
	};
}

function parseFindingsFile(value: unknown, source: string): EvidenceFinding[] {
	if (!isRecord(value)) throw new Error(`${source}: expected object`);
	if (value.version !== 1) throw new Error(`${source}: expected version 1`);
	if (!Array.isArray(value.findings)) throw new Error(`${source}.findings: expected array`);
	return value.findings.map((entry, index) => parseFinding(entry, `${source}.findings[${index}]`));
}

function parseFinding(value: unknown, source: string): EvidenceFinding {
	if (!isRecord(value)) throw new Error(`${source}: expected object`);
	const severity = readString(value, source, "severity");
	if (severity !== "info" && severity !== "warn") throw new Error(`${source}.severity: expected info or warn`);
	const tag = readString(value, source, "tag") as EvidenceFinding["tag"];
	return {
		id: readString(value, source, "id"),
		severity,
		tag,
		runId: readNullableString(value, source, "runId"),
		message: readString(value, source, "message"),
	};
}

function readSource(value: unknown, source: string): EvidenceOverview["source"] {
	if (!isRecord(value)) throw new Error(`${source}: expected object`);
	if (value.kind === "run") return { kind: "run", runId: readString(value, source, "runId") };
	if (value.kind === "session") return { kind: "session", sessionId: readString(value, source, "sessionId") };
	if (value.kind === "eval") return { kind: "eval", evalId: readString(value, source, "evalId") };
	throw new Error(`${source}.kind: expected run, session, or eval`);
}

function readTotals(value: unknown, source: string): EvidenceOverview["totals"] {
	if (!isRecord(value)) throw new Error(`${source}: expected object`);
	return {
		runs: readNumber(value, source, "runs"),
		receipts: readNumber(value, source, "receipts"),
		toolCalls: readNumber(value, source, "toolCalls"),
		toolErrors: readNumber(value, source, "toolErrors"),
		blockedToolCalls: readNumber(value, source, "blockedToolCalls"),
		sessionEntries: readOptionalNumber(value, source, "sessionEntries", 0),
		auditRows: readOptionalNumber(value, source, "auditRows", 0),
		toolEvents: readOptionalNumber(value, source, "toolEvents", 0),
		linkedToolEvents: readOptionalNumber(value, source, "linkedToolEvents", 0),
		protectedArtifacts: readOptionalNumber(value, source, "protectedArtifacts", 0),
		tokens: readNumber(value, source, "tokens"),
		costUsd: readNumber(value, source, "costUsd"),
		wallTimeMs: readNumber(value, source, "wallTimeMs"),
	};
}

function readString(record: Record<string, unknown>, source: string, field: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${source}.${field}: expected string`);
	return value;
}

function readNullableString(record: Record<string, unknown>, source: string, field: string): string | null {
	const value = record[field];
	if (value === null) return null;
	if (typeof value !== "string") throw new Error(`${source}.${field}: expected string or null`);
	return value;
}

function readStringArray(record: Record<string, unknown>, source: string, field: string): string[] {
	const value = record[field];
	if (!Array.isArray(value)) throw new Error(`${source}.${field}: expected string array`);
	const out: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const item = value[index];
		if (typeof item !== "string") throw new Error(`${source}.${field}[${index}]: expected string`);
		out.push(item);
	}
	return out;
}

function readNumber(record: Record<string, unknown>, source: string, field: string): number {
	const value = record[field];
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${source}.${field}: expected number`);
	return value;
}

function readOptionalNumber(record: Record<string, unknown>, source: string, field: string, fallback: number): number {
	const value = record[field];
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${source}.${field}: expected number`);
	return value;
}

function parseJson(raw: string, source: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${source}: invalid JSON: ${message}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(a: string, b: string): number {
	return a.localeCompare(b);
}

export function findingsFile(evidenceId: string, findings: EvidenceFinding[]): EvidenceFindingsFile {
	return { version: 1, evidenceId, findings };
}
