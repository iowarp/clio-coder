import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { canonicalMemoryRepositoryIdentity } from "../../src/domains/memory/operations.js";
import { writeMemoryRecords } from "../../src/domains/memory/store.js";
import type { MemoryRecord, MemoryRepositoryIdentity } from "../../src/domains/memory/types.js";
import {
	closeServer,
	seedOpenAICompatFleetDefault,
	seedOpenAICompatOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const GLOBAL_MARKER = "BT_SLOP_006_GLOBAL_MEMORY";
const REPO_A_MARKER = "BT_SLOP_006_REPOSITORY_A_MEMORY";
const REPO_B_MARKER = "BT_SLOP_006_REPOSITORY_B_MEMORY";

function repositoryIdentity(repositoryPath: string): MemoryRepositoryIdentity {
	const identity = canonicalMemoryRepositoryIdentity(repositoryPath);
	if (identity === null) throw new Error(`could not canonicalize test repository: ${repositoryPath}`);
	return identity;
}

function memoryRecord(input: {
	id: string;
	marker: string;
	scope: "global" | "repo";
	repository?: MemoryRepositoryIdentity;
}): MemoryRecord {
	const record: MemoryRecord = {
		id: input.id,
		scope: input.scope,
		key: `integration:${input.marker}`,
		lesson: `${input.marker}: retain only in its applicable prompt.`,
		evidenceRefs: [`evidence:${input.id}`],
		appliesWhen: [],
		avoidWhen: [],
		confidence: 0.95,
		createdAt: "2026-07-10T00:00:00.000Z",
		approved: true,
	};
	if (input.repository !== undefined) record.repository = input.repository;
	return record;
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

function capturedMessageTexts(requests: ReadonlyArray<Record<string, unknown>>): string[] {
	return requests.flatMap((request) => {
		const messages = request.messages;
		return Array.isArray(messages) ? messages.map(messageText).filter((text) => text.length > 0) : [];
	});
}

function assertRepositoryBMemoryOnly(prompt: string): void {
	ok(prompt.includes(GLOBAL_MARKER), `global memory missing from prompt:\n${prompt}`);
	ok(prompt.includes(REPO_B_MARKER), `active repository memory missing from prompt:\n${prompt}`);
	strictEqual(prompt.includes(REPO_A_MARKER), false, `repository A memory leaked into repository B prompt:\n${prompt}`);
}

describe("smoke/memory repository scope integration", { concurrency: false }, () => {
	let scratch: ReturnType<typeof makeScratchHome>;

	beforeEach(() => {
		scratch = makeScratchHome("clio-memory-integration-");
	});

	afterEach(() => {
		scratch.cleanup();
	});

	async function seedRepositoryMemory(repositoryA: string, repositoryB: string): Promise<void> {
		await writeMemoryRecords(join(scratch.dir, "data"), [
			memoryRecord({ id: "mem-00000000000000a1", marker: GLOBAL_MARKER, scope: "global" }),
			memoryRecord({
				id: "mem-00000000000000a2",
				marker: REPO_A_MARKER,
				scope: "repo",
				repository: repositoryIdentity(repositoryA),
			}),
			memoryRecord({
				id: "mem-00000000000000b2",
				marker: REPO_B_MARKER,
				scope: "repo",
				repository: repositoryIdentity(repositoryB),
			}),
		]);
	}

	it("passes only global and active-repository memory through clio run --agent dispatch", async () => {
		const bootstrap = await runCli(["doctor", "--fix"], { env: scratch.env });
		strictEqual(bootstrap.code, 0, `stderr=${bootstrap.stderr}`);
		const repositoryA = join(scratch.dir, "repository-a");
		const repositoryB = join(scratch.dir, "repository-b");
		mkdirSync(repositoryA, { recursive: true });
		mkdirSync(repositoryB, { recursive: true });
		await seedRepositoryMemory(repositoryA, repositoryB);

		const fixture = await startOpenAICompatFixture("memory dispatch reply");
		try {
			seedOpenAICompatOrchestrator(join(scratch.dir, "config"), fixture.url);
			seedOpenAICompatFleetDefault(join(scratch.dir, "config"));
			const result = await runCli(
				["--no-context-files", "--no-skills", "run", "--agent", "coder", "verify repository memory"],
				{
					env: { ...scratch.env, CLIO_TEST_OPENAI_KEY: "sk-test" },
					cwd: repositoryB,
					timeoutMs: 30_000,
				},
			);
			strictEqual(result.code, 0, `stderr=${result.stderr}`);

			const messages = capturedMessageTexts(fixture.requests);
			const memoryMessages = messages.filter((text) => text.startsWith("# Memory\n"));
			strictEqual(
				memoryMessages.length,
				1,
				`expected one propagated dispatch memory message; requests=${JSON.stringify(fixture.requests)}`,
			);
			assertRepositoryBMemoryOnly(memoryMessages[0] ?? "");
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("composes only global and active-repository memory into the orchestrator prompt", async () => {
		const bootstrap = await runCli(["doctor", "--fix"], { env: scratch.env });
		strictEqual(bootstrap.code, 0, `stderr=${bootstrap.stderr}`);
		const repositoryA = join(scratch.dir, "repository-a");
		const repositoryB = join(scratch.dir, "repository-b");
		mkdirSync(repositoryA, { recursive: true });
		mkdirSync(repositoryB, { recursive: true });
		await seedRepositoryMemory(repositoryA, repositoryB);

		const fixture = await startOpenAICompatFixture("memory orchestrator reply");
		try {
			seedOpenAICompatOrchestrator(join(scratch.dir, "config"), fixture.url);
			const result = await runCli(["--no-context-files", "--no-skills", "run", "verify repository memory"], {
				env: { ...scratch.env, CLIO_TEST_OPENAI_KEY: "sk-test" },
				cwd: repositoryB,
				timeoutMs: 30_000,
			});
			strictEqual(result.code, 0, `stderr=${result.stderr}`);

			const prompt = capturedMessageTexts(fixture.requests).join("\n\n");
			assertRepositoryBMemoryOnly(prompt);
		} finally {
			await closeServer(fixture.server);
		}
	});
});
