import { match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import {
	CODE_STEP_CAPTURE_MAX_BYTES,
	CODE_STEP_EXCERPT_MAX_BYTES,
	runCodeStep,
} from "../../src/domains/dispatch/code-step.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function run(script: string) {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-code-step-output-"));
	roots.push(root);
	return runCodeStep({
		stepId: "measurement",
		command: {
			id: "value",
			argv: [process.execPath, "-e", script],
			cwd: "",
			timeoutMs: 30_000,
			env: [],
			description: "Local measurement fixture",
		},
		workspaceRoot: root,
		artifactDir: join(root, "artifacts"),
	});
}

it("carries stdout beyond the report excerpt and retains stderr diagnostics in the artifact", async () => {
	const payload = `${" ".repeat(CODE_STEP_EXCERPT_MAX_BYTES)}{"value":2}\n`;
	const diagnostic = '{"energy":1}\n';
	const result = await run(
		`process.stdout.write(${JSON.stringify(payload)}); process.stderr.write(${JSON.stringify(diagnostic)});`,
	);
	strictEqual(result.record.exitCode, 0);
	strictEqual(result.stdout, payload);
	strictEqual(JSON.parse(result.stdout).value, 2);
	ok(result.stdout.length > CODE_STEP_EXCERPT_MAX_BYTES);
	const artifactPath = result.record.artifactPaths[0];
	ok(artifactPath);
	const artifact = readFileSync(artifactPath, "utf8");
	ok(artifact.includes(payload));
	ok(artifact.includes(diagnostic));
	match(result.report.outputExcerpt, /output truncated/u);
});

it("bounds stdout with the existing command capture cap", async () => {
	const producedBytes = CODE_STEP_CAPTURE_MAX_BYTES + 4096;
	const result = await run(`process.stdout.write("x".repeat(${producedBytes}));`);
	strictEqual(result.record.exitCode, 0);
	strictEqual(Buffer.byteLength(result.stdout, "utf8"), CODE_STEP_CAPTURE_MAX_BYTES);
	strictEqual(result.record.outputBytes, producedBytes);
	strictEqual(result.record.outputTruncated, true);
});

it("fails the check when a newly reported test fails outside the declared suite", async () => {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-changed-test-"));
	roots.push(root);
	writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test visible.test.cjs" } }));
	writeFileSync(join(root, "visible.test.cjs"), "require('node:test')('visible', () => {});\n");
	writeFileSync(
		join(root, "repro.test.cjs"),
		"require('node:test')('reproduction', () => { throw Error('still broken'); });\n",
	);
	const input = {
		stepId: "check",
		command: {
			id: "test",
			argv: [process.execPath, "--test", "visible.test.cjs"],
			cwd: "",
			timeoutMs: 30_000,
			env: [],
			description: "Declared suite",
		},
		workspaceRoot: root,
	};
	strictEqual((await runCodeStep(input)).report.passed, true);
	const failed = await runCodeStep({ ...input, mutatedPaths: ["repro.test.cjs"] });
	strictEqual(failed.report.passed, false);
	strictEqual(failed.report.exitCode, 1);
	strictEqual(failed.report.checks[0]?.passed, true);
	strictEqual(failed.report.checks[1]?.passed, false);
	match(failed.report.outputExcerpt, /still broken/u);
	writeFileSync(join(root, "repro.test.cjs"), "require('node:test')('reproduction', () => {});\n");
	strictEqual((await runCodeStep({ ...input, mutatedPaths: ["repro.test.cjs"] })).report.passed, true);
	writeFileSync(join(root, "repro.test.unknown"), "no runner\n");
	const fallback = await runCodeStep({ ...input, mutatedPaths: ["repro.test.unknown"] });
	strictEqual(fallback.report.passed, true);
	match(fallback.report.outputExcerpt, /no recognizable project runner.*declared check only/u);
});
