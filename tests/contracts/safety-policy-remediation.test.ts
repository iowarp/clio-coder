import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clioConfigDir } from "../../src/core/xdg.js";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { loadProjectSafetyPolicy } from "../../src/domains/safety/project-policy.js";

const root = mkdtempSync(join(tmpdir(), "s1-policy-"));
mkdirSync(join(root, ".clio-coder"));
writeFileSync(join(root, ".clio-coder/safety.yaml"), "version: 1\ndisableDefaultPathPolicy: true\n");
const engine = () => createSafetyPolicyEngine({ cwd: root, projectPolicy: loadProjectSafetyPolicy(root) });
test("S1-01 project exemptions preserve user secrets while relaxing project defaults", () => {
	for (const path of [join(clioConfigDir(), "credentials.yaml"), join(homedir(), ".ssh/id_rsa")]) {
		assert.equal(engine().evaluate({ tool: "read", args: { path } }).kind, "block", path);
	}
	assert.equal(engine().evaluate({ tool: "read", args: { path: join(root, ".env") } }).kind, "allow");
	assert.equal(
		engine().evaluate({ tool: "write", args: { path: join(clioConfigDir(), "skills/example/SKILL.md") } }).kind,
		"block",
	);
});
test("S1-04 settings are immutable even with project exemptions and confirmation", () => {
	for (const tool of ["write", "edit"])
		for (const posture of [undefined, "confirmed"]) {
			const result = engine().evaluate({ tool, args: { path: join(clioConfigDir(), "settings.yaml") } }, posture);
			assert.equal(result.reasonCode, "path-policy:readOnlyPaths");
			assert.equal(result.kind, "block");
		}
});
test("S1-02 hidden paths require confirmation", () => {
	for (const command of [
		"cat $HOME/.ssh/id_rsa",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell parameter expansion is the attack fixture.
		"cat ${HOME}/.ssh/id_rsa",
		`python3 -c "print(open('/home/u/.ssh/id_rsa').read())"`,
	]) {
		assert.notEqual(engine().evaluate({ tool: "bash", args: { command } }).kind, "allow", command);
	}
});
test("S1-03 repository scripts require approval; inert commands stay recognized", () => {
	const policy = createSafetyPolicyEngine({ cwd: root });
	assert.equal(policy.evaluate({ tool: "bash", args: { command: "npm test" } }).kind, "ask");
	for (const command of ["pwd", "git status"])
		assert.equal(policy.evaluate({ tool: "bash", args: { command } }).execRecognition, "recognized");
});

test("S1-03 trusted declarations recognize scripts but untrusted declarations cannot authorize themselves", () => {
	writeFileSync(
		join(root, ".clio-coder/safety.yaml"),
		"version: 1\ncommands:\n  - id: test\n    command: npm test\n    actionClass: execute\n",
	);
	const approved = engine();
	assert.equal(approved.evaluate({ tool: "bash", args: { command: "npm test" } }).execRecognition, "recognized");
	assert.equal(
		createSafetyPolicyEngine({ cwd: root }).evaluate({ tool: "bash", args: { command: "npm test" } }).kind,
		"ask",
	);
});
test("S1-03 chain and shell wrappers cannot bypass script approval", () => {
	const policy = createSafetyPolicyEngine({ cwd: root });
	for (const command of ["pwd && npm test", "sh -c 'npm test'", "npm test | tee output.txt", "npm test && echo done"])
		assert.equal(policy.evaluate({ tool: "bash", args: { command } }).kind, "ask");
});
test("S1 trust records and grant CLI remain operator authority", async () => {
	const { workspaceTrustDirectory } = await import("../../src/domains/safety/workspace-trust.js");
	for (const command of [
		"clio-coder config trust safety --hash abc",
		"sh -c 'clio-coder config trust safety --hash abc'",
		"npx @iowarp/clio-coder config trust safety --hash abc",
	])
		assert.equal(engine().evaluate({ tool: "bash", args: { command } }, "confirmed").kind, "block");
	assert.equal(
		engine().evaluate({ tool: "bash", args: { command: `rm -r ${workspaceTrustDirectory()}/..` } }, "confirmed").kind,
		"block",
	);
	assert.equal(
		engine().evaluate({ tool: "write", args: { path: join(workspaceTrustDirectory(), "record.json") } }, "confirmed")
			.kind,
		"block",
	);
});
test("S1-05 inspect emits compiled safety metadata", async () => {
	const { buildCustomizationGraph } = await import("../../src/cli/config-inspect.js");
	const row = buildCustomizationGraph(root).entries.find((entry) => entry.id === "safety.policy");
	assert.ok(row);
	assert.deepEqual(row.detail, { ...createSafetyPolicyEngine({ cwd: root }).metadata() });
	assert.equal(row.detail?.workspaceTrustVerdict, "untrusted");
	assert.equal(row.detail?.disableDefaultPathPolicy, false);
});
test("S1-06 permission rate counts all outcomes and leaves an empty denominator unknown", async () => {
	const { summarizePermissionDecisions } = await import("../../src/cli/usage.js");
	assert.deepEqual(
		summarizePermissionDecisions(
			["requested", "requested", "requested", "requested", "granted", "granted", "denied", "expired"].map((status) => ({
				status,
			})),
		),
		{ requested: 4, granted: 2, denied: 1, expired: 1, approvalRate: 0.5 },
	);
	assert.equal(summarizePermissionDecisions([{ status: "granted" }]).approvalRate, null);
});

test("S1-05 config inspect --json exposes effective compiled metadata", () => {
	const cli = new URL("../../src/cli/config.ts", import.meta.url).href;
	const child = spawnSync(
		process.execPath,
		[
			"--import",
			new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
			"--input-type=module",
			"-e",
			`import {runConfigCommand} from ${JSON.stringify(cli)}; runConfigCommand(['inspect','--json']);`,
		],
		{ cwd: root, encoding: "utf8" },
	);
	assert.equal(child.status, 0, child.stderr);
	const graph = JSON.parse(child.stdout) as { entries: Array<{ id: string; detail?: Record<string, unknown> }> };
	assert.deepEqual(graph.entries.find((entry) => entry.id === "safety.policy")?.detail, {
		...createSafetyPolicyEngine({ cwd: root }).metadata(),
	});
});
test("S1-06 usage report reads permission audit rows and emits measured rate", async () => {
	const { clioStateDir } = await import("../../src/core/xdg.js");
	const audit = join(clioStateDir(), "audit");
	mkdirSync(audit, { recursive: true });
	writeFileSync(
		join(audit, "s1-permissions.jsonl"),
		`${["requested", "requested", "granted", "denied"].map((status, index) => JSON.stringify({ kind: "permission", status, ts: new Date().toISOString(), correlationId: `s1-${index}` })).join("\n")}\n`,
	);
	const cli = new URL("../../src/cli/usage.ts", import.meta.url).href;
	const child = spawnSync(
		process.execPath,
		[
			"--import",
			new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
			"--input-type=module",
			"-e",
			`import {runUsageCommand} from ${JSON.stringify(cli)}; await runUsageCommand(['report','--json']);`,
		],
		{ encoding: "utf8" },
	);
	assert.equal(child.status, 0, child.stderr);
	const rows = child.stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	assert.equal(rows.find((row) => row.fact === "permission-approval")?.approvalRate, 0.5);
});
