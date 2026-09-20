import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { clioDataDir } from "../../../../../src/core/xdg.js";
import { loadEvalArtifactV4 } from "../../../../../src/domains/eval/artifacts/store.js";
import { type EvalStoredReport, listEvalReports } from "../../../../../src/domains/eval/inventory.js";
import type { EvalRequest } from "../../../contracts/reports.js";
import { AppProblem } from "../../services/problem.js";
import { artifactPage, containedFile } from "./storage.js";

function project(row: EvalStoredReport) {
	const a = row.artifact;
	return {
		evalId: row.evalId,
		startedAt: row.startedAt,
		suiteId: a.suite.id,
		clioCoder: { version: a.clioCoder.version, commit: a.clioCoder.commit },
		environment: a.environment,
		matrix: a.matrix,
		servingConfiguration: a.servingConfiguration ?? null,
		summary: a.summary,
	};
}
async function listing(data: string) {
	let files: string[];
	try {
		files = readdirSync(join(data, "evals")).filter((name) => name.endsWith(".json"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return listEvalReports(data, 0);
		throw error;
	}
	if (files.length > 10_000) throw new AppProblem("unavailable", "Eval inventory exceeds 10,000 reports.");
	let bytes = 0;
	for (const name of files) {
		const path = containedFile(data, "evals", name);
		if (!path) throw new AppProblem("unavailable", "Eval storage contains an unsafe or oversized report.");
		bytes += statSync(path).size;
		if (bytes > 64 * 1024 * 1024) throw new AppProblem("unavailable", "Eval inventory exceeds 64 MiB.");
	}
	return listEvalReports(data, files.length);
}
export async function readEvals(input: EvalRequest) {
	const data = clioDataDir();
	const all = await listing(data);
	if (input.kind === "list") {
		const page = artifactPage(
			all.reports.map((row) => ({ id: row.evalId, startedAt: row.startedAt ?? "1970-01-01T00:00:00.000Z", row })),
			input.limit,
			input.cursor,
		);
		return {
			available: all.available,
			stored: all.stored,
			unreadable: all.unreadable,
			items: page.items.map((item) => project(item.row)),
			nextCursor: page.nextCursor,
		};
	}
	const row = all.reports.find((row) => row.evalId === input.id);
	if (!row) throw new AppProblem("not_found", "No readable current-format eval report with this ID.");
	const artifact = await loadEvalArtifactV4(data, input.id);
	return {
		report: project(row),
		aggregates: artifact.aggregates ?? null,
		results: artifact.results.map((result) => ({
			taskId: result.taskId,
			repeatIndex: result.repeatIndex,
			target: result.target,
			pass: result.pass,
			failureClass: result.failureClass,
			assignmentId: result.assignmentId,
			terminalReceiptRecorded: result.terminalReceiptDigest !== null,
			metrics: result.metrics,
			attachments: Object.keys(result.artifacts).length,
			verdict: result.verdict ?? null,
			behavioral: result.behavioral ?? null,
			behavioralMetrics: result.behavioralMetrics ?? null,
		})),
	};
}
