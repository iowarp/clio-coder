import { match, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runNodeScript } from "../../../tests/harness/spawn.js";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const CAMPAIGN = join(REPO_ROOT, "benchmarks", "internal", "campaign.ts");
const REPORT = join(REPO_ROOT, "benchmarks", "internal", "report.ts");

describe("contracts/benchmark campaign report", () => {
	let campaign: string;

	beforeEach(() => {
		campaign = mkdtempSync(join(tmpdir(), "clio-benchmark-report-"));
		writeFileSync(join(campaign, "campaign.json"), '{"schemaVersion":1}\n', "utf8");
	});

	afterEach(() => {
		rmSync(campaign, { recursive: true, force: true });
	});

	it("freezes harness and task status independently and refuses overwrite", async () => {
		const summary = join(campaign, "summary.json");
		writeFileSync(summary, '{"resolved":1}\n', "utf8");
		const args = [
			"--campaign",
			campaign,
			"--status",
			"human-eval=valid,pass",
			"--result",
			`human-eval=${summary}`,
			"--status",
			"terminal-bench=blocked,not_scored",
		];
		const first = await runNodeScript(REPORT, args, { cwd: REPO_ROOT });
		strictEqual(first.code, 0, first.stderr);
		const report = JSON.parse(readFileSync(join(campaign, "report.json"), "utf8"));
		strictEqual(report.attempts[0].harnessStatus, "valid");
		strictEqual(report.attempts[0].taskStatus, "pass");
		strictEqual(report.attempts[0].result.summary.resolved, 1);
		strictEqual(report.attempts[1].harnessStatus, "blocked");
		strictEqual(report.attempts[1].taskStatus, "not_scored");

		const second = await runNodeScript(REPORT, args, { cwd: REPO_ROOT });
		strictEqual(second.code, 1);
		match(second.stderr, /already exists/);
	});

	it("rejects status vocabulary outside the result contract", async () => {
		const result = await runNodeScript(REPORT, ["--campaign", campaign, "--status", "human-eval=green,probably"], {
			cwd: REPO_ROOT,
		});
		strictEqual(result.code, 2);
		match(result.stderr, /usage:/);
	});

	it("allows only one concurrent report freeze and leaves a complete pair", async () => {
		const summary = join(campaign, "summary.json");
		writeFileSync(summary, JSON.stringify({ padding: "x".repeat(2_000_000) }), "utf8");
		const args = ["--campaign", campaign, "--status", "human-eval=valid,pass", "--result", `human-eval=${summary}`];
		const results = await Promise.all([
			runNodeScript(REPORT, args, { cwd: REPO_ROOT }),
			runNodeScript(REPORT, args, { cwd: REPO_ROOT }),
		]);
		strictEqual(
			results.filter((result) => result.code === 0).length,
			1,
			results.map((result) => `${result.code}: ${result.stderr}`).join("\n"),
		);
		strictEqual(results.filter((result) => result.code === 1).length, 1);
		JSON.parse(readFileSync(join(campaign, "report.json"), "utf8"));
		match(readFileSync(join(campaign, "report.md"), "utf8"), /Benchmark campaign report/);
	});

	it("refuses to replace an existing campaign provenance manifest", async () => {
		const result = await runNodeScript(
			CAMPAIGN,
			["--out", campaign, "--target", "fixture-target", "--model", "fixture-model", "--thinking", "off"],
			{ cwd: REPO_ROOT },
		);
		strictEqual(result.code, 1);
		match(result.stderr, /campaign manifest already exists/);
		strictEqual(readFileSync(join(campaign, "campaign.json"), "utf8"), '{"schemaVersion":1}\n');
	});

	it("rejects an impossible thinking level before freezing provenance", async () => {
		const result = await runNodeScript(
			CAMPAIGN,
			["--out", campaign, "--target", "fixture-target", "--model", "fixture-model", "--thinking", "bogus"],
			{ cwd: REPO_ROOT },
		);
		strictEqual(result.code, 2);
		match(result.stderr, /usage:/);
	});
});
