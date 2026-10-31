import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clioConfigDir } from "../../src/core/xdg.js";
import { mapAutonomy } from "../../src/domains/safety/autonomy.js";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { loadProjectSafetyPolicy } from "../../src/domains/safety/project-policy.js";
import { telemetryCall } from "../harness/telemetry-view.js";

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
/**
 * The disposition a run at `level` gives a bash command. Repository scripts
 * need approval at default; at yolo they run like any other unrecognized
 * command.
 */
function admitted(
	policy: ReturnType<typeof createSafetyPolicyEngine>,
	command: string,
	level = "default" as const,
): string {
	const decision = policy.evaluate({ tool: "bash", args: { command } });
	if (decision.kind !== "allow") return decision.kind;
	return mapAutonomy(level, decision.actionClass, { executeRecognized: decision.execRecognition !== "unrecognized" });
}

test("S1-03 repository scripts require approval; inert commands stay recognized", () => {
	const policy = createSafetyPolicyEngine({ cwd: root });
	assert.equal(admitted(policy, "npm run build"), "ask");
	assert.equal(policy.evaluate({ tool: "bash", args: { command: "npm run build" } }).execRecognition, "unrecognized");
	for (const command of ["pwd", "git status", "npm test"])
		assert.equal(policy.evaluate({ tool: "bash", args: { command } }).execRecognition, "recognized");
});

test("S1-03 trusted declarations recognize scripts but untrusted declarations cannot authorize themselves", () => {
	writeFileSync(
		join(root, ".clio-coder/safety.yaml"),
		"version: 1\ncommands:\n  - id: build\n    command: npm run build\n    actionClass: execute\n",
	);
	const approved = engine();
	assert.equal(approved.evaluate({ tool: "bash", args: { command: "npm run build" } }).execRecognition, "recognized");
	assert.equal(admitted(createSafetyPolicyEngine({ cwd: root }), "npm run build"), "ask");
});
test("S1-03 chain and shell wrappers cannot bypass script approval", () => {
	const policy = createSafetyPolicyEngine({ cwd: root });
	for (const command of [
		"pwd && npm run build",
		"sh -c 'npm run build'",
		"npm run build | tee output.txt",
		"npm run build && echo done",
		"npm test | tee output.txt",
		"npm test && echo done > output.txt",
	])
		assert.equal(admitted(policy, command), "ask", command);
	// eba2a6ad1 recognizes a chain whose every member is recognized. `npm test`
	// already runs without a card and `echo` is read-only, so the chain adds
	// nothing either step lacked; only the file redirect above makes it ask.
	assert.equal(admitted(policy, "npm test && echo done"), "allow");
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
	const { foldDecisions } = await import("../../src/domains/telemetry/index.js");
	type Decision = Parameters<typeof foldDecisions>[0] extends Iterable<infer R> ? R : never;
	const requested = (requestId: string) =>
		({ k: "approval.requested", ctx: {}, data: { tool: "bash", actionClass: "execute", requestId } }) as Decision;
	const resolved = (status: "granted" | "denied" | "expired") =>
		({ k: "approval.resolved", ctx: {}, data: { status } }) as Decision;
	assert.deepEqual(
		foldDecisions([
			requested("a"),
			requested("b"),
			requested("c"),
			requested("d"),
			resolved("granted"),
			resolved("granted"),
			resolved("denied"),
			resolved("expired"),
		]).approvals,
		{ requested: 4, granted: 2, denied: 1, expired: 1, approvalRate: 0.5 },
	);
	assert.equal(foldDecisions([resolved("granted")]).approvals.approvalRate, null);
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
test("S1-06 usage report reads journaled approvals and emits measured rate", async () => {
	const { clioStateDir } = await import("../../src/core/xdg.js");
	const { createTelemetryHub } = await import("../../src/core/telemetry/hub.js");
	const { createSessionBundle } = await import("../../src/domains/session/extension.js");
	const { contract: session } = createSessionBundle({ bus: createTelemetryHub(), getContract: () => undefined });
	const meta = session.create({ cwd: root, target: "chat", model: "chat-model" });
	session.append({
		parentId: null,
		kind: "assistant",
		payload: {
			text: "done",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { total: 0.03 },
				costProvenance: "known",
			},
		},
	});
	session.flushAppends?.();
	// Approvals are the session journal's accountability records (#434).
	const { callJournalHeader } = await import("../../src/domains/telemetry/call-journal.js");
	const { makeTelemetryRecord } = await import("../../src/core/telemetry/envelope.js");
	const { encodeTelemetryLine } = await import("../../src/core/telemetry/segment.js");
	const { telemetryJournalPath, telemetrySessionDirectory } = await import("../../src/domains/telemetry/paths.js");
	const journalDirectory = telemetrySessionDirectory(clioStateDir(), meta.id);
	mkdirSync(journalDirectory, { recursive: true });
	const ctx = { sessionId: meta.id, agent: { role: "main", id: meta.id } } as const;
	const clock = (mono: number) => ({ t: new Date().toISOString(), mono });
	writeFileSync(
		telemetryJournalPath(journalDirectory),
		Buffer.concat([
			encodeTelemetryLine(callJournalHeader({ clioCoderVersion: "test", piVersion: "test" })),
			...telemetryCall(meta.id, { at: new Date().toISOString(), usage: { input: 100, output: 50 }, usd: 0.03 }).map(
				encodeTelemetryLine,
			),
			...["s1-0", "s1-1"].map((requestId, index) =>
				encodeTelemetryLine(
					makeTelemetryRecord("approval.requested", { tool: "bash", actionClass: "execute", requestId }, ctx, clock(index)),
				),
			),
			...(["granted", "denied"] as const).map((status, index) =>
				encodeTelemetryLine(makeTelemetryRecord("approval.resolved", { status }, ctx, clock(index + 2))),
			),
		]),
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
	const report = JSON.parse(child.stdout) as {
		approvals: { rate: { fact: { kind: string; value: number }; display: string } };
	};
	assert.equal(report.approvals.rate.fact.kind, "measured");
	assert.equal(report.approvals.rate.fact.value, 50);
	assert.equal(report.approvals.rate.display, "50.0%");
});
