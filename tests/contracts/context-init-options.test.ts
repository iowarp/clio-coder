import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runInitCommand } from "../../src/cli/init.js";
import { runBootstrap, serializeClioMd } from "../../src/domains/context/index.js";
import {
	applyInitImplications,
	bootstrapInputFromInitOptions,
	CONTEXT_INIT_FLAG_TABLE,
	type ContextInitOptions,
	validateInitOptions,
} from "../../src/domains/context/init-options.js";
import { parseSlashCommand } from "../../src/interactive/slash-commands.js";

const scratchRoots: string[] = [];

afterEach(() => {
	for (const root of scratchRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function scratchProject(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-init-options-"));
	scratchRoots.push(root);
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "init-options-fixture", type: "module" }), "utf8");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "index.ts"), "export const initOptionsFixture = true;\n", "utf8");
	return root;
}

function slashInitOptions(input: string): ContextInitOptions {
	const parsed = parseSlashCommand(input);
	strictEqual(parsed.kind, "init");
	return parsed.options;
}

function contextInitOptionsFromCliArgs(args: ReadonlyArray<string>): ContextInitOptions {
	const options: ContextInitOptions = {};
	for (const arg of args) {
		const row = CONTEXT_INIT_FLAG_TABLE.find((candidate) => candidate.flag === arg || candidate.aliases?.includes(arg));
		if (!row) throw new Error(`unknown test flag ${arg}`);
		options[row.field] = true;
	}
	return applyInitImplications(options);
}

async function captureProcessWrites<T>(fn: () => Promise<T>): Promise<{ stdout: string; stderr: string; value: T }> {
	const originalStdoutWrite = process.stdout.write;
	const originalStderrWrite = process.stderr.write;
	let stdout = "";
	let stderr = "";
	const capture =
		(target: "stdout" | "stderr") =>
		(
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((err?: Error) => void),
			callback?: (err?: Error) => void,
		) => {
			const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
			if (target === "stdout") stdout += text;
			else stderr += text;
			if (typeof encodingOrCallback === "function") encodingOrCallback();
			if (typeof callback === "function") callback();
			return true;
		};
	process.stdout.write = capture("stdout") as typeof process.stdout.write;
	process.stderr.write = capture("stderr") as typeof process.stderr.write;
	try {
		const value = await fn();
		return { stdout, stderr, value };
	} finally {
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
	}
}

describe("contracts/context-init-options", () => {
	it("keeps rewrite implications in the shell options while /context init stays zero-argument", () => {
		deepStrictEqual(applyInitImplications({ rewriteClioMd: true }), {
			applyClioMd: true,
			rewriteClioMd: true,
		});
		deepStrictEqual(slashInitOptions("/context init"), {});
		for (const flag of ["--rewrite", "--apply", "--include-global"]) {
			deepStrictEqual(parseSlashCommand(`/context init ${flag}`), {
				kind: "unknown",
				text: `/context init ${flag}`,
			});
		}
	});

	it("keeps advanced shell init flags table-driven", () => {
		deepStrictEqual(contextInitOptionsFromCliArgs(["--rewrite"]), {
			applyClioMd: true,
			rewriteClioMd: true,
		});
		deepStrictEqual(contextInitOptionsFromCliArgs(["--include-global"]), { includeGlobalImports: true });
		deepStrictEqual(contextInitOptionsFromCliArgs(["--heuristic"]), { heuristic: true });
	});

	it("regenerates from scratch on --rewrite instead of using the existing CLIO.md as source", async () => {
		const cwd = scratchProject();
		writeFileSync(
			join(cwd, "CLIO.md"),
			serializeClioMd({
				projectName: "Curated Context",
				identity: "Curated Context is an existing handbook that rewrite must ignore.",
				conventions: ["This convention must not be fed back to the generator."],
				invariants: [],
				fingerprint: {
					initAt: "2026-05-01T00:00:00.000Z",
					model: "test-model",
					gitHead: null,
					treeHash: "0".repeat(64),
					loc: 1,
				},
			}),
			"utf8",
		);
		let generated = false;

		await runBootstrap({
			cwd,
			...bootstrapInputFromInitOptions({ rewriteClioMd: true }),
			confirmGitignore: () => true,
			modelId: "stub-model",
			now: () => new Date("2026-05-01T00:00:00.000Z"),
			generate: (input) => {
				generated = true;
				strictEqual(input.existingClioMd, undefined);
				strictEqual(input.existingClioMdText, undefined);
				return {
					projectName: "Fresh Context",
					identity: "Fresh Context is generated without the old handbook as source.",
					conventions: ["Use fresh repository evidence."],
					invariants: [],
					sections: [
						{
							title: "Fresh Rewrite Evidence",
							body: "This custom section was generated without the old handbook as source.",
						},
					],
				};
			},
		});

		strictEqual(generated, true);
		const after = readFileSync(join(cwd, "CLIO.md"), "utf8");
		ok(after.includes("# Init Options Fixture"), after);
		ok(after.includes("## Fresh Rewrite Evidence"), after);
		strictEqual(after.includes("Curated Context"), false);
	});

	it("rejects --propose conflicts through the shared validator and CLI usage path", async () => {
		ok(validateInitOptions({ proposeClioMd: true, adopt: true }));
		ok(validateInitOptions({ proposeClioMd: true, applyClioMd: true }));
		ok(validateInitOptions({ proposeClioMd: true, rewriteClioMd: true }));

		for (const conflict of ["--adopt", "--apply", "--rewrite"]) {
			const captured = await captureProcessWrites(() => runInitCommand(["--propose", conflict]));
			strictEqual(captured.value, 2);
			match(captured.stderr, /--propose cannot be combined with --adopt, --apply, or --rewrite/);
			match(captured.stdout, /Usage:/);
		}
	});
});
