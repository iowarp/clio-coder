import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createExtensionTestHost } from "@iowarp/clio-coder/extensions/testing";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
function project(): string {
	assert.ok(process.env.TMPDIR, "Tests need a task-owned TMPDIR.");
	const workspace = mkdtempSync(path.join(process.env.TMPDIR, "materio-test-"));
	mkdirSync(path.join(workspace, ".research/tasks/task-03"), { recursive: true });
	mkdirSync(path.join(workspace, ".research/data"));
	writeFileSync(
		path.join(workspace, ".research/RESEARCH.md"),
		"## Research Area\n- **Domain**: Structural Materials\n- **Sub-field**: Ni alloys\n## Selected Prompt\nHow does ageing change precipitate size?\n",
	);
	writeFileSync(path.join(workspace, ".research/LITERATURE.md"), "# Supplied literature\n");
	writeFileSync(
		path.join(workspace, ".research/VIRTUAL-LAB.md"),
		"## Resource-to-Task Mapping\n| Task Type | Required Resource | Available? | Alternative |\n|---|---|---|---|\n| experimental | APT | no | external |\n",
	);
	writeFileSync(
		path.join(workspace, ".research/config.json"),
		'{"web_search":false,"auto_checkpoint":true,"commit_research":false}\n',
	);
	writeFileSync(
		path.join(workspace, ".research/WORKFLOW.md"),
		"## Tasks\n" +
			[
				["01", "Supplied sources", "literature", "complete", "none"],
				["02", "Simulate ageing", "computational", "in-progress", "Task 01"],
				["03", "Inspect kinetics", "analytical", "in-progress", "Task 01"],
				["04", "Measure APT", "experimental", "pending", "Task 03"],
				["05", "Prepare paper", "writing", "pending", "Task 04"],
			]
				.map(
					([id, name, type, status, dependencies]) =>
						`### Task ${id}: ${name}\n- **Type**: ${type}\n- **Dependencies**: ${dependencies}\n- **Status**: ☑ ${status}\n\n`,
				)
				.join("") +
			"## Archived Tasks\n### Task 09: Retired\n- **Status**: archived\n",
	);
	writeFileSync(
		path.join(workspace, ".research/DATA-INDEX.md"),
		"## observations.csv\n- **Path**: .research/data/observations.csv\n",
	);
	writeFileSync(path.join(workspace, ".research/data/observations.csv"), "time,size\n1,3\n");
	writeFileSync(
		path.join(workspace, ".research/tasks/task-03/task-03-SUMMARY.md"),
		"# Prepared kinetics model\nCool the sample to -5 K.\n@article{a,title={Ageing kinetics of nickel alloy precipitates},year={2024}}\n",
	);
	writeFileSync(path.join(workspace, ".research/tasks/task-03/analysis.py"), "def analyze(:\n    pass\n");
	return workspace;
}
const USAGE = {
	inputTokens: 100,
	outputTokens: 40,
	cacheReadTokens: 20,
	cacheWriteTokens: 5,
	costUsd: null,
	model: "no-price",
	target: "dead",
};

test("lab uses research state, dependency order, role labels, local actions and watch updates", async () => {
	const workspace = project();
	const host = await createExtensionTestHost(ROOT, { workspace });
	try {
		const output = await host.command("lab");
		assert.deepEqual(output.workspace, { enter: "lab" });
		assert.deepEqual(Object.keys(output.regions ?? {}), ["header", "board", "rail", "footer"]);
		assert.equal(output.regions?.board?.t, "board");
		assert.match((await host.command("progress")).text, /1\/5 tasks/);
		assert.match(JSON.stringify(output.regions?.board), /LAB GAP/);
		const filled = (await host.action("next")).prompt;
		assert.match(filled && "fill" in filled ? filled.fill : "", /execute-task 02/);
		await host.observe({ event: "dispatch_started", agentId: "materio-literature-reviewer", runId: "literature-run" });
		assert.match((await host.command("status")).islands?.[0]?.title ?? "", /Literature desk/);
		const file = path.join(workspace, ".research/WORKFLOW.md");
		writeFileSync(file, readFileSync(file, "utf8").replace("Task 02: Simulate ageing", "Task 02: Edited by researcher"));
		const changed = await host.observe({ event: "fs_changed", paths: [".research/WORKFLOW.md"] });
		assert.match(JSON.stringify(changed?.regions?.board), /Edited by researcher/);
		assert.equal((await host.command("help")).prompt, undefined);
		assert.match(JSON.stringify((await host.command("help")).card), /Local, no model/);
		assert.match(JSON.stringify((await host.command("status")).card), /1\/5 tasks/);
		assert.match((await host.command("progress")).text, /Materio ► 1\/5 tasks/);
		assert.match(JSON.stringify((await host.action("next")).prompt), /execute-task 02/);
	} finally {
		await host.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("turn and dispatch usage is deduplicated, attributed, CAS-stored and never invents unpriced dollars", async () => {
	const workspace = project();
	const host = await createExtensionTestHost(ROOT, { workspace });
	try {
		await host.observe({ event: "turn_start", turnId: "t1", text: "/materio:literature-review" });
		await host.observe({ event: "turn_end", turnId: "t1", outcome: "completed", usage: USAGE });
		await host.observe({ event: "turn_end", turnId: "t1", outcome: "completed", usage: USAGE });
		await host.observe({
			event: "dispatch_completed",
			runId: "d1",
			agentId: "materio-workflow-planner",
			durationMs: 10,
			usage: { ...USAGE, costUsd: 0.25 },
		});
		const key = (await host.store.keys()).find((key) => key.startsWith("usage:"));
		assert.ok(key);
		const value = (await host.store.get<{ steps: Record<string, { calls: number; cost: number }> }>(key)).value;
		assert.equal(value?.steps["literature-review"]?.calls, 1);
		assert.equal(value?.steps["define-research-tasks"]?.cost, 0.25);
		const cost = await host.command("cost");
		assert.match(cost.text, /140 tokens.*cost unavailable/);
		assert.match(cost.text, /\$0\.2500/);
		assert.doesNotMatch(cost.text, /literature-review: \$/);
	} finally {
		await host.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("executor guardrails hold the exact task until an interview records the researcher decision and checkpoints", async () => {
	const workspace = project();
	const host = await createExtensionTestHost(ROOT, { workspace });
	try {
		await host.hook({
			point: "before_tool",
			tool: "dispatch",
			turnId: "t1",
			args: { agent: "materio-task-executor", intent: { write_roots: [".research/tasks/task-03/"] } },
		});
		await host.observe({ event: "dispatch_started", runId: "executor-03", agentId: "materio-task-executor" });
		const result = await host.observe({
			event: "dispatch_completed",
			runId: "executor-03",
			agentId: "materio-task-executor",
			durationMs: 20,
			usage: USAGE,
		});
		assert.match(JSON.stringify(result?.card), /IMPOSSIBLE 1.*WILL NOT RUN 1/);
		assert.match((await host.command("status")).text, /03: Inspect kinetics \[checkpoint\]/);
		assert.match(readFileSync(path.join(workspace, ".research/WORKFLOW.md"), "utf8"), /◆ checkpoint/);
		const opened = await host.action("task", "03");
		assert.equal(opened.interview?.id, "findings");
		await host.interview({ id: "findings", step: "task-03", nav: "cancel", answers: {} });
		assert.match((await host.command("status")).text, /03: Inspect kinetics \[checkpoint\]/);
		await host.action("findings", "03");
		const accepted = await host.interview({
			id: "findings",
			step: "task-03",
			nav: "next",
			answers: { decision: "accept", note: "Prepared only; retain limitations for my review." },
		});
		assert.match("text" in accepted ? accepted.text : "", /Checkpoint saved/);
		assert.match((await host.command("status")).text, /03: Inspect kinetics \[complete\]/);
		assert.match(
			readFileSync(path.join(workspace, ".research/tasks/task-03/MATERIO-REVIEW.md"), "utf8"),
			/Prepared only/,
		);
		assert.equal((await host.state.get<{ decision: string }>("findings:03")).value?.decision, "accept");
		assert.match((await host.command("checkpoint", "list")).text, /after-task-03/);
	} finally {
		await host.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("missing summary and edited completion stay held; fix fills an executor prompt; unknown runs warn", async () => {
	const workspace = project();
	const host = await createExtensionTestHost(ROOT, { workspace, options: { autoCheckpoint: false } });
	try {
		rmSync(path.join(workspace, ".research/tasks/task-03/task-03-SUMMARY.md"));
		const result = await host.command("status", "check 03");
		assert.match(JSON.stringify(result.card), /WARNING: summary missing or empty/);
		const file = path.join(workspace, ".research/WORKFLOW.md");
		writeFileSync(file, readFileSync(file, "utf8").replace("◆ checkpoint", "☑ complete"));
		await host.observe({ event: "fs_changed", paths: [".research/WORKFLOW.md"] });
		assert.match(readFileSync(file, "utf8"), /◆ checkpoint/);
		await host.action("findings", "03");
		const answer = await host.interview({
			id: "findings",
			step: "task-03",
			nav: "next",
			answers: { decision: "accept", note: "Acknowledged" },
		});
		assert.match("text" in answer ? answer.text : "", /stays at checkpoint/);
		await host.action("findings", "03");
		const fix = await host.interview({
			id: "findings",
			step: "task-03",
			nav: "next",
			answers: { decision: "fix", note: "Write the missing summary" },
		});
		assert.match("prompt" in fix && fix.prompt && "fill" in fix.prompt ? fix.prompt.fill : "", /execute-task 03/);
		const unknown = await host.observe({
			event: "dispatch_completed",
			runId: "no-root",
			agentId: "materio-task-executor",
			durationMs: 1,
			usage: null,
		});
		assert.match(JSON.stringify(unknown?.card), /not assigned by guess/);
	} finally {
		await host.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("checkpoint save/list/restore requires confirmation, preserves data, saves before-restore, and reads back", async () => {
	const workspace = project();
	const host = await createExtensionTestHost(ROOT, { workspace });
	try {
		const saved = await host.command("checkpoint", "save approved");
		assert.match(saved.text, /Checkpoint saved:/);
		const name = readdirSync(path.join(workspace, ".research/checkpoints"))[0];
		assert.ok(name);
		const research = path.join(workspace, ".research/RESEARCH.md");
		const original = readFileSync(research, "utf8");
		writeFileSync(research, "Later state");
		const request = await host.command("checkpoint", `restore ${name}`);
		assert.equal(request.interview?.id, "restore");
		await host.interview({ id: "restore", step: "confirm", nav: "cancel", answers: {} });
		assert.equal(readFileSync(research, "utf8"), "Later state");
		await host.command("checkpoint", `restore ${name}`);
		const restored = await host.interview({
			id: "restore",
			step: "confirm",
			nav: "next",
			answers: { confirm: "restore" },
		});
		assert.match("text" in restored ? restored.text : "", /Restored .*WORKFLOW.md:/);
		assert.equal(readFileSync(research, "utf8"), original);
		assert.ok(readdirSync(path.join(workspace, ".research/checkpoints")).some((item) => item.includes("before-restore")));
		assert.equal(readFileSync(path.join(workspace, ".research/data/observations.csv"), "utf8"), "time,size\n1,3\n");
		await assert.rejects(host.command("checkpoint", "save ../escape"), /path-safe/);
		assert.match((await host.command("checkpoint", "restore missing.tgz")).text, /exact archive/);
	} finally {
		await host.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("all-complete tasks offer a bounded, honest WTF-P brief; archived tasks do not count", async () => {
	const workspace = project();
	try {
		const file = path.join(workspace, ".research/WORKFLOW.md");
		writeFileSync(file, readFileSync(file, "utf8").replace(/☑ (pending|in-progress)/g, "☑ complete"));
		const host = await createExtensionTestHost(ROOT, { workspace });
		try {
			assert.match((await host.command("progress")).text, /5\/5 tasks ◆ paper/);
			const handoff = (await host.action("next")).prompt;
			assert.match(handoff && "fill" in handoff ? handoff.fill : "", /^\/wtfp:new-paper Materio handoff:/);
			assert.match(JSON.stringify(handoff), /prepared work distinct/);
		} finally {
			await host.dispose();
		}
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("changed artifacts cannot accept stale checks; disabling checkpoints avoids a snapshot", async () => {
	const workspace = project();
	const host = await createExtensionTestHost(ROOT, { workspace, options: { autoCheckpoint: false } });
	try {
		const checked = await host.command("status", "check 03");
		assert.match(JSON.stringify(checked.card), /"key":"03"/);
		await host.action("findings", "03");
		writeFileSync(path.join(workspace, ".research/tasks/task-03/analysis.py"), "print('prepared, not executed')\n");
		const stale = await host.interview({
			id: "findings",
			step: "task-03",
			nav: "next",
			answers: { decision: "accept", note: "Stale" },
		});
		assert.match("text" in stale ? stale.text : "", /artifacts changed since checks/);
		assert.match((await host.command("status")).text, /03: Inspect kinetics \[checkpoint\]/);
		await host.command("status", "check 03");
		await host.action("findings", "03");
		const accepted = await host.interview({
			id: "findings",
			step: "task-03",
			nav: "next",
			answers: { decision: "accept", note: "Updated outputs reviewed" },
		});
		assert.match("text" in accepted ? accepted.text : "", /autoCheckpoint is off/);
		assert.match((await host.command("status")).text, /03: Inspect kinetics \[complete\]/);
		assert.match((await host.command("checkpoint", "list")).text, /No checkpoints saved/);
	} finally {
		await host.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("rejected dispatch admission cannot attach a later unknown run to an old task", async () => {
	const workspace = project();
	const host = await createExtensionTestHost(ROOT, { workspace });
	try {
		await host.hook({
			point: "before_tool",
			tool: "dispatch",
			turnId: "t1",
			args: { agent: "materio-task-executor", intent: { write_roots: [".research/tasks/task-03/"] } },
		});
		await host.observe({ event: "tool_end", turnId: "t1", tool: "dispatch", outcome: "error", durationMs: 1 });
		await host.observe({ event: "dispatch_started", runId: "later-unknown", agentId: "materio-task-executor" });
		const result = await host.observe({
			event: "dispatch_completed",
			runId: "later-unknown",
			agentId: "materio-task-executor",
			durationMs: 1,
			usage: null,
		});
		assert.match(JSON.stringify(result?.card), /not assigned by guess/);
		assert.match((await host.command("status")).text, /03: Inspect kinetics \[running\]/);
	} finally {
		await host.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});
