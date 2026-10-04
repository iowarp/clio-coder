import { doesNotThrow, ok, strictEqual, throws } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

test("manual qualification prepares one artifact and both required runtimes consume it", () => {
	const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
	strictEqual(Object.keys(workflow.on).join(), "workflow_dispatch");
	ok(workflow.jobs.prepare.steps.some((step: { run?: string }) => step.run?.includes("release-candidate.mjs prepare")));
	for (const key of ["ci", "runtime-compatibility"]) {
		strictEqual(workflow.jobs[key].needs, "prepare");
		strictEqual(workflow.jobs[key].if, `\${{ always() }}`);
		ok(workflow.jobs[key].steps.some((step: { run?: string }) => step.run?.includes('test "$PREPARE_RESULT" = success')));
		ok(workflow.jobs[key].steps.some((step: { uses?: string }) => step.uses?.startsWith("actions/download-artifact@")));
		ok(!workflow.jobs[key].steps.some((step: { run?: string }) => /build|npm pack/u.test(step.run ?? "")));
	}
	ok(workflow.jobs.ci.steps.some((step: { run?: string }) => step.run?.includes("release-candidate.mjs test")));
	strictEqual(workflow.jobs.ci.name, "ci (22)");
	strictEqual(workflow.jobs["runtime-compatibility"].name, "ci (24)");
});

test("qualification rejects another commit, automatic events, and failed required gates", async () => {
	const module = "../../scripts/release-publish.mjs";
	const { verifyQualificationRecord } = await import(module);
	const commit = "a".repeat(40);
	const record = {
		head_sha: commit,
		path: ".github/workflows/ci.yml",
		event: "workflow_dispatch",
		status: "completed",
		conclusion: "success",
	};
	const jobs = ["prepare", "ci (22)", "ci (24)"].map((name) => ({ name, conclusion: "success" }));
	doesNotThrow(() => verifyQualificationRecord(record, jobs, commit));
	throws(() => verifyQualificationRecord(record, jobs, "b".repeat(40)), /exact commit/u);
	throws(() => verifyQualificationRecord({ ...record, event: "push" }, jobs, commit), /manual/u);
	throws(() => verifyQualificationRecord(record, jobs.slice(0, 2), commit), /ci \(24\)/u);
	throws(() => verifyQualificationRecord({ ...record, conclusion: "failure" }, jobs, commit), /successful/u);
	const rerun = jobs.map((job, index) => ({ ...job, id: index + 1 }));
	doesNotThrow(() =>
		verifyQualificationRecord(record, [...rerun, { id: 4, name: "ci (22)", conclusion: "success" }], commit),
	);
	throws(
		() => verifyQualificationRecord(record, [...rerun, { id: 4, name: "ci (22)", conclusion: "failure" }], commit),
		/ci \(22\)/u,
	);
});

test("candidate checksums bind its archive version, site provenance, and installer bytes", async () => {
	const module = "../../scripts/release-candidate.mjs";
	const { installers, sha256, verifyCandidate } = await import(module);
	const scratch = mkdtempSync(join(tmpdir(), "clio-coder-candidate-contract-"));
	try {
		const commit = "a".repeat(40);
		const pkg = { name: "@iowarp/clio-coder", version: "0.6.2" };
		mkdirSync(join(scratch, "package"));
		writeFileSync(join(scratch, "package/package.json"), JSON.stringify(pkg));
		execFileSync("tar", ["-czf", join(scratch, "iowarp-clio-coder-0.6.2.tgz"), "-C", scratch, "package"]);
		mkdirSync(join(scratch, "site"));
		writeFileSync(
			join(scratch, "site/version.json"),
			JSON.stringify({ publishedVersion: pkg.version, docsCommit: commit, revision: commit }),
		);
		execFileSync("tar", ["-czf", join(scratch, "website.tgz"), "-C", join(scratch, "site"), "."]);
		for (const name of [...installers, "release-notes.md", "metafile-esm.json"]) writeFileSync(join(scratch, name), name);
		const files = Object.fromEntries(
			["iowarp-clio-coder-0.6.2.tgz", "website.tgz", ...installers, "release-notes.md", "metafile-esm.json"].map(
				(name) => [name, sha256(readFileSync(join(scratch, name)))],
			),
		);
		const receipt = { schema: 2, ...pkg, commit, files };
		writeFileSync(join(scratch, "candidate.json"), JSON.stringify(receipt));
		doesNotThrow(() => verifyCandidate(scratch, commit));
		throws(() => verifyCandidate(scratch, "b".repeat(40)), /source commit/u);
		writeFileSync(join(scratch, "candidate.json"), JSON.stringify({ ...receipt, version: "0.6.3" }));
		throws(() => verifyCandidate(scratch, commit), /inventory/u);
		writeFileSync(join(scratch, "candidate.json"), JSON.stringify(receipt));
		writeFileSync(join(scratch, "install.sh"), "tampered installer");
		throws(() => verifyCandidate(scratch, commit), /checksum mismatch: install.sh/u);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("publication waits for owner approval and reuses a specified qualification run", () => {
	const workflow = parse(readFileSync(".github/workflows/release.yml", "utf8"));
	strictEqual(Object.keys(workflow.on).join(), "workflow_dispatch");
	strictEqual(workflow.jobs.release.environment, "release");
	strictEqual(workflow.jobs.release.needs, "preflight");
	strictEqual(workflow.jobs.release.permissions["id-token"], "write");
	for (const job of Object.values(workflow.jobs) as Array<{
		steps: Array<{ run?: string; uses?: string; with?: Record<string, unknown> }>;
	}>) {
		ok(
			job.steps.some(
				(step) =>
					step.uses?.startsWith("actions/download-artifact@") &&
					step.with?.["run-id"] === `\${{ inputs.qualification_run }}`,
			),
		);
		ok(!job.steps.some((step) => /pnpm|npm (?:install|pack)|test:|run build/u.test(step.run ?? "")));
	}
});
