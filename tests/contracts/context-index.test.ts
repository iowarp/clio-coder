import { ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runContextCommand } from "../../src/cli/context.js";
import { runContextIndexCommand } from "../../src/cli/context-index.js";
import type { DomainContext, DomainContract } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import {
	ContextDomainModule,
	listWikiPages,
	readCodewiki,
	wikiDir,
	writeWikiMeta,
} from "../../src/domains/context/index.js";
import { readClioState } from "../../src/domains/context/state.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ output: string; value: T }> {
	const originalWrite = process.stdout.write;
	let output = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
		if (buffer.every((byte) => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126))) {
			output += buffer.toString("utf8");
		}
		return true;
	}) as typeof process.stdout.write;
	try {
		const value = await fn();
		return { output, value };
	} finally {
		process.stdout.write = originalWrite;
	}
}

function git(cwd: string, args: ReadonlyArray<string>): string {
	const child = spawnSync("git", [...args], { cwd, encoding: "utf8" });
	if (child.error) throw child.error;
	if (child.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${child.stderr}`);
	return child.stdout.trim();
}

function initGitRepo(cwd: string): string {
	git(cwd, ["init"]);
	git(cwd, ["config", "user.email", "clio-test@example.com"]);
	git(cwd, ["config", "user.name", "Clio Test"]);
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-m", "initial"]);
	return git(cwd, ["rev-parse", "--verify", "HEAD"]);
}

function writeTypescriptProject(cwd: string): void {
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src", "index.ts"), "export const promptFixtureSymbol = true;\n", "utf8");
}

function writeLargeClioMd(cwd: string): void {
	const longBody = "This section intentionally pushes the project context over the synopsis threshold.\n".repeat(140);
	writeFileSync(
		join(cwd, "CLIO-CODER.md"),
		[
			"# Large Prompt Fixture",
			"",
			"Large fixture used to test compact project synopsis mode.",
			"",
			"## Notes",
			"",
			longBody,
		].join("\n"),
		"utf8",
	);
}

function writeWikiPage(cwd: string, name: string, text: string): void {
	mkdirSync(wikiDir(cwd), { recursive: true });
	writeFileSync(join(wikiDir(cwd), name), text, "utf8");
}

function writeStaleWiki(cwd: string): void {
	const head = initGitRepo(cwd);
	writeWikiPage(cwd, "quickstart.md", "# Quickstart\n\nStart with `src/index.ts`.\n");
	writeWikiMeta(cwd, {
		version: 1,
		updatedAt: "2026-07-04T00:00:00.000Z",
		gitHead: head,
		model: "test-model",
		contentHash: "0".repeat(64),
		pages: listWikiPages(cwd),
	});
	writeFileSync(join(cwd, "src", "extra.ts"), "export const extra = true;\n", "utf8");
	git(cwd, ["add", "src/extra.ts"]);
	git(cwd, ["commit", "-m", "add extra"]);
}

async function compileProjectPrompt(cwd: string) {
	const bus = createSafeEventBus();
	const contracts = new Map<string, DomainContract>();
	const domainContext: DomainContext = {
		bus,
		getContract<T extends DomainContract>(name: string): T | undefined {
			return contracts.get(name) as T | undefined;
		},
	};
	const contextBundle = await ContextDomainModule.createExtension(domainContext);
	contracts.set("context", contextBundle.contract);
	const promptsBundle = createPromptsBundle(domainContext);
	await promptsBundle.extension.start();
	try {
		return await promptsBundle.contract.compileSessionPrompt({
			cwd,
			sessionInputs: {
				provider: "stub",
				model: "stub-model",
				providerSupportsTools: true,
			},
		});
	} finally {
		await promptsBundle.extension.stop?.();
	}
}

describe("contracts/context-index", () => {
	let scratch: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "clio-context-index-"));
		process.chdir(scratch);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(scratch, { recursive: true, force: true });
	});

	it("builds the codewiki and state without model or handoff artifacts", async () => {
		mkdirSync(join(scratch, "app"), { recursive: true });
		writeFileSync(join(scratch, "app", "main.py"), "def main():\n    return 0\n", "utf8");

		const { output, value } = await captureStdout(() => runContextIndexCommand(["--json"]));
		strictEqual(value, 0);
		const payload = JSON.parse(output) as Record<string, unknown>;

		strictEqual(payload.projectType, "python");
		strictEqual(payload.sourceFiles, 1);
		strictEqual(payload.indexedSourceFiles, 1);
		strictEqual(payload.coverage, 1);
		strictEqual(typeof payload.structuralHash, "string");
		ok(existsSync(join(scratch, ".clio-coder", "codewiki.json")));
		ok(existsSync(join(scratch, ".clio-coder", "state.json")));
		strictEqual(existsSync(join(scratch, ".clio-coder", "handoffs")), false);

		const codewiki = readCodewiki(scratch);
		ok(codewiki);
		strictEqual(
			codewiki.files.some((file) => file.path === "app/main.py"),
			true,
		);
		const state = readClioState(scratch);
		strictEqual(state?.projectType, "python");
		strictEqual(state?.codewikiVersion, 5);
		strictEqual(typeof state?.lastIndexedAt, "string");
		ok(readFileSync(join(scratch, ".clio-coder", "codewiki.json"), "utf8").includes('"version":5'));
	});

	it("loads legacy state without codewikiVersion", () => {
		mkdirSync(join(scratch, ".clio-coder"), { recursive: true });
		writeFileSync(
			join(scratch, ".clio-coder", "state.json"),
			JSON.stringify({
				version: 1,
				fingerprint: { treeHash: "0".repeat(64), gitHead: null, loc: 1 },
			}),
			"utf8",
		);

		const state = readClioState(scratch);
		ok(state);
		strictEqual(state.codewikiVersion, undefined);
	});

	it("renders the codewiki digest in context status when codewiki exists", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "index.ts"), "export const statusDigest = true;\n", "utf8");

		const indexed = await captureStdout(() => runContextIndexCommand(["--json"]));
		strictEqual(indexed.value, 0);
		const { output, value } = await captureStdout(() => runContextCommand([]));

		strictEqual(value, 0);
		ok(output.includes("codewiki: fresh"));
		ok(output.includes("entry points:"));
	});

	it("omits the codewiki digest in context status when codewiki is absent", async () => {
		const { output, value } = await captureStdout(() => runContextCommand([]));

		strictEqual(value, 0);
		ok(output.includes("codewiki: absent"));
		strictEqual(output.includes("entry points:"), false);
	});

	it("preserves wiki availability and stale suffix in project synopsis mode", async () => {
		const absentClio = join(scratch, "absent-clio");
		mkdirSync(absentClio, { recursive: true });
		writeTypescriptProject(absentClio);
		writeStaleWiki(absentClio);

		const absentPrompt = await compileProjectPrompt(absentClio);

		strictEqual(absentPrompt.projectPreload?.mode, "synopsis");
		ok(absentPrompt.systemPrompt.includes("<project-synopsis>"));
		ok(
			absentPrompt.systemPrompt.includes(
				"Wiki: 1 pages at .clio-coder/wiki (start: quickstart.md) (stale; run clio-coder context wiki --update)",
			),
		);

		const largeClio = join(scratch, "large-clio");
		mkdirSync(largeClio, { recursive: true });
		writeTypescriptProject(largeClio);
		writeLargeClioMd(largeClio);
		writeStaleWiki(largeClio);

		const largePrompt = await compileProjectPrompt(largeClio);

		strictEqual(largePrompt.projectPreload?.mode, "synopsis");
		ok(
			largePrompt.systemPrompt.includes(
				"CLIO-CODER.md: available; compact synopsis only because the handbook is too large",
			),
		);
		ok(
			largePrompt.systemPrompt.includes(
				"Wiki: 1 pages at .clio-coder/wiki (start: quickstart.md) (stale; run clio-coder context wiki --update)",
			),
		);
	});
});
