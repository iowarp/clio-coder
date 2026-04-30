import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceFinding, EvidenceFindingsFile, EvidenceInspectable, EvidenceOverview } from "./types.js";

export const EVIDENCE_FILES = [
	"overview.json",
	"transcript.md",
	"trace.raw.jsonl",
	"trace.cleaned.jsonl",
	"tool-events.jsonl",
	"audit-linked.jsonl",
	"receipt.json",
	"protected-artifacts.json",
	"findings.json",
	"findings.md",
] as const;

export function evidenceRoot(dataDir: string): string {
	return join(dataDir, "evidence");
}

export function evidenceDirectory(dataDir: string, evidenceId: string): string {
	return join(evidenceRoot(dataDir), evidenceId);
}

export async function loadEvidenceOverview(dataDir: string, evidenceId: string): Promise<EvidenceOverview> {
	const raw = await readFile(join(evidenceDirectory(dataDir, evidenceId), "overview.json"), "utf8");
	const parsed = parseJson(raw, `${evidenceId}/overview.json`);
	return parseOverview(parsed, `${evidenceId}/overview.json`);
}

export async function inspectEvidence(dataDir: string, evidenceId: string): Promise<EvidenceInspectable> {
	const overview = await loadEvidenceOverview(dataDir, evidenceId);
	const findingsRaw = await readFile(join(evidenceDirectory(dataDir, evidenceId), "findings.json"), "utf8");
	const findingsParsed = parseJson(findingsRaw, `${evidenceId}/findings.json`);
	const findings = parseFindingsFile(findingsParsed, `${evidenceId}/findings.json`);
	return { overview, findings };
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
	const endpointIds = readStringArray(value, source, "endpointIds");
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
		endpointIds,
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
