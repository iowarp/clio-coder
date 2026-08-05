import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	closeServer,
	type OpenAICompatFixture,
	seedOpenAICompatOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const FIRST_TURN_MARKER = "RESUME_REPLAY_CODEWORD_ZEPHYR_42";

/** Newest session directory (the one holding meta.json) under the scratch state root. */
function newestSessionDir(stateDir: string): { dir: string; id: string } {
	const sessionsRoot = join(stateDir, "sessions");
	const found: Array<{ dir: string; id: string; mtimeMs: number }> = [];
	for (const repoHash of readdirSync(sessionsRoot)) {
		const repoDir = join(sessionsRoot, repoHash);
		if (!statSync(repoDir).isDirectory()) continue;
		for (const sessionId of readdirSync(repoDir)) {
			const dir = join(repoDir, sessionId);
			if (!existsSync(join(dir, "meta.json"))) continue;
			found.push({ dir, id: sessionId, mtimeMs: statSync(dir).mtimeMs });
		}
	}
	found.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const newest = found[0];
	if (!newest) throw new Error(`no session directory found under ${sessionsRoot}`);
	return { dir: newest.dir, id: newest.id };
}

function messageText(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (typeof part !== "object" || part === null) return "";
			const text = (part as { text?: unknown }).text;
			return typeof text === "string" ? text : "";
		})
		.join("\n");
}

describe("smoke/boot-time session resume replay", { concurrency: false }, () => {
	let scratch: ReturnType<typeof makeScratchHome>;
	let fixture: OpenAICompatFixture | null = null;

	beforeEach(() => {
		scratch = makeScratchHome("clio-resume-replay-");
	});

	afterEach(async () => {
		await closeServer(fixture?.server ?? null);
		fixture = null;
		scratch.cleanup();
	});

	it("CLIO_RESUME_SESSION_ID replays prior turns into the provider context and keeps one session root", async () => {
		const bootstrap = await runCli(["doctor", "--fix"], { env: scratch.env });
		strictEqual(bootstrap.code, 0, `stderr=${bootstrap.stderr}`);
		fixture = await startOpenAICompatFixture("acknowledged");
		seedOpenAICompatOrchestrator(join(scratch.dir, "config"), fixture.url);
		const workRepo = join(scratch.dir, "work-repo");
		mkdirSync(workRepo, { recursive: true });
		const env = { ...scratch.env, CLIO_TEST_OPENAI_KEY: "sk-test" };

		const first = await runCli(
			["--no-context-files", "--no-skills", "run", `Remember this codeword: ${FIRST_TURN_MARKER}.`],
			{ env, cwd: workRepo, timeoutMs: 30_000 },
		);
		strictEqual(first.code, 0, `stderr=${first.stderr}`);
		const session = newestSessionDir(join(scratch.dir, "state"));

		const requestCountBeforeResume = fixture.requests.length;
		const resumed = await runCli(["--no-context-files", "--no-skills", "run", "What was the codeword?"], {
			env: { ...env, CLIO_RESUME_SESSION_ID: session.id },
			cwd: workRepo,
			timeoutMs: 30_000,
		});
		strictEqual(resumed.code, 0, `stderr=${resumed.stderr}`);

		// The resumed turn's provider request must carry the prior session's
		// user turn: a boot-time resume that only re-points the ledger while
		// the model starts from an empty context is not a resume.
		const resumeRequests = fixture.requests.slice(requestCountBeforeResume);
		ok(resumeRequests.length > 0, "resumed run reached the provider");
		const replayedTexts = resumeRequests.flatMap((request) =>
			Array.isArray(request.messages) ? request.messages.map(messageText) : [],
		);
		ok(
			replayedTexts.some((text) => text.includes(FIRST_TURN_MARKER)),
			`resumed provider context is missing the prior turn; messages=${JSON.stringify(replayedTexts)}`,
		);

		// The resumed turn must parent under the session's leaf. A null parent
		// appends a second root, silently abandoning the resumed active path.
		const tree = JSON.parse(readFileSync(join(session.dir, "tree.json"), "utf8")) as Array<{
			id: string;
			parentId: string | null;
		}>;
		const roots = tree.filter((node) => node.parentId === null);
		strictEqual(roots.length, 1, `resumed session grew ${roots.length} roots; tree=${JSON.stringify(tree)}`);
	});
});
