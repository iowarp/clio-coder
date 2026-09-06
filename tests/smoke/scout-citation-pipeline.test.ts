import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { RESULT_CONTRACT_REPAIR_LIMIT } from "../../src/domains/agents/result-contract.js";
import { readRunJournal } from "../../src/domains/eval/metrics/invariants.js";
import {
	closeServer,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { makeScratchHome } from "../harness/scratch-env.js";

const GRADER = fileURLToPath(new URL("../../evals/behavioral-corpus-grader.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
const fixture = JSON.parse(
	readFileSync(new URL("../../evals/fixtures/scout-citation-pipeline.json", import.meta.url), "utf8"),
) as {
	prompt: string;
	dispatch: Record<string, unknown>;
	files: Record<string, string>;
	findings: Array<{ claim: string; path: string; line: number }>;
	dependentExplanation: string;
};

interface WireMessage {
	role: string;
	content?: unknown;
	tool_call_id?: string;
	tool_calls?: Array<{ id: string; function: { name: string } }>;
}
function messages(request: Record<string, unknown>): WireMessage[] {
	return (request.messages ?? []) as WireMessage[];
}
function isScout(request: Record<string, unknown>): boolean {
	return messages(request).some(
		(message) =>
			message.role === "system" && String(message.content).includes("You are Scout, a shadow reconnaissance agent"),
	);
}
function isMain(request: Record<string, unknown>): boolean {
	return Array.isArray(request.tools) && request.tools.some((tool) => tool.function?.name === "dispatch");
}
function repairs(request: Record<string, unknown>): WireMessage[] {
	return messages(request).filter(
		(message) => message.role === "tool" && message.tool_call_id?.startsWith("clio-result-contract-repair-"),
	);
}
function report(line = 62): string {
	return JSON.stringify({
		findings: fixture.findings.map((finding) =>
			finding.path === "findiff/interface.py" ? { ...finding, line } : finding,
		),
		needsSplit: false,
		proposedSubtasks: [],
	});
}
function run(args: string[], cwd: string, env: NodeJS.ProcessEnv, entry = CLI) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
		execFile(
			process.execPath,
			[entry, ...args],
			{ cwd, env, timeout: 45_000, maxBuffer: 4_000_000 },
			(error, stdout, stderr) => {
				if (error && typeof error.code !== "number") return reject(error);
				resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
			},
		);
	});
}

// Scripted model responses exercise the real binary, worker reads, bounded
// contract repairs, receipt sealing and pipeline dependency. They do not prove
// that any configured model follows the recipe; root owns that acceptance.
for (const scenario of ["first-pass", "repaired", "exhausted"] as const) {
	test(`Scout citation pipeline: ${scenario}`, { timeout: 60_000 }, async (context) => {
		const scratch = makeScratchHome("clio-scout-pipeline-");
		const server = await startOpenAICompatFixture(
			(request) => {
				if (isMain(request)) return "Pipeline outcomes are recorded in the dispatch receipt.";
				if (!isScout(request)) {
					return JSON.stringify({
						mutatedPaths: [],
						validations: [
							{
								name: "Inspect supplied Scout findings",
								passed: true,
								evidence:
									"The pipeline input identifies coordinate storage at findiff/grids.py:31 and grid conversion at findiff/interface.py:62.",
							},
						],
						summary: fixture.dependentExplanation,
					});
				}
				const count = repairs(request).length;
				if (scenario === "first-pass") return report();
				if (count === 0) return "Nonuniform grids use coordinate arrays. See findiff/grids.py.";
				// Reproduce the retained prose -> invalid JSON citation -> second
				// repair sequence. Only the repaired case changes the supporting
				// line to the actual make_axis call; no validator is stubbed.
				return report(scenario === "repaired" && count === RESULT_CONTRACT_REPAIR_LIMIT ? 62 : 64);
			},
			{
				toolCall: (request) => {
					if (isMain(request)) {
						return messages(request).some((message) => message.role === "tool")
							? null
							: { name: "dispatch", arguments: fixture.dispatch, id: "pipeline" };
					}
					if (!isScout(request) || repairs(request).length > 0) return null;
					for (const [id, path] of [
						["read-grids", "findiff/grids.py"],
						["read-interface", "findiff/interface.py"],
					]) {
						if (!messages(request).some((message) => message.role === "tool" && message.tool_call_id === id)) {
							return { name: "read", arguments: { path }, id };
						}
					}
					return null;
				},
			},
		);
		try {
			const workspace = join(scratch.dir, "workspace");
			mkdirSync(workspace);
			const env = {
				...process.env,
				...scratch.env,
				TMPDIR: scratch.dir,
				NODE_ENV: "test",
				CLIO_CODER_TEST_OPENAI_KEY: "fixture-key",
			};
			const prepared = await run(["main", "main-scout-citation-pipeline", "--prepare"], workspace, env, GRADER);
			strictEqual(prepared.code, 0, prepared.stderr);
			const doctor = await run(["doctor", "--fix"], workspace, env);
			strictEqual(doctor.code, 0, doctor.stderr);
			seedOpenAICompatToolOrchestrator(join(scratch.dir, "config"), server.url, "full-auto");
			const settingsPath = join(scratch.dir, "config", "settings.yaml");
			const settings = parse(readFileSync(settingsPath, "utf8"));
			settings.fleet.default.target = "mock-chat";
			settings.fleet.default.model = "mock-model";
			writeFileSync(settingsPath, stringify(settings));
			const result = await run(["run", "--json", "--autonomy", "full-auto", fixture.prompt], workspace, env);
			strictEqual(result.code, 0, result.stderr);
			const requests = server.requests.filter((request) => request.stream !== false);
			const scoutRequests = requests.filter(isScout);
			ok(scoutRequests.length > 0, result.stdout);
			match(JSON.stringify(scoutRequests[0]?.messages), /Keep this JSON shape even when a pipeline handoff asks/u);
			match(JSON.stringify(scoutRequests[0]?.messages), /read` returns unnumbered source text/u);
			const finalScoutRequest = scoutRequests.at(-1);
			ok(finalScoutRequest);
			const feedback = repairs(finalScoutRequest);
			strictEqual(feedback.length, scenario === "first-pass" ? 0 : RESULT_CONTRACT_REPAIR_LIMIT);
			deepStrictEqual(
				feedback.map((message) => message.tool_call_id),
				Array.from({ length: feedback.length }, (_, index) => `clio-result-contract-repair-${index + 1}`),
			);
			const readResults = messages(finalScoutRequest).filter(
				(message) => message.role === "tool" && message.tool_call_id?.startsWith("read-"),
			);
			strictEqual(readResults.length, 2, "repair retains both actual reads");
			const interfaceRead = readResults.find((message) => message.tool_call_id === "read-interface");
			ok(interfaceRead);
			match(String(interfaceRead.content), /grid_axis = make_axis\(axis, grid, periodic\)/u);
			if (feedback.length > 0) {
				match(
					String(feedback[1]?.content),
					/not grounded in a live read: findiff\/interface.py:64 \(this run read only 1-63\)/u,
				);
				match(String(feedback[1]?.content), /path:start-end, inclusive/u);
				match(String(feedback[1]?.content), /Never shift a rejected citation into range/u);
				ok(
					scoutRequests
						.filter((request) => repairs(request).length > 0)
						.every((request) => !request.tools || (request.tools as unknown[]).length === 0),
				);
			}
			const journal = readRunJournal(join(scratch.dir, "state"));
			ok(journal);
			const scouts = journal.receipts.filter((receipt) => receipt.agentId === "scout");
			const dependents = journal.receipts.filter((receipt) => receipt.agentId === "documenter");
			strictEqual(scouts.length, 1, "no replacement Scout run may disguise failed repair");
			const scout = scouts[0];
			ok(scout);
			const succeeded = scenario !== "exhausted";
			strictEqual(scout.outcome, succeeded ? "succeeded" : "failed");
			strictEqual(scout.exitCode, succeeded ? 0 : 1);
			strictEqual(dependents.length, succeeded ? 1 : 0);
			const dependentRequests = requests.filter((request) => !isMain(request) && !isScout(request));
			strictEqual(
				dependentRequests.length,
				succeeded ? 1 : 0,
				"dependent must really execute only after successful Scout validation",
			);
			if (succeeded) {
				strictEqual(scout.quality.resultContract?.conformance, "pass");
				strictEqual(scout.output?.text, report());
				const dependent = dependents[0];
				ok(dependent);
				strictEqual(dependent.outcome, "succeeded");
				strictEqual(dependent.exitCode, 0);
				strictEqual(JSON.parse(dependent.output?.text ?? "{}").summary, fixture.dependentExplanation);
				ok(
					JSON.stringify(dependentRequests[0]?.messages).includes(JSON.stringify(report()).slice(1, -1)),
					"dependent receives validated Scout output",
				);
				ok(JSON.stringify(dependentRequests[0]?.messages).includes(scout.runId), "handoff names the actual source run");
				doesNotMatch(result.stdout, /pipeline dispatch halted/u);
			} else {
				strictEqual(scout.outcomeCode, "result_contract_exhausted");
				match(result.stdout, /pipeline dispatch halted at step 1\/2.*skipped 1 later step/u);
			}
			for (const [path, content] of Object.entries(fixture.files))
				strictEqual(readFileSync(join(workspace, path), "utf8"), content);
			const stdoutPath = join(scratch.dir, "runner.ndjson");
			writeFileSync(stdoutPath, result.stdout);
			const graded = await run(
				["main", "main-scout-citation-pipeline"],
				workspace,
				{ ...env, CLIO_CODER_EVAL_RUNNER_STDOUT_FILE: stdoutPath },
				GRADER,
			);
			strictEqual(graded.code, succeeded ? 0 : 1, graded.stderr);
			match(graded.stdout, succeeded ? /"pipeline.completed":true/u : /"pipeline.completed":false/u);
			context.diagnostic(
				JSON.stringify({
					scenario,
					repairs: feedback.length,
					scoutRunId: scout.runId,
					scoutOutcome: scout.outcome,
					dependentExecutions: dependentRequests.length,
					dependentRunIds: dependents.map((receipt) => receipt.runId),
					pipelineCompleted: succeeded && dependents[0]?.outcome === "succeeded",
				}),
			);
		} finally {
			await closeServer(server.server);
			scratch.cleanup();
		}
	});
}
