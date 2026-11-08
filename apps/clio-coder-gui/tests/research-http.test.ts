import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { Accepted } from "../contracts/operations.js";
import {
	ResearchCampaign,
	ResearchCampaigns,
	ResearchCliList,
	ResearchReport,
	type ResearchStartRequest,
} from "../contracts/research.js";
import { commandPlan } from "../server/cli-commands.js";
import { AppProblem } from "../server/services/problem.js";
import { harness, json, terminal } from "./harness/app.js";

const fixture = fileURLToPath(new URL("./fixtures/research-cli-child.mjs", import.meta.url));
const captured = (name: string): unknown =>
	JSON.parse(readFileSync(new URL(`./fixtures/research/${name}.json`, import.meta.url), "utf8"));
const request: ResearchStartRequest = {
	check: "bench",
	metric: "wall_ms",
	direction: "min",
	maxIterations: 1,
	minImprovement: 0.05,
	trials: 3,
	gates: ["correct"],
	scope: ["stats.py"],
	maxWallMinutes: 10,
	allowUnpriced: true,
	goal: "make stats.py faster",
	target: "mini",
	model: "mini/qwen3.8-27b-iq4r-v4",
};

test("research contracts accept real CLI output and admit only a fixed start argv", () => {
	const list = captured("list");
	assert.ok(Value.Check(ResearchCliList, list), [...Value.Errors(ResearchCliList, list)][0]?.message);
	assert.ok(Value.Check(ResearchReport, captured("report")));
	for (const view of (list as { campaigns: unknown[] }).campaigns) assert.ok(Value.Check(ResearchCampaign, view));
	assert.ok(!Value.Check(ResearchCampaign, { ...(list as { campaigns: object[] }).campaigns[0], extra: true }));
	assert.deepEqual(commandPlan({ kind: "research.start", request }).argv, [
		"research",
		"start",
		"--json",
		"--check",
		"bench",
		"--metric",
		"wall_ms",
		"--direction",
		"min",
		"--max-iterations",
		"1",
		"--min-improvement",
		"0.05",
		"--trials",
		"3",
		"--gate",
		"correct",
		"--scope",
		"stats.py",
		"--max-wall-minutes",
		"10",
		"--allow-unpriced",
		"--goal",
		"make stats.py faster",
		"--target",
		"mini",
		"--model",
		"mini/qwen3.8-27b-iq4r-v4",
	]);
	for (const bad of [
		{ ...request, goal: "--help" },
		{ ...request, goal: "-x" },
		{ ...request, goal: "two\nlines" },
		{ ...request, scope: ["--keep"] },
		{ ...request, gates: ["a;b"] },
		{ ...request, autonomy: "yolo" },
		{ ...request, keep: true },
		{ ...request, direction: "up" },
		{ ...request, maxIterations: 0 },
		{ ...request, trials: 1 },
	])
		assert.throws(() => commandPlan({ kind: "research.start", request: bad }), AppProblem);
	assert.throws(() => commandPlan({ kind: "research.status", id: "--json" }), AppProblem);
	assert.deepEqual(commandPlan({ kind: "research.report", id: "r20261108-123902-22f8" }).argv, [
		"research",
		"report",
		"r20261108-123902-22f8",
		"--json",
	]);
});

test("research routes list, read and regrade campaigns, and run a start as a cancellable operation", async () => {
	const logs = await mkdtemp(join(tmpdir(), "clio-research-cli-"));
	const log = join(logs, "commands.jsonl");
	const h = await harness({}, { env: { CLIO_CODER_WEB_CLI: fixture, CLIO_CODER_WEB_COMMAND_LOG: log } });
	try {
		const workspace = await h.workspaces.open(h.home.path);
		const base = `/api/workspaces/${workspace.id}/research/campaigns`;
		const list = await json(await h.request(base), ResearchCampaigns);
		assert.deepEqual(
			list.campaigns.map((row) => row.id),
			["r20261108-123902-22f8", "r20261108-123812-bacf", "r20261108-120921-31df", "r20261108-120739-d20d"],
		);
		assert.deepEqual(list.campaigns[0], {
			id: "r20261108-123902-22f8",
			createdAt: "2026-11-08T12:39:02.939Z",
			state: "stopped",
			objective: { check: "bench", metric: "wall_ms", direction: "min" },
			stop: "stopped",
			iterations: 2,
			ratchets: 1,
		});
		const view = await json(await h.request(`${base}/r20261108-123902-22f8`), ResearchCampaign);
		assert.equal(view.iterations[0]?.outcome, "ratcheted");
		assert.deepEqual(view.display?.costs, ["unknown", "unknown"]);
		assert.match(view.display?.spend ?? "", /; 2 runs had unknown spend$/);
		assert.equal((await h.request(`${base}/r20990101-000000-0000`)).status, 404);
		assert.equal((await h.request(`${base}/not-a-campaign`)).status, 422);
		const report = await h.request(`${base}/r20261108-123902-22f8/report`);
		assert.equal(report.status, 200);
		const regraded = await json(report, ResearchReport);
		assert.equal(regraded.agrees, false);
		assert.equal(regraded.display?.costs.length, regraded.iterations.length);

		for (const bad of [
			{ ...request, goal: "--help" },
			{ ...request, autonomy: "yolo" },
			{ ...request, scope: ["-x"] },
		])
			assert.equal((await h.post(base, bad)).status, 422);

		const done = await h.post(base, request);
		assert.equal(done.status, 202);
		const finished = await terminal(h.operations, (await json(done, Accepted)).operationId, 10_000);
		assert.equal(finished.status, "succeeded");
		assert.ok(finished.status === "succeeded" && "id" in finished.result);
		assert.equal(finished.result.id, "r20261108-120739-d20d");
		assert.ok(finished.progress.some((row) => row.message === "research r20261108-123902-22f8: A/A unchanged"));

		const waiting = await h.post(base, { ...request, goal: "wait for a stop" });
		const { operationId } = await json(waiting, Accepted);
		for (let i = 0; i < 200 && !h.operations.get(operationId).progress.some((row) => /opened at/.test(row.message)); i++)
			await setTimeout(20);
		assert.equal((await h.post(`/api/operations/${operationId}/cancel`)).status, 200);
		assert.equal((await terminal(h.operations, operationId, 10_000)).status, "cancelled");

		const closing = await json(await h.post(base, { ...request, goal: "wait for a stop" }), Accepted);
		for (
			let i = 0;
			i < 200 && !h.operations.get(closing.operationId).progress.some((row) => /opened at/.test(row.message));
			i++
		)
			await setTimeout(20);
		await h.research.close();
		assert.equal((await h.post(base, request)).status, 503);

		const records = (await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { kind: string; argv?: string[]; pid: number });
		const starts = records.filter((row) => row.kind === "start" && row.argv?.[1] === "start");
		assert.equal(starts.length, 3);
		assert.deepEqual(starts[0]?.argv, commandPlan({ kind: "research.start", request }).argv);
		const stopped = records.filter((row) => row.kind === "SIGTERM").map((row) => row.pid);
		assert.deepEqual(stopped, [starts[1]?.pid, starts[2]?.pid]);
		for (const pid of stopped) assert.throws(() => process.kill(pid, 0));
	} finally {
		await h.close();
		await rm(logs, { recursive: true, force: true });
	}
});
