import { ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

test("installed-package CI gate packs an absolute tarball and is required by ci (22)", () => {
	const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
	const job = workflow.jobs["installed-package"];
	ok(job, "installed package suite must run in routine CI");
	strictEqual(job["timeout-minutes"], 6);
	const commands = job.steps.map((step: { run?: string }) => step.run ?? "").join("\n");
	ok(commands.includes("pnpm run build"));
	ok(commands.includes("npm pack --pack-destination"));
	ok(commands.includes("mktemp -d"));
	ok(commands.includes('CLIO_CODER_RELEASE_TARBALL="$pack_dir/'));
	ok(commands.includes("pnpm run test:package"));
	ok(workflow.jobs.ci.needs.includes("installed-package"));
	ok(workflow.jobs.ci.steps[0].run.includes("needs.installed-package.result"));
	strictEqual(workflow.jobs.ci.name, "ci (22)");
	strictEqual(workflow.jobs["runtime-compatibility"].name, "ci (24)");
});
