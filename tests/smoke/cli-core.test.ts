import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import {
	loadEvalArtifactV4,
	parseEvalArtifactV4,
	writeEvalArtifactV4,
} from "../../src/domains/eval/artifacts/store.js";
import type { EvalCompareV4Summary } from "../../src/domains/eval/compare/compare.js";

import { formatUserTaskHandoff } from "../../src/domains/user-tasks/handoff.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const CLI = join(ROOT, "dist", "cli", "index.js");
const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

interface Home {
	root: string;
	env: NodeJS.ProcessEnv;
	cleanup(): void;
}

interface Result {
	code: number | null;
	stdout: string;
	stderr: string;
}

function home(label = "clio-cli-core-"): Home {
	const root = mkdtempSync(join(tmpdir(), label));
	return {
		root,
		env: {
			...process.env,
			NODE_ENV: "test",
			NO_COLOR: "1",
			CLIO_CODER_HOME: root,
			CLIO_CODER_CONFIG_DIR: join(root, "config"),
			CLIO_CODER_DATA_DIR: join(root, "data"),
			CLIO_CODER_STATE_DIR: join(root, "state"),
			CLIO_CODER_CACHE_DIR: join(root, "cache"),
			CLIO_CODER_REQUIRE_HOME_PREFIX: "1",
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

async function runCli(
	args: string[],
	options: { env: NodeJS.ProcessEnv; cwd?: string; input?: string; timeoutMs?: number },
): Promise<Result> {
	const child = spawn(process.execPath, [CLI, ...args], {
		cwd: options.cwd ?? ROOT,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (text: string) => {
		stdout += text;
	});
	child.stderr.on("data", (text: string) => {
		stderr += text;
	});
	child.stdin.end(options.input);
	return new Promise<Result>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`CLI timeout: ${args.join(" ")}\nstdout=${stdout}\nstderr=${stderr}`));
		}, options.timeoutMs ?? 20_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

it("CLI tasks hand retains JSON state and emits the explicit headless pickup turn", async () => {
	const scratch = home("clio-task-handoff-");
	try {
		const options = { env: scratch.env, cwd: scratch.root };
		const added = await runCli(["tasks", "add", "Inspect validation results"], options);
		strictEqual(added.code, 0, added.stderr);
		const handed = await runCli(["tasks", "hand", "u1"], options);
		strictEqual(handed.code, 0, handed.stderr);
		const task = JSON.parse(handed.stdout);
		strictEqual(task.id, "u1");
		strictEqual(task.status, "handed");
		strictEqual(task.handedSessionId, undefined);
		strictEqual(task.boardTaskId, undefined);
		match(handed.stderr, /CLI hand records the inbox state only/);
		match(handed.stderr, /same project/);
		ok(handed.stderr.endsWith(`${formatUserTaskHandoff(task)}\n`));
		const listed = await runCli(["tasks", "list"], options);
		strictEqual(listed.code, 0, listed.stderr);
		deepStrictEqual(JSON.parse(listed.stdout), [task]);
		const missing = await runCli(["tasks", "hand", "u99"], options);
		strictEqual(missing.code, 1);
		match(missing.stderr, /not found/);
		strictEqual(missing.stderr.includes("Before working"), false);
	} finally {
		scratch.cleanup();
	}
});

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
	let text = "";
	request.setEncoding("utf8");
	for await (const chunk of request) text += chunk;
	return JSON.parse(text) as Record<string, unknown>;
}

describe("smoke/built CLI core", { concurrency: false }, () => {
	let server: Server;
	let endpoint: string;
	const requests: Array<Record<string, unknown>> = [];

	before(async () => {
		server = createServer(async (request, response) => {
			if (request.method === "GET" && request.url === "/v1/models") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						object: "list",
						data: [
							{
								id: "mock-model",
								object: "model",
								tools: true,
								context_window: 32768,
								max_output_tokens: 4096,
							},
						],
					}),
				);
				return;
			}
			if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
				response.statusCode = 404;
				response.end("not found");
				return;
			}
			const payload = await body(request);
			requests.push(payload);
			if (payload.stream === false) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						id: "chatcmpl-smoke",
						object: "chat.completion",
						model: "mock-model",
						choices: [{ index: 0, message: { role: "assistant", content: "core reply" }, finish_reason: "stop" }],
					}),
				);
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-smoke",
					object: "chat.completion.chunk",
					created: 1,
					model: "mock-model",
					choices: [{ index: 0, delta: { role: "assistant", content: "core reply" } }],
				})}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-smoke",
					object: "chat.completion.chunk",
					created: 1,
					model: "mock-model",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
				})}\n\n`,
			);
			response.end("data: [DONE]\n\n");
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("reports version/help and routes usage errors to stderr", async () => {
		const scratch = home();
		try {
			const version = await runCli(["--version"], { env: scratch.env });
			strictEqual(version.code, 0);
			strictEqual(version.stdout, `Clio Coder ${VERSION}\n`);
			strictEqual(version.stderr, "");

			const help = await runCli(["--help"], { env: scratch.env });
			strictEqual(help.code, 0);
			match(help.stdout, /Usage:/u);
			match(help.stdout, /clio-coder run \[flags\] <task>/u);
			match(help.stdout, /^ {2}clio-coder config inspect \[--json\] {2}inspect effective customization and provenance$/mu);

			const unknown = await runCli(["not-a-command"], { env: scratch.env });
			strictEqual(unknown.code, 2);
			strictEqual(unknown.stdout, "");
			match(unknown.stderr, /unknown subcommand: not-a-command/u);
		} finally {
			scratch.cleanup();
		}
	});

	it("reports custom eval artifacts using the printed command without importing or changing bytes", async () => {
		const scratch = home("clio-eval-custom-");
		try {
			// Artifact location does not require rerunning every recipe. Keep the
			// full shipped-corpus roundtrip in its dedicated test below.
			const suite = parseYaml(readFileSync(join(ROOT, "evals/behavioral-machinery.yaml"), "utf8"));
			suite.tasks = [suite.tasks[0]];
			suite.tasks[0].workspace = { kind: "local", path: ROOT };
			const suitePath = join(scratch.root, "custom-report-suite.json");
			writeFileSync(suitePath, JSON.stringify(suite));
			for (const out of [
				relative(ROOT, join(scratch.root, "custom output's $literal")),
				join(scratch.root, "named artifact.json"),
			]) {
				const run = await runCli(["eval", "run", "--suite", suitePath, "--out", out, "--clio-coder-entry", CLI], {
					env: scratch.env,
					timeoutMs: 60_000,
				});
				strictEqual(run.code, 0, run.stdout + run.stderr);
				const evalId = /^eval: (\S+)$/mu.exec(run.stdout)?.[1];
				const artifactPath = /^artifact: (.+)$/mu.exec(run.stdout)?.[1];
				ok(evalId, run.stdout);
				ok(artifactPath, run.stdout);
				const bytes = readFileSync(artifactPath);
				const missing = await runCli(["eval", "report", evalId], { env: scratch.env });
				strictEqual(missing.code, 1, missing.stdout + missing.stderr);
				match(missing.stderr, /eval artifact not found/u);
				const command = /^report: (.+)$/mu.exec(run.stdout)?.[1];
				ok(command, run.stdout);
				const report = execFileSync("sh", ["-c", `alias clio-coder='"$CLIO_TEST_NODE" "$CLIO_TEST_ENTRY"'\n${command}`], {
					cwd: scratch.root,
					env: { ...scratch.env, CLIO_TEST_NODE: process.execPath, CLIO_TEST_ENTRY: CLI },
					encoding: "utf8",
					timeout: 20_000,
				});
				ok(report.startsWith(`# Eval ${evalId}\n`), report);
				match(report, /Pass rate: 100\.00%/u);
				deepStrictEqual(readFileSync(artifactPath), bytes);
				strictEqual(existsSync(join(scratch.root, "data", "evals", `${evalId}.json`)), false);
				const corrupted = JSON.parse(bytes.toString("utf8"));
				corrupted.results[0].executionEnvelope.target = "conflicting-target";
				const corruptPath = join(scratch.root, "corrupted.json");
				writeFileSync(corruptPath, JSON.stringify(corrupted));
				const rejected = await runCli(["eval", "report", "--artifact", corruptPath], { env: scratch.env });
				strictEqual(rejected.code, 1, rejected.stdout + rejected.stderr);
				match(rejected.stderr, /executionEnvelope: conflicts with result target or behavioral corpus/u);
				const ambiguous = await runCli(["eval", "report", evalId, "--artifact", artifactPath], { env: scratch.env });
				strictEqual(ambiguous.code, 2, ambiguous.stdout + ambiguous.stderr);
			}
		} finally {
			scratch.cleanup();
		}
	});

	it("round-trips all shipped machinery cases through eval report and self-comparison", async () => {
		const scratch = home("clio-eval-machinery-");
		try {
			const run = await runCli(["eval", "run", "--suite", "evals/behavioral-machinery.yaml", "--clio-coder-entry", CLI], {
				env: scratch.env,
				timeoutMs: 300_000,
			});
			strictEqual(run.code, 0, run.stdout + run.stderr);
			const evalId = /^eval: (\S+)$/mu.exec(run.stdout)?.[1];
			ok(evalId, run.stdout);

			const report = await runCli(["eval", "report", evalId, "--format", "md"], { env: scratch.env });
			strictEqual(report.code, 0, report.stderr);
			ok(report.stdout.startsWith(`# Eval ${evalId}\n`), report.stdout);
			match(report.stdout, /Pass rate: 100\.00%/u);

			const artifact = await loadEvalArtifactV4(join(scratch.root, "data"), evalId);
			strictEqual(artifact.summary.runs, 26);
			strictEqual(artifact.summary.passed, 26);
			strictEqual(artifact.summary.failed, 0);
			const roles = [
				"architect",
				"coder",
				"context-bootstrap",
				"debugger",
				"documenter",
				"git-master",
				"oracle",
				"provenance",
				"researcher",
				"scout",
				"tester",
				"verifier",
				"wiki-writer",
			];
			deepStrictEqual(
				artifact.results.map((result) => result.taskId),
				roles.flatMap((role) => [`${role}-positive`, `${role}-adversarial`]),
			);
			for (const result of artifact.results) {
				strictEqual(result.pass, true, result.taskId);
				strictEqual(result.failureClass, null, result.taskId);
				strictEqual(result.verdict?.outcome, "pass", result.taskId);
				strictEqual(result.verdict.machinery, "ok", result.taskId);
				strictEqual(result.verdict.reason, null, result.taskId);
				strictEqual(result.behavioral?.outcome, "pass", result.taskId);
				ok(result.executionEnvelope, result.taskId);
				strictEqual(result.executionEnvelope.target, result.target.id, result.taskId);
				deepStrictEqual(result.executionEnvelope.corpus, result.behavioral?.corpus, result.taskId);
				ok(report.stdout.includes(`| ${result.taskId} |`), result.taskId);
			}

			const compared = await runCli(["eval", "compare", evalId, evalId, "--format", "json"], { env: scratch.env });
			strictEqual(compared.code, 0, compared.stderr);
			const comparison = JSON.parse(compared.stdout) as EvalCompareV4Summary;
			strictEqual(comparison.baselineEvalId, evalId);
			strictEqual(comparison.candidateEvalId, evalId);
			strictEqual(comparison.hardGate.pass, true);
			strictEqual(comparison.configDrift, false);
			strictEqual(comparison.passRateDelta, 0);
			deepStrictEqual(comparison.envelopeMismatches, []);

			const routeBaseline = structuredClone(artifact);
			routeBaseline.evalId = `${evalId}-route-baseline`;
			routeBaseline.matrix.dimensions = ["target", "wireModel", "runtime", "thinkingLevel"];
			const routeCandidate = structuredClone(routeBaseline);
			routeCandidate.evalId = `${evalId}-route-candidate`;
			routeCandidate.matrix.target = "fixture-candidate";
			routeCandidate.matrix.model = "fixture-model";
			routeCandidate.matrix.thinking = "high";
			for (const result of routeCandidate.results) {
				ok(result.executionEnvelope);
				ok(result.behavioralMetrics);
				result.target = { id: "fixture-candidate", model: "fixture-model", thinking: "high" };
				result.behavioralMetrics.target = { id: "fixture-candidate", model: "fixture-model" };
				result.executionEnvelope.target = "fixture-candidate";
				result.executionEnvelope.wireModel = "fixture-model";
				result.executionEnvelope.runtime = "fixture-runtime";
				result.executionEnvelope.thinkingLevel = "high";
			}
			await writeEvalArtifactV4(join(scratch.root, "data"), routeBaseline);
			await writeEvalArtifactV4(join(scratch.root, "data"), routeCandidate);
			const routesCompared = await runCli(
				["eval", "compare", routeBaseline.evalId, routeCandidate.evalId, "--allow-config-drift", "--format", "json"],
				{ env: scratch.env },
			);
			strictEqual(routesCompared.code, 0, routesCompared.stdout + routesCompared.stderr);
			const routesComparison = JSON.parse(routesCompared.stdout) as EvalCompareV4Summary;
			strictEqual(routesComparison.hardGate.pass, true);
			strictEqual(routesComparison.behavioralMetrics.length, comparison.behavioralMetrics.length);
			deepStrictEqual(routesComparison.envelopeMismatches, []);
			ok(routesComparison.behavioralMetrics.every((row) => row.comparability.comparable));
			for (const row of routesComparison.behavioralMetrics) {
				deepStrictEqual(row.baselineTargets, [row.target]);
				deepStrictEqual(row.candidateTargets, [{ id: "fixture-candidate", model: "fixture-model" }]);
			}
			deepStrictEqual(await loadEvalArtifactV4(join(scratch.root, "data"), evalId), artifact);

			for (const field of ["target", "corpus.id", "corpus.version"] as const) {
				const inconsistent = structuredClone(artifact);
				const envelope = inconsistent.results[0]?.executionEnvelope;
				ok(envelope);
				if (field === "target") envelope.target = "conflicting-target";
				else if (field === "corpus.id") envelope.corpus.id = "conflicting-corpus";
				else envelope.corpus.version = "0.0.0";
				throws(
					() => parseEvalArtifactV4(inconsistent, evalId),
					/results\[0\]\.executionEnvelope: conflicts with result target or behavioral corpus/u,
					field,
				);
			}
		} finally {
			scratch.cleanup();
		}
	});

	it("keeps doctor/configure outcomes and both configure cancellation codes", async () => {
		const scratch = home();
		const firstRun = home("clio-first-run-cancel-");
		try {
			const untouched = await runCli(["doctor", "--json"], { env: scratch.env });
			strictEqual(untouched.code, 0, untouched.stderr);
			strictEqual(JSON.parse(untouched.stdout).ok, true);
			strictEqual(readdirSync(scratch.root).length, 0, "read-only doctor must leave a fresh home empty");

			const fixed = await runCli(["doctor", "--fix", "--json"], { env: scratch.env });
			strictEqual(fixed.code, 0, fixed.stderr);
			const fixedReport = JSON.parse(fixed.stdout) as {
				fix: boolean;
				findings: Array<{ name: string; level?: string; detail: string }>;
			};
			strictEqual(fixedReport.fix, true);
			ok(existsSync(join(scratch.root, "config", "settings.yaml")));
			const freshSettings = readFileSync(join(scratch.root, "config", "settings.yaml"), "utf8");
			match(freshSettings, /panes:\n {4}enabled: off[\s\S]*layout: off[\s\S]*files:\n {6}enabled: false/u);
			for (const finding of fixedReport.findings.filter((entry) =>
				/panes|yazi|external tool (herdr|yazi)/u.test(entry.name),
			)) {
				strictEqual(finding.level === undefined || finding.level === "ok", true, `${finding.name}: ${finding.detail}`);
				strictEqual(/install with|set interface\.panes|--with-panes/u.test(finding.detail), false, finding.detail);
			}

			const incomplete = await runCli(["configure", "--runtime", "openai-compat"], { env: scratch.env });
			strictEqual(incomplete.code, 2);
			match(incomplete.stderr, /--id is required/u);

			const configureCancel = await runCli(["configure"], { env: scratch.env, input: "q\n" });
			strictEqual(configureCancel.code, 130, configureCancel.stdout + configureCancel.stderr);
			match(configureCancel.stderr, /configuration cancelled/u);

			const firstRunCancel = await runCli([], {
				env: { ...firstRun.env, CLIO_CODER_INTERACTIVE: "1", TERM: "xterm-256color" },
				input: "q\n",
			});
			strictEqual(firstRunCancel.code, 130, firstRunCancel.stdout + firstRunCancel.stderr);
			match(firstRunCancel.stdout, /Starting `clio-coder configure`/u);
			match(firstRunCancel.stderr, /configuration cancelled/u);
		} finally {
			firstRun.cleanup();
			scratch.cleanup();
		}
	});

	it("runs one JSON headless turn through a local provider and seals its receipt", async () => {
		const scratch = home();
		try {
			const fixed = await runCli(["doctor", "--fix"], { env: scratch.env });
			strictEqual(fixed.code, 0, fixed.stderr);
			const configured = await runCli(
				[
					"configure",
					"--id",
					"local-smoke",
					"--runtime",
					"openai-compat",
					"--url",
					endpoint,
					"--model",
					"mock-model",
					"--lifecycle",
					"user-managed",
					"--set-orchestrator",
					"--context-window",
					"32768",
					"--reasoning",
					"false",
				],
				{ env: scratch.env },
			);
			strictEqual(configured.code, 0, configured.stdout + configured.stderr);

			const doctor = await runCli(["doctor", "--json"], { env: scratch.env });
			strictEqual(doctor.code, 0, doctor.stdout + doctor.stderr);
			strictEqual(JSON.parse(doctor.stdout).ok, true);

			const prompt = "CLI_CORE_ONE_TURN";
			const turn = await runCli(["--no-context-files", "--no-skills", "run", "--json-events", "terminal", prompt], {
				env: scratch.env,
			});
			strictEqual(turn.code, 0, turn.stderr);
			const events = turn.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const types = events.map((event) => event.type);
			for (const type of ["session", "turn_start", "agent_end", "turn_end"]) ok(types.includes(type), turn.stdout);
			const settled = [...events].reverse().find((event) => event.type === "turn_end");
			strictEqual(settled?.exitCode, 0);
			ok(typeof settled?.endedAt === "string");
			ok(
				requests.some((request) => JSON.stringify(request.messages).includes(prompt)),
				"prompt must reach provider",
			);

			const receiptDir = join(scratch.root, "state", "receipts");
			const files = readdirSync(receiptDir).filter((name) => name.endsWith(".json"));
			strictEqual(files.length, 1);
			const receipt = JSON.parse(readFileSync(join(receiptDir, files[0] ?? ""), "utf8")) as Record<string, unknown>;
			strictEqual(receipt.exitCode, 0);
			strictEqual(receipt.outcome, "succeeded");
			strictEqual(receipt.agentId, "main-agent");
			strictEqual(receipt.targetId, "local-smoke");
			strictEqual(receipt.wireModelId, "mock-model");
			ok(typeof receipt.runId === "string" && receipt.runId.length > 0);
			ok(typeof receipt.sessionId === "string" && receipt.sessionId.length > 0);
			ok(typeof receipt.integrity === "object" && receipt.integrity !== null);
		} finally {
			scratch.cleanup();
		}
	});

	it("compiles a headless run at the --autonomy level instead of the saved one", async () => {
		// The flag was keyed by the bare word in the session overrides, which
		// wrote a top-level key nothing reads; a `run --autonomy full-auto` in a
		// home saved at auto-edit compiled and admitted at auto-edit.
		const scratch = home();
		try {
			const fixed = await runCli(["doctor", "--fix"], { env: scratch.env });
			strictEqual(fixed.code, 0, fixed.stderr);
			const configured = await runCli(
				[
					"configure",
					"--id",
					"local-smoke",
					"--runtime",
					"openai-compat",
					"--url",
					endpoint,
					"--model",
					"mock-model",
					"--lifecycle",
					"user-managed",
					"--set-orchestrator",
					"--context-window",
					"32768",
					"--reasoning",
					"false",
				],
				{ env: scratch.env },
			);
			strictEqual(configured.code, 0, configured.stdout + configured.stderr);
			const systemPromptOf = (request: Record<string, unknown> | undefined): string => {
				const first = (request?.messages as Array<{ role?: string; content?: unknown }> | undefined)?.[0];
				return first?.role === "system" && typeof first.content === "string" ? first.content : "";
			};
			const saved = await runCli(["--no-context-files", "--no-skills", "run", "--json", "CLI_CORE_SAVED_AUTONOMY"], {
				env: scratch.env,
			});
			strictEqual(saved.code, 0, saved.stderr);
			match(systemPromptOf(requests.at(-1)), /Autonomy: auto-edit\./u);
			const overridden = await runCli(
				["--no-context-files", "--no-skills", "run", "--autonomy", "full-auto", "--json", "CLI_CORE_FLAG_AUTONOMY"],
				{ env: scratch.env },
			);
			strictEqual(overridden.code, 0, overridden.stderr);
			match(systemPromptOf(requests.at(-1)), /Autonomy: full-auto\./u);
		} finally {
			scratch.cleanup();
		}
	});
});
