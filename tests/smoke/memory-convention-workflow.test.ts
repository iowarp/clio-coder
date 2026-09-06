import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import {
	loadMemoryRecords,
	memoryStorePath,
	parseTaskMemoryHandoffSnapshot,
	renderTaskMemoryHandoffSource,
	runTaskMemoryPolicy,
	TaskMemoryBank,
} from "../../src/domains/memory/index.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { listSessionsForCwd } from "../../src/domains/session/history.js";
import { closeServer, startOpenAICompatFixture } from "../harness/openai-compat-fixture.js";
import { isolateClioEnv, scratchClioEnvVars } from "../harness/scratch-env.js";

const CLI = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
const MARKER = "CLIO_MEMORY_convention_fixture";
const TRANSCRIPT_ONLY = "CLIO_TRANSCRIPT_ONLY_not_durable";
const UNRELATED = "CLIO_UNRELATED_report_convention";

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
		execFile(
			process.execPath,
			[CLI, ...args],
			{ cwd, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error && typeof error.code !== "number") reject(error);
				else resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
			},
		);
	});
}

test("operator promotion persists a convention and only approval admits it into a fresh process prompt", {
	timeout: 120_000,
}, async (t) => {
	const home = await isolateClioEnv("clio-convention-workflow-");
	// This server returns a constant acknowledgement. Consumption is proved by
	// the incoming prompt, never by a scripted answer claiming to remember.
	const fixture = await startOpenAICompatFixture("Fixture acknowledged.");
	try {
		const workspace = join(home.dir, "repo");
		const otherRepository = join(home.dir, "other-repo");
		const dataDir = join(home.dir, "data");
		mkdirSync(join(workspace, "tests"), { recursive: true });
		mkdirSync(join(workspace, "findiff"));
		mkdirSync(otherRepository);
		const sources = [
			["tests/test_coefs.py", "def polynomial_control(x):\n    return x**3, 3*x**2\n"],
			["findiff/coefs.py", "def local_offsets(coords, center):\n    return [x - coords[center] for x in coords]\n"],
		] as const;
		for (const [path, content] of sources) writeFileSync(join(workspace, path), content);
		const sourceText = sources.map(([path]) => `${path}:1-2\n${readFileSync(join(workspace, path), "utf8")}`).join("\n");
		const lesson = `${MARKER}: New numerical regressions include a polynomial exactness control and a nonuniform-grid example. Sources: tests/test_coefs.py:1-2; findiff/coefs.py:1-2.`;
		const { contract: session } = createSessionBundle({ bus: createSafeEventBus(), getContract: () => undefined });
		const origin = session.create({ cwd: workspace });
		const request = session.append({ parentId: null, kind: "user", payload: `Remember this convention: ${lesson}` });
		session.append({ parentId: request.id, kind: "assistant", payload: `${sourceText}\n${TRANSCRIPT_ONLY}` });
		await session.checkpoint("convention fixture source");

		const bank = new TaskMemoryBank();
		// Controlled background response, not a live model or invented historical
		// proposal. The real policy writes the bank and keeps its citation gate.
		const capture = await runTaskMemoryPolicy(
			bank,
			{
				complete: async () => ({
					text: `<operations>${JSON.stringify([
						{ op: "save_knowledge", content: lesson },
						{ op: "save_knowledge", content: `${UNRELATED}: Reports include an environment summary.` },
					])}</operations><context_for_action>Remember the inspected convention.</context_for_action>`,
				}),
			},
			{ task: `${lesson}\n${sourceText}`, trajectory: [], deterministicTrigger: false, maxTokens: 2000 },
		);
		strictEqual(capture.reason, "uncited");
		strictEqual(capture.reminder, null);
		deepStrictEqual(await loadMemoryRecords(dataDir), [], "bank capture is not a durable proposal");
		const handoff = renderTaskMemoryHandoffSource(bank.snapshot(), {
			sessionId: origin.id,
			evidenceRefs: [`session-${origin.id}`],
			runtimeIds: [],
			agentIds: [],
		});
		const snapshot = parseTaskMemoryHandoffSnapshot(handoff);
		ok(snapshot?.version === 2);
		strictEqual(snapshot.knowledge[0]?.content, lesson);
		strictEqual(snapshot.knowledge[0]?.injectionCount, 0);
		const handoffPath = join(home.dir, "reviewed-handoff.md");
		writeFileSync(handoffPath, handoff);
		bank.clear();
		deepStrictEqual(bank.snapshot().knowledge, []);

		mkdirSync(join(home.dir, "config"), { recursive: true });
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [
			{
				id: "fixture",
				runtime: "openai-compat",
				url: fixture.url,
				defaultModel: "mock-model",
				auth: { apiKeyEnvVar: "CLIO_CONVENTION_FIXTURE_KEY" },
				capabilities: { chat: true, tools: true, toolCallFormat: "openai" },
			},
		];
		settings.chat.target = "fixture";
		settings.chat.model = "mock-model";
		settings.chat.thinkingLevel = "off";
		settings.context.memory.enabled = false;
		writeFileSync(join(home.dir, "config", "settings.yaml"), JSON.stringify(settings));
		const env = {
			...process.env,
			...scratchClioEnvVars(home.dir, { requireHomePrefix: true }),
			CLIO_CONVENTION_FIXTURE_KEY: "fixture",
		};
		const command = async (args: string[]) => {
			const result = await run(["memory", ...args], workspace, env);
			strictEqual(result.code, 0, result.stderr);
			return result;
		};
		const consumerSessions: string[] = [];
		const consume = async (cwd: string) => {
			const previousSessions = new Set(listSessionsForCwd(cwd).map((meta) => meta.id));
			fixture.requests.length = 0;
			const result = await run(
				[
					"--no-context-files",
					"--no-skills",
					"run",
					"--json",
					"--target",
					"fixture",
					"--model",
					"mock-model",
					"--autonomy",
					"read-only",
					"What approved numerical regression convention applies here?",
				],
				cwd,
				env,
			);
			strictEqual(result.code, 0, result.stderr);
			const created = listSessionsForCwd(cwd).filter((meta) => !previousSessions.has(meta.id));
			strictEqual(created.length, 1, "each CLI invocation must create a genuinely fresh session");
			const fresh = created[0];
			ok(fresh && fresh.id !== origin.id);
			ok(!fresh.parentSessionId, "consumption must not rely on a fork of the source session");
			consumerSessions.push(fresh.id);
			const calls = fixture.requests.filter((request) => request.stream !== false);
			strictEqual(calls.length, 1, "fresh run must not retrieve transcripts or call tools");
			const messages = calls[0]?.messages as Array<{ role: string; content: unknown }>;
			strictEqual(messages.filter((message) => message.role === "user").length, 1);
			strictEqual(
				messages.some((message) => message.role === "assistant" || message.role === "tool"),
				false,
			);
			const prompt = JSON.stringify(messages);
			strictEqual(prompt.includes(TRANSCRIPT_ONLY), false, "transcript recovery is not memory consumption");
			return prompt;
		};
		const missing = await run(["memory", "approve", "mem-does-not-exist"], workspace, env);
		strictEqual(missing.code, 1);
		deepStrictEqual(await loadMemoryRecords(dataDir), []);
		for (const entry of snapshot.knowledge) {
			await command([
				"promote",
				"--from-handoff",
				handoffPath,
				"--entry",
				entry.id,
				"--scope",
				"repo",
				"--repository",
				workspace,
			]);
		}
		const proposals = await loadMemoryRecords(dataDir);
		strictEqual(proposals.length, 2);
		const convention = proposals.find((record) => record.lesson === lesson);
		const unrelated = proposals.find((record) => record.lesson.includes(UNRELATED));
		ok(convention && unrelated);
		strictEqual(convention.approved, false);
		strictEqual(convention.provenance?.sourceSessionId, origin.id);
		strictEqual(convention.provenance?.sourceEntryId, snapshot.knowledge[0]?.id);
		match(readFileSync(memoryStorePath(dataDir), "utf8"), /"approved": false/u);
		// These are explicit test-driver operator actions, separate from the
		// scripted model. No approved flag is seeded or patched in the fixture.
		await command(["approve", unrelated.id]);
		const beforeApproval = await consume(workspace);
		ok(beforeApproval.includes(UNRELATED));
		strictEqual(beforeApproval.includes(MARKER), false, "unrelated approved memory is not retention of this convention");
		await command(["list"]);
		await command(["approve", convention.id]);
		const persisted = (await loadMemoryRecords(dataDir)).find((record) => record.id === convention.id);
		strictEqual(persisted?.approved, true);
		ok(persisted?.lastVerifiedAt);
		const afterApproval = await consume(workspace);
		ok(afterApproval.includes(MARKER));
		ok(afterApproval.includes(convention.id));
		ok(afterApproval.includes(`session-${origin.id}`));
		ok(afterApproval.includes("tests/test_coefs.py:1-2"));
		strictEqual((await consume(otherRepository)).includes(MARKER), false);
		await command(["reject", convention.id]);
		strictEqual((await consume(workspace)).includes(MARKER), false);
		for (const [path, content] of sources) strictEqual(readFileSync(join(workspace, path), "utf8"), content);
		t.diagnostic(
			JSON.stringify({
				capture: "scripted policy output; uncited reminder gated",
				sourceSession: origin.id,
				consumerSessions,
				proposal: convention.id,
				approval: "explicit test-driver CLI action",
				persistence: "reloaded records.json",
				consumption: "fresh process request includes exact record, lesson and evidence after approval only",
				unrelatedMemory: "present before target approval; graded separately",
				transcriptRecovery: "absent",
				wrongRepository: "excluded",
				rejectedRecord: "excluded",
				liveModelAcceptance: "not run",
			}),
		);
	} finally {
		await closeServer(fixture.server);
		home.restore();
	}
});
