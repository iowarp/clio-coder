import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalRunArtifact, EvalRunRecord } from "./types.js";

interface RunEnvelopeLike {
	id: string;
	cwd: string;
	startedAt: string;
	endedAt: string | null;
	receiptPath: string | null;
	sessionId: string | null;
}

interface LinkedRunPaths {
	receipt?: string;
	sessionLedger?: string;
}

export async function linkEvalArtifactRuntimePaths(
	artifact: EvalRunArtifact,
	stateDir: string,
	evidencePath?: string,
): Promise<EvalRunArtifact> {
	const matches = (await readRunLedger(stateDir)).filter((envelope) => evalRunMatches(artifact, envelope));
	const linksByCwd = await linksByCwdForRuns(stateDir, matches);
	const receipts = uniqueStrings(
		[...linksByCwd.values()].flatMap((links) =>
			links.flatMap((link) => (link.receipt === undefined ? [] : [link.receipt])),
		),
	);
	const sessionLedgers = uniqueStrings(
		[...linksByCwd.values()].flatMap((links) =>
			links.flatMap((link) => (link.sessionLedger === undefined ? [] : [link.sessionLedger])),
		),
	);
	return {
		...artifact,
		paths: {
			...artifact.paths,
			...(evidencePath === undefined ? {} : { evidence: evidencePath }),
			receipts,
			sessionLedgers,
		},
		results: artifact.results.map((result) => linkResult(result, linksByCwd.get(result.cwd)?.[0], evidencePath)),
	};
}

async function readRunLedger(stateDir: string): Promise<RunEnvelopeLike[]> {
	try {
		const parsed = JSON.parse(await readFile(join(stateDir, "runs.json"), "utf8")) as unknown;
		return Array.isArray(parsed) ? parsed.flatMap(parseRunEnvelopeLike) : [];
	} catch {
		return [];
	}
}

function parseRunEnvelopeLike(value: unknown): RunEnvelopeLike[] {
	if (!isRecord(value)) return [];
	const id = stringField(value, "id");
	const cwd = stringField(value, "cwd");
	const startedAt = stringField(value, "startedAt");
	if (id === undefined || cwd === undefined || startedAt === undefined) return [];
	return [
		{
			id,
			cwd,
			startedAt,
			endedAt: nullableStringField(value, "endedAt"),
			receiptPath: nullableStringField(value, "receiptPath"),
			sessionId: nullableStringField(value, "sessionId"),
		},
	];
}

function evalRunMatches(artifact: EvalRunArtifact, envelope: RunEnvelopeLike): boolean {
	const cwds = new Set(artifact.results.map((result) => result.cwd));
	if (!cwds.has(envelope.cwd)) return false;
	const evalStart = Date.parse(artifact.startedAt);
	const evalEnd = Date.parse(artifact.endedAt);
	const runStart = Date.parse(envelope.startedAt);
	const runEnd = envelope.endedAt === null ? runStart : Date.parse(envelope.endedAt);
	if (![evalStart, evalEnd, runStart, runEnd].every(Number.isFinite)) return false;
	return runStart <= evalEnd && runEnd >= evalStart;
}

async function linksByCwdForRuns(
	stateDir: string,
	runs: ReadonlyArray<RunEnvelopeLike>,
): Promise<Map<string, LinkedRunPaths[]>> {
	const out = new Map<string, LinkedRunPaths[]>();
	for (const run of [...runs].sort(compareRunEnvelopeLike)) {
		const receipt = await existingPath(run.receiptPath ?? join(stateDir, "receipts", `${run.id}.json`));
		const sessionLedger = run.sessionId === null ? undefined : await findSessionLedgerPath(stateDir, run.sessionId);
		if (receipt === undefined && sessionLedger === undefined) continue;
		const list = out.get(run.cwd) ?? [];
		list.push({
			...(receipt === undefined ? {} : { receipt }),
			...(sessionLedger === undefined ? {} : { sessionLedger }),
		});
		out.set(run.cwd, list);
	}
	return out;
}

function linkResult(
	result: EvalRunRecord,
	paths: LinkedRunPaths | undefined,
	evidencePath: string | undefined,
): EvalRunRecord {
	if (paths === undefined && evidencePath === undefined) return result;
	return {
		...result,
		...(paths?.receipt === undefined ? {} : { receiptPath: paths.receipt }),
		paths: {
			...(result.paths ?? {}),
			...(paths?.receipt === undefined ? {} : { receipt: paths.receipt }),
			...(paths?.sessionLedger === undefined ? {} : { sessionLedger: paths.sessionLedger }),
			...(evidencePath === undefined ? {} : { evidence: evidencePath }),
		},
	};
}

async function findSessionLedgerPath(stateDir: string, sessionId: string): Promise<string | undefined> {
	const root = join(stateDir, "sessions");
	let cwdHashes: string[];
	try {
		cwdHashes = await readdir(root);
	} catch {
		return undefined;
	}
	for (const cwdHash of cwdHashes.sort(compareStrings)) {
		const path = await existingPath(join(root, cwdHash, sessionId, "current.jsonl"));
		if (path !== undefined) return path;
	}
	return undefined;
}

async function existingPath(path: string): Promise<string | undefined> {
	try {
		await access(path);
		return path;
	} catch {
		return undefined;
	}
}

function uniqueStrings(values: ReadonlyArray<string>): string[] {
	return [...new Set(values)].sort(compareStrings);
}

function compareRunEnvelopeLike(a: RunEnvelopeLike, b: RunEnvelopeLike): number {
	return compareStrings(a.startedAt, b.startedAt) || compareStrings(a.id, b.id);
}

function compareStrings(a: string, b: string): number {
	return a.localeCompare(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nullableStringField(record: Record<string, unknown>, field: string): string | null {
	const value = record[field];
	return typeof value === "string" && value.length > 0 ? value : null;
}
