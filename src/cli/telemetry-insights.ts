import { join, resolve } from "node:path";
import { cwdHash } from "../core/cwd-hash.js";
import { listStateDirectorySync, readStateFileSync } from "../core/state-boundary.js";
import type { ObjectRef } from "../core/telemetry/schemas.js";
import { clioStateDir } from "../core/xdg.js";
import {
	countVerifiedOutcomes,
	runHostVerified,
	type VerifiedOutcomeCount,
} from "../domains/evidence/verified-outcomes.js";
import { loadRepoTelemetrySources, loadRunRecord } from "../domains/session/telemetry-source.js";
import {
	autonomyLevel,
	classifySession,
	foldProjectInsights,
	INSIGHT_CATEGORIES,
	INSIGHTS_HEURISTIC_NOTE,
	outcomeLedgerProjection,
	type ProjectInsights,
	type SessionInsight,
	sessionSignals,
} from "../domains/telemetry/insights.js";
import { CONTENT_SUBJECTS, readTelemetryObjectSync } from "../domains/telemetry/objects.js";
import { telemetrySessionDirectory } from "../domains/telemetry/paths.js";
import { expandChainMessages } from "../tools/surface.js";
import { printError } from "./shared.js";

export const INSIGHTS_HELP = `clio-coder telemetry insights [--project [<dir>]] [--json]

insights classifies each recorded session into a research task category (data
analysis, writing and communication, data gathering, reading and knowledge
acquisition, theoretical analysis, design and development, ideation and
hypothesis generation, other) or non-research software work, gives it an
autonomy level from 1 to 5, and prints per project the category mix, the
autonomy distribution and the share of sessions with a verified outcome. It is a
heuristic over content-free telemetry: tool names, file kinds by extension,
check kinds, skill names, worker runs, approvals, operator message counts and
timing. It reads no message content and nothing leaves the machine. --project
limits it to one project: the current directory, or <dir>.
`;

const SAFE_ID = /^[a-zA-Z0-9_-]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The autonomy mode a settings object records; only a config object is ever read, never a content subject. */
function autonomyReader(stateDir: string, sessionId: string): (ref: ObjectRef) => string | null {
	const scope = telemetrySessionDirectory(stateDir, sessionId);
	return (ref) => {
		if (ref.subject !== "config" || CONTENT_SUBJECTS.has(ref.subject)) return null;
		try {
			const read = readTelemetryObjectSync(scope, ref);
			if (read.kind !== "resolved" || !isRecord(read.value) || !isRecord(read.value.safety)) return null;
			const mode = read.value.safety.autonomy;
			return typeof mode === "string" ? mode : null;
		} catch {
			// An unreadable settings object leaves the mode unknown; the other signals still classify the session.
			return null;
		}
	};
}

/**
 * The session's verified outcomes, counted by the outcome reader `/usage` uses over the ledger's typed projection.
 * Null when the ledger cannot be read, so the share counts the session as unknown rather than as none.
 */
function verifiedOutcomes(stateDir: string, ledgerPath: string, runIds: Iterable<string>): VerifiedOutcomeCount | null {
	let text: string;
	try {
		text = readStateFileSync(stateDir, ledgerPath).toString("utf8");
	} catch {
		// No ledger on this host: the outcome count is unknown.
		return null;
	}
	const entries: unknown[] = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// A torn line holds no entry the count could use.
			continue;
		}
		const projected = outcomeLedgerProjection(parsed);
		if (projected !== null) entries.push(projected);
	}
	const verified = new Set<string>();
	for (const runId of runIds) {
		try {
			if (runHostVerified(loadRunRecord(stateDir, runId))) verified.add(runId);
		} catch {
			// An unreadable run is not a verified one.
		}
	}
	return countVerifiedOutcomes(expandChainMessages(entries), verified);
}

function projectCwd(stateDir: string, bucketDir: string, sessionIds: readonly string[]): string | null {
	for (const id of sessionIds) {
		try {
			const meta = JSON.parse(readStateFileSync(stateDir, join(bucketDir, id, "meta.json")).toString("utf8")) as unknown;
			if (isRecord(meta) && typeof meta.cwd === "string") return meta.cwd;
		} catch {
			// Another session of the bucket may still name the directory.
		}
	}
	return null;
}

function readProjectInsights(stateDir: string, bucket: string): ProjectInsights {
	const bucketDir = join(stateDir, "sessions", bucket);
	const { sessions } = loadRepoTelemetrySources(stateDir, {
		cwdHash: bucket,
		from: 0,
		to: Number.MAX_SAFE_INTEGER,
		standaloneRuns: new Set(),
	});
	const rows: SessionInsight[] = [];
	for (const source of sessions) {
		if (source.processId !== undefined) continue;
		const signals = sessionSignals(
			source.journal.records,
			[...source.runs.values()].map((run) => run.records),
			autonomyReader(stateDir, source.sessionId),
		);
		const outcomes = verifiedOutcomes(stateDir, join(bucketDir, source.sessionId, "current.jsonl"), source.runs.keys());
		signals.verifiedChecks = outcomes?.checks ?? 0;
		rows.push({
			sessionId: source.sessionId,
			category: classifySession(signals),
			autonomy: autonomyLevel(signals),
			verifiedOutcomes: outcomes === null ? null : outcomes.total,
			signals,
		});
	}
	const ids = rows.map((row) => row.sessionId).sort();
	return foldProjectInsights(bucket, projectCwd(stateDir, bucketDir, ids), rows);
}

const percent = (part: number, whole: number) => (whole === 0 ? "0%" : `${Math.round((100 * part) / whole)}%`);

function printProject(project: ProjectInsights): string {
	const lines = [
		`project ${project.cwd ?? "(directory not recorded)"} [${project.project}] · ${project.sessions} session(s)`,
		"  categories",
	];
	for (const category of INSIGHT_CATEGORIES) {
		const n = project.categories[category];
		if (n > 0) lines.push(`    ${category.padEnd(36)} ${String(n).padStart(4)}  ${percent(n, project.sessions)}`);
	}
	lines.push(
		`  autonomy    ${(["1", "2", "3", "4", "5"] as const).map((level) => `${level}: ${project.autonomy[level]}`).join("  ")}`,
		`  verified    ${project.verified.sessions} of ${project.verified.known} session(s) with a verified outcome (${percent(project.verified.sessions, project.verified.known)})${
			project.verified.known < project.sessions
				? `; ${project.sessions - project.verified.known} without a readable ledger`
				: ""
		}`,
		"  sessions",
	);
	for (const row of project.rows)
		lines.push(
			`    ${row.sessionId}  ${row.category.padEnd(36)} autonomy ${row.autonomy}  verified ${
				row.verifiedOutcomes === null ? "unknown" : row.verifiedOutcomes
			}${row.signals.facetsMissing ? "  facets not recorded, classified on tool mix only" : ""}`,
		);
	return `${lines.join("\n")}\n`;
}

export async function runTelemetryInsights(argv: ReadonlyArray<string>): Promise<number> {
	let json = false;
	let project: string | null = null;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		if (arg === "--json") json = true;
		else if (arg === "--project" && project === null) {
			const next = argv[index + 1];
			if (next !== undefined && !next.startsWith("--")) {
				project = resolve(next);
				index += 1;
			} else project = process.cwd();
		} else {
			printError(`unknown insights argument: ${arg}`);
			process.stderr.write(INSIGHTS_HELP);
			return 2;
		}
	}
	const stateDir = clioStateDir();
	let buckets: string[];
	if (project !== null) buckets = [cwdHash(project)];
	else {
		try {
			buckets = listStateDirectorySync(stateDir, join(stateDir, "sessions"))
				.filter((name) => SAFE_ID.test(name))
				.sort();
		} catch {
			// No session store yet: there is nothing to classify.
			buckets = [];
		}
	}
	const projects = buckets.map((bucket) => readProjectInsights(stateDir, bucket)).filter((p) => p.sessions > 0);
	if (json) {
		process.stdout.write(`${JSON.stringify({ heuristic: INSIGHTS_HEURISTIC_NOTE, projects }, null, 2)}\n`);
		return 0;
	}
	process.stdout.write(`${INSIGHTS_HEURISTIC_NOTE}\n\n`);
	if (projects.length === 0) {
		process.stdout.write(
			project !== null ? `no recorded sessions for ${project}\n` : "no recorded sessions on this machine\n",
		);
		return 0;
	}
	process.stdout.write(projects.map(printProject).join("\n"));
	return 0;
}
