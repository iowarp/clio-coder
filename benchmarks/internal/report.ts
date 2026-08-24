#!/usr/bin/env node
/** Freeze the two-axis outcome table for one ignored benchmark campaign. */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

type HarnessStatus = "valid" | "invalid" | "blocked";
type TaskStatus = "pass" | "fail" | "timeout" | "not_scored";

type Outcome = {
	harnessStatus: HarnessStatus;
	taskStatus: TaskStatus;
};

function usage(): never {
	process.stderr.write(
		"usage: node --import tsx benchmarks/internal/report.ts --campaign <dir> --status suite=valid,pass [--result suite=summary.json]... [--note suite=text]...\n",
	);
	process.exit(2);
}

function pair(value: string): [string, string] {
	const separator = value.indexOf("=");
	if (separator < 1 || separator === value.length - 1) usage();
	return [value.slice(0, separator), value.slice(separator + 1)];
}

function sha256(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function main(): void {
	let campaignDir: string | undefined;
	const outcomes = new Map<string, Outcome>();
	const results = new Map<string, string>();
	const notes = new Map<string, string>();
	const argv = process.argv.slice(2);
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag || !value) usage();
		if (flag === "--campaign") campaignDir = resolve(value);
		else if (flag === "--result") {
			const [suite, path] = pair(value);
			results.set(suite, resolve(path));
		} else if (flag === "--note") {
			const [suite, note] = pair(value);
			notes.set(suite, note);
		} else if (flag === "--status") {
			const [suite, statuses] = pair(value);
			const [harnessStatus, taskStatus, extra] = statuses.split(",");
			if (extra !== undefined || !isHarnessStatus(harnessStatus) || !isTaskStatus(taskStatus)) {
				usage();
			}
			outcomes.set(suite, { harnessStatus, taskStatus });
		} else usage();
	}
	if (!campaignDir || outcomes.size === 0) usage();
	const campaignPath = join(campaignDir, "campaign.json");
	const reportPath = join(campaignDir, "report.json");
	const markdownPath = join(campaignDir, "report.md");
	const claimPath = join(campaignDir, ".report.claim");
	if (!existsSync(campaignPath)) throw new Error(`campaign manifest not found: ${campaignPath}`);
	if (existsSync(reportPath) || existsSync(markdownPath)) {
		throw new Error(`campaign report already exists; preserve it and create a new campaign: ${campaignDir}`);
	}
	const campaign: unknown = JSON.parse(readFileSync(campaignPath, "utf8"));
	const attempts = [...outcomes.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([suite, outcome]) => {
			const resultPath = results.get(suite);
			if (!resultPath) return { suite, ...outcome, note: notes.get(suite) ?? null, result: null };
			const bytes = readFileSync(resultPath);
			return {
				suite,
				...outcome,
				note: notes.get(suite) ?? null,
				result: {
					path: resultPath,
					bytes: statSync(resultPath).size,
					sha256: sha256(bytes),
					summary: JSON.parse(bytes.toString("utf8")) as unknown,
				},
			};
		});
	const report = {
		schemaVersion: 1,
		campaign: basename(campaignDir),
		campaignManifest: campaign,
		attempts,
	};
	const table = [
		"# Benchmark campaign report",
		"",
		`Campaign: \`${basename(campaignDir)}\``,
		"",
		"| Suite | Harness | Task | Result | Note |",
		"| --- | --- | --- | --- | --- |",
		...attempts.map(
			(attempt) =>
				`| ${attempt.suite} | ${attempt.harnessStatus} | ${attempt.taskStatus} | ${attempt.result ? "summary.json" : "—"} | ${attempt.note ?? ""} |`,
		),
		"",
		"A task result is interpretable only when its harness status is `valid`.",
		"",
	];
	const nonce = `${process.pid}-${randomUUID()}`;
	const pendingReportPath = join(campaignDir, `.report-${nonce}.json.pending`);
	const pendingMarkdownPath = join(campaignDir, `.report-${nonce}.md.pending`);
	let claimed = false;
	let reportLinked = false;
	let markdownLinked = false;
	try {
		try {
			writeFileSync(claimPath, `${nonce}\n`, { encoding: "utf8", flag: "wx" });
			claimed = true;
		} catch (error) {
			if (isAlreadyExists(error)) {
				throw new Error(`campaign report is already being frozen; preserve its claim: ${claimPath}`);
			}
			throw error;
		}
		if (existsSync(reportPath) || existsSync(markdownPath)) {
			throw new Error(`campaign report already exists; preserve it and create a new campaign: ${campaignDir}`);
		}
		writeFileSync(pendingReportPath, `${JSON.stringify(report, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
		writeFileSync(pendingMarkdownPath, table.join("\n"), { encoding: "utf8", flag: "wx" });
		linkSync(pendingReportPath, reportPath);
		reportLinked = true;
		linkSync(pendingMarkdownPath, markdownPath);
		markdownLinked = true;
	} catch (error) {
		if (markdownLinked) rmSync(markdownPath, { force: true });
		if (reportLinked) rmSync(reportPath, { force: true });
		if (isAlreadyExists(error)) {
			throw new Error(`campaign report already exists; preserve it and create a new campaign: ${campaignDir}`);
		}
		throw error;
	} finally {
		rmSync(pendingMarkdownPath, { force: true });
		rmSync(pendingReportPath, { force: true });
		if (claimed) rmSync(claimPath, { force: true });
	}
	process.stdout.write(`${reportPath}\n${markdownPath}\n`);
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isHarnessStatus(value: string | undefined): value is HarnessStatus {
	return value === "valid" || value === "invalid" || value === "blocked";
}

function isTaskStatus(value: string | undefined): value is TaskStatus {
	return value === "pass" || value === "fail" || value === "timeout" || value === "not_scored";
}

main();
