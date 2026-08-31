/**
 * `@anthropic-ai/claude-agent-sdk` is an `optionalDependencies` entry (#258):
 * its platform package carries a 224MB proprietary binary, so a default install
 * may legitimately skip it. The contract is that absence costs nothing until a
 * `claude-sdk` run actually starts, and then fails with a typed diagnostic
 * naming the package and the install command.
 *
 * Absence is simulated two ways. In-process, `setClaudeAgentSdkLoader` replaces
 * the dynamic import with one that throws the resolution error Node raises for
 * a missing package. Out of process, a child registers an ESM resolve hook that
 * makes the specifier genuinely unresolvable, then imports the engine module
 * graph, so "nothing imports it at module scope" is checked against real module
 * resolution rather than a stub. Presence is checked against the real module.
 */
import { match, ok, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import claudeSdkRuntime from "../../src/domains/providers/runtimes/claude/claude-sdk.js";
import {
	CLAUDE_AGENT_SDK_INSTALL_COMMAND,
	CLAUDE_AGENT_SDK_PACKAGE,
	CLAUDE_AGENT_SDK_VERSION,
	ClaudeAgentSdkUnavailableError,
	loadClaudeAgentSdk,
	setClaudeAgentSdkLoader,
} from "../../src/engine/claude/sdk-module.js";
import { startClaudeSdkWorkerRun } from "../../src/engine/claude/sdk-runtime.js";
import type { WorkerRunInput } from "../../src/engine/worker-runtime.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The error Node raises when a bare specifier resolves to nothing on disk. */
function moduleNotFound(): Error {
	const error = new Error(`Cannot find package '${CLAUDE_AGENT_SDK_PACKAGE}' imported from clio`);
	(error as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
	return error;
}

function claudeSdkInput(): WorkerRunInput {
	return {
		systemPrompt: "",
		agentId: "coder",
		task: "run pwd",
		target: { id: "contract", runtime: "claude-sdk" } as WorkerRunInput["target"],
		runtime: claudeSdkRuntime,
		wireModelId: "sonnet",
		allowedTools: ["read", "grep", "find", "ls"],
		budget: { toolCalls: 4, readReserve: 1, synthesis: true, hardCap: 8 },
	};
}

describe("contracts/claude agent sdk is optional", () => {
	after(() => setClaudeAgentSdkLoader(null));

	it("pins the install command to the version package.json carries in optionalDependencies", () => {
		const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
		};
		strictEqual(
			manifest.dependencies?.[CLAUDE_AGENT_SDK_PACKAGE],
			undefined,
			"the SDK must not be a hard dependency; a default install has to be installable without it",
		);
		strictEqual(manifest.optionalDependencies?.[CLAUDE_AGENT_SDK_PACKAGE], CLAUDE_AGENT_SDK_VERSION);
		strictEqual(CLAUDE_AGENT_SDK_INSTALL_COMMAND, `npm install ${CLAUDE_AGENT_SDK_PACKAGE}@${CLAUDE_AGENT_SDK_VERSION}`);
	});

	it("fails a missing package with a typed error naming the package and the install command", async () => {
		setClaudeAgentSdkLoader(() => Promise.reject(moduleNotFound()));
		let caught: unknown;
		try {
			await loadClaudeAgentSdk();
		} catch (error) {
			caught = error;
		}
		ok(caught instanceof ClaudeAgentSdkUnavailableError, `expected the typed error, got ${String(caught)}`);
		strictEqual(caught.code, "CLAUDE_AGENT_SDK_UNAVAILABLE");
		strictEqual(caught.packageName, CLAUDE_AGENT_SDK_PACKAGE);
		strictEqual(caught.installCommand, CLAUDE_AGENT_SDK_INSTALL_COMMAND);
		match(caught.message, /@anthropic-ai\/claude-agent-sdk/);
		match(caught.message, /npm install @anthropic-ai\/claude-agent-sdk@/);
	});

	it("passes a load fault that is not a resolution failure through unchanged", async () => {
		const fault = new TypeError("the SDK blew up at module scope");
		setClaudeAgentSdkLoader(() => Promise.reject(fault));
		let caught: unknown;
		try {
			await loadClaudeAgentSdk();
		} catch (error) {
			caught = error;
		}
		strictEqual(caught, fault, "a broken install must not be mislabeled as an absent package");
	});

	it("fails a claude-sdk run at use time, not at construction, with the install diagnostic", async () => {
		setClaudeAgentSdkLoader(() => Promise.reject(moduleNotFound()));
		const kinds: string[] = [];
		// Constructing the handle is synchronous and must not throw: the missing
		// package is a run outcome, not a crash in the dispatch path.
		const handle = startClaudeSdkWorkerRun(claudeSdkInput(), (event) => {
			kinds.push((event as { type: string }).type);
		});
		const result = await handle.promise;

		strictEqual(result.exitCode, 1);
		ok(kinds.includes("agent_start"), `the run announced itself: ${kinds.join(",")}`);
		ok(kinds.includes("agent_end"), `the run closed its event contract: ${kinds.join(",")}`);
		const final = result.messages.at(-1);
		ok(final, "the run produced a final message");
		const errorMessage = (final as { errorMessage?: string }).errorMessage ?? "";
		match(errorMessage, /@anthropic-ai\/claude-agent-sdk/);
		match(errorMessage, /npm install @anthropic-ai\/claude-agent-sdk@/);
	});

	it("loads the real module when the optional package is installed", async () => {
		setClaudeAgentSdkLoader(null);
		const sdk = await loadClaudeAgentSdk();
		strictEqual(typeof sdk.query, "function", "the lazy path resolves the real SDK export");
		// The cache hands back the same module object on a second run.
		strictEqual(await loadClaudeAgentSdk(), sdk);
	});

	it("boots the engine module graph and runs unrelated runtimes with the package unresolvable", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-sdk-absent-"));
		try {
			const hooks = join(scratch, "block-claude-sdk.mjs");
			writeFileSync(
				hooks,
				`export async function resolve(specifier, context, next) {
	if (specifier === ${JSON.stringify(CLAUDE_AGENT_SDK_PACKAGE)}) {
		const error = new Error("Cannot find package '" + specifier + "'");
		error.code = "ERR_MODULE_NOT_FOUND";
		throw error;
	}
	return next(specifier, context);
}
`,
				"utf8",
			);
			const probe = join(scratch, "probe.mjs");
			writeFileSync(
				probe,
				`import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(pathToFileURL(${JSON.stringify(hooks)}));

// Boot: the engine module graph must import with the optional package gone.
const { startWorkerRun } = await import(${JSON.stringify(join(REPO_ROOT, "src/engine/worker-runtime.ts"))});
// Unrelated feature: a non-Claude runtime still builds its argv.
const { buildAgyArgs } = await import(${JSON.stringify(join(REPO_ROOT, "src/engine/antigravity/subprocess-runtime.ts"))});
const argv = buildAgyArgs({
	systemPrompt: "",
	agentId: "coder",
	task: "run pwd",
	target: { id: "contract", runtime: "antigravity-code" },
	runtime: { id: "antigravity-code" },
	wireModelId: "gemini",
	allowedTools: ["read"],
	budget: { toolCalls: 4, readReserve: 1, synthesis: true, hardCap: 8 },
});

// The dependent feature: the lazy loader turns real absence into the typed error.
const { loadClaudeAgentSdk } = await import(${JSON.stringify(join(REPO_ROOT, "src/engine/claude/sdk-module.ts"))});
let typed = null;
try {
	await loadClaudeAgentSdk();
} catch (error) {
	typed = { name: error.name, code: error.code, message: error.message };
}

process.stdout.write(JSON.stringify({
	booted: typeof startWorkerRun === "function",
	unrelatedArgv: Array.isArray(argv),
	typed,
}));
`,
				"utf8",
			);

			const { stdout, stderr } = await execFileAsync(process.execPath, ["--import", "tsx", probe], {
				cwd: REPO_ROOT,
				env: process.env,
			});
			const report = JSON.parse(stdout) as {
				booted: boolean;
				unrelatedArgv: boolean;
				typed: { name: string; code: string; message: string } | null;
			};
			strictEqual(report.booted, true, `the engine graph booted without the SDK: ${stderr}`);
			strictEqual(report.unrelatedArgv, true, "an unrelated runtime still works");
			ok(report.typed, "the claude-sdk path failed closed");
			strictEqual(report.typed.name, "ClaudeAgentSdkUnavailableError");
			strictEqual(report.typed.code, "CLAUDE_AGENT_SDK_UNAVAILABLE");
			match(report.typed.message, /npm install @anthropic-ai\/claude-agent-sdk@/);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
