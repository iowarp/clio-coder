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
	if?: string;
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

		strictEqual(scripts.ci, "npm run typecheck && npm run lint && npm run skills:check && npm run build && npm run test");
		strictEqual(scripts["skills:check"], "node --import tsx scripts/pin-skills.ts --check");
		strictEqual(scripts["ci:release"], "npm run ci && node scripts/check-release.mjs");
		strictEqual(scripts["test:repeat"], "node tests/harness/repeat-tests.mjs");
		ok(scripts["test:coverage"]?.includes("--experimental-test-coverage"));
		ok(scripts["test:coverage"]?.includes("--test-coverage-include='src/**/*.ts'"));
		strictEqual(scripts.prepublishOnly, "npm run ci:release");
	});

	it("runs the release gate, including dist integrity, in hosted CI", () => {
		const commands = runCommands(".github/workflows/ci.yml", "ci");
		const steps = workflowJob(".github/workflows/ci.yml", "ci").steps;
		const setupNode = steps.find((step) => step.uses === "actions/setup-node@v6");

		deepStrictEqual(matrixValues(".github/workflows/ci.yml", "ci", "node-version"), [22, 24]);
		strictEqual(setupNode?.with?.["node-version"], "$" + "{{ matrix.node-version }}");
		ok(!commands.includes("npm run test:live"), "ordinary CI must not run live/model-dependent smoke tests");

		// One full-suite run per lane: the engines floor runs the canonical
		// gate; the 24 lane's only full-suite run is coverage-instrumented.
		const gate = steps.find((step) => step.run === "npm run ci:release");
		strictEqual(gate?.if, "matrix.node-version == 22", "the full release gate runs once, on the engines floor");
		const build = steps.find((step) => step.run === "npm run build");
		strictEqual(build?.if, "matrix.node-version == 24", "the 24 lane must build dist for the smoke tests");
		const coverage = steps.find((step) => step.run?.includes("npm run test:coverage"));
		strictEqual(coverage?.if, "matrix.node-version == 24");
		ok(coverage?.run?.includes("set -o pipefail"), "tee must not mask a failing coverage suite");
		const repeat = steps.find((step) => step.run === "npm run test:repeat");
		strictEqual(repeat?.if, "matrix.node-version == 24");
		ok(!commands.includes("npm run test"), "no lane runs the plain suite alongside the gate or coverage run");
	});

	it("publishes from version tags through the release gate with provenance", () => {
		const parsed = workflow(".github/workflows/release.yml");
		const trigger = parsed.on as { push?: { tags?: unknown } };
		deepStrictEqual(trigger.push?.tags, ["v*"], "release must trigger on v* tags only");

		const permissions = parsed.permissions as Record<string, string>;
		strictEqual(permissions["id-token"], "write", "npm provenance needs the OIDC id-token permission");

		const commands = runCommands(".github/workflows/release.yml", "release");
		ok(
			commands.some((command) => command.includes("npm publish --provenance")),
			commands.join("\n"),
		);
		ok(
			commands.some((command) => command.includes("does not match tag")),
			"release must refuse a tag that disagrees with package.json's version",
		);
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
