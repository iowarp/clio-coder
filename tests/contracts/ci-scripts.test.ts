import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";

interface PackageJson {
	scripts: Record<string, string>;
}

interface WorkflowStep {
	run?: string;
	uses?: string;
	with?: Record<string, unknown>;
	env?: Record<string, string>;
}

interface WorkflowJob {
	steps: WorkflowStep[];
	strategy?: {
		matrix?: Record<string, unknown>;
	};
}

function packageScripts(): Record<string, string> {
	const pkg = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
	return pkg.scripts;
}

function workflow(path: string): Record<string, unknown> {
	return parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function workflowJob(path: string, jobId: string): WorkflowJob {
	const parsed = workflow(path);
	const jobs = parsed.jobs as Record<string, WorkflowJob>;
	const job = jobs[jobId];
	if (!job) throw new Error(`workflow ${path} has no job ${jobId}`);
	return job;
}

function runCommands(path: string, jobId: string): string[] {
	return workflowJob(path, jobId).steps.flatMap((step) => (step.run ? [step.run] : []));
}

function matrixValues(path: string, jobId: string, key: string): unknown[] {
	const matrix = workflowJob(path, jobId).strategy?.matrix;
	const value = matrix?.[key];
	return Array.isArray(value) ? value : [];
}

function workflowDispatchTrigger(path: string): Record<string, unknown> | null {
	const parsed = workflow(path);
	const trigger = parsed.on;
	if (typeof trigger !== "object" || trigger === null || !("workflow_dispatch" in trigger)) return null;
	return trigger.workflow_dispatch as Record<string, unknown>;
}

describe("contracts/ci scripts", () => {
	it("keeps the deterministic local ci script aligned with the release-relevant checks", () => {
		const scripts = packageScripts();

		strictEqual(scripts.ci, "npm run typecheck && npm run lint && npm run build && npm run test");
		strictEqual(scripts["ci:release"], "npm run ci && node scripts/check-dist.mjs");
		strictEqual(scripts["test:repeat"], "node tests/harness/repeat-tests.mjs");
		ok(scripts["test:coverage"]?.includes("--experimental-test-coverage"));
		ok(scripts["test:coverage"]?.includes("--test-coverage-include='src/**/*.ts'"));
		strictEqual(scripts.prepublishOnly, "npm run ci:release");
	});

	it("runs the release gate, including dist integrity, in hosted CI", () => {
		const commands = runCommands(".github/workflows/ci.yml", "ci");
		const setupNode = workflowJob(".github/workflows/ci.yml", "ci").steps.find(
			(step) => step.uses === "actions/setup-node@v6",
		);

		deepStrictEqual(matrixValues(".github/workflows/ci.yml", "ci", "node-version"), [22, 24]);
		strictEqual(setupNode?.with?.["node-version"], "$" + "{{ matrix.node-version }}");
		ok(commands.includes("npm run ci:release"), commands.join("\n"));
		ok(commands.includes("npm run test:repeat"), commands.join("\n"));
		ok(
			commands.some((command) => command.includes("npm run test:coverage")),
			commands.join("\n"),
		);
		ok(!commands.includes("npm run test:live"), "ordinary CI must not run live/model-dependent smoke tests");
	});

	it("keeps live smoke explicit and outside the deterministic gate", () => {
		const env = workflowJob(".github/workflows/live-smoke.yml", "live-smoke").steps.find(
			(step) => step.env?.CLIO_LIVE_SMOKE !== undefined,
		)?.env;

		ok(workflowDispatchTrigger(".github/workflows/live-smoke.yml"), "live smoke must be workflow_dispatch-only");
		strictEqual(env?.CLIO_LIVE_SMOKE, "1");
		deepStrictEqual(
			runCommands(".github/workflows/live-smoke.yml", "live-smoke").filter((command) => command.includes("test:live")),
			["npm run test:live"],
		);
	});
});
