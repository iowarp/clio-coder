import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BASH_HARD_CAP_BYTES } from "../../src/core/bash-exec.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import {
	BASH_DEFAULT_RESULT_DISPOSITION,
	type BashOutputPolicy,
	bashTool,
	normalizeBashArguments,
} from "../../src/tools/bash.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { createRegistry, type ToolInvokeOptions, type ToolResult } from "../../src/tools/registry.js";
import {
	type ToolResultDispositionMetadata,
	toolResultContextText,
	toolResultPresentationText,
} from "../../src/tools/result-disposition.js";

const ESC = "\u001b";
const NUL = "\u0000";
const roots: string[] = [];
const savedEnv = {
	CLIO_CODER_HOME: process.env.CLIO_CODER_HOME,
	CLIO_CODER_DATA_DIR: process.env.CLIO_CODER_DATA_DIR,
	CLIO_CODER_CONFIG_DIR: process.env.CLIO_CODER_CONFIG_DIR,
	CLIO_CODER_STATE_DIR: process.env.CLIO_CODER_STATE_DIR,
	CLIO_CODER_CACHE_DIR: process.env.CLIO_CODER_CACHE_DIR,
};

function restoreEnv(key: keyof typeof savedEnv, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function useStateDir(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-bash-disposition-"));
	roots.push(root);
	process.env.CLIO_CODER_HOME = root;
	process.env.CLIO_CODER_DATA_DIR = join(root, "data");
	process.env.CLIO_CODER_CONFIG_DIR = join(root, "config");
	process.env.CLIO_CODER_STATE_DIR = join(root, "state");
	process.env.CLIO_CODER_CACHE_DIR = join(root, "cache");
	resetXdgCache();
	return process.env.CLIO_CODER_STATE_DIR;
}

function allowAllSafety() {
	return {
		classify: () => ({ actionClass: "execute" as const, reasons: [] }),
		evaluate: () => ({ kind: "allow" as const, classification: { actionClass: "execute" as const, reasons: [] } }),
		observeLoop: () => ({ looping: false, key: "bash-disposition", count: 0 }),
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
		isSubset: () => true,
		audit: { recordCount: () => 0 },
	};
}

function registry() {
	const value = createRegistry({ safety: allowAllSafety() });
	registerAllTools(value);
	return value;
}

async function invokeBash(
	args: { command: string; timeout_ms?: number; output_policy?: BashOutputPolicy },
	options: ToolInvokeOptions = {},
): Promise<ToolResult> {
	const verdict = await registry().invoke({ tool: ToolNames.Bash, args }, options);
	strictEqual(verdict.kind, "ok");
	return verdict.result;
}

function resultText(result: ToolResult): string {
	return result.kind === "ok" ? result.output : result.message;
}

function disposition(result: ToolResult): ToolResultDispositionMetadata {
	const value = result.details?.resultDisposition;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("missing Bash resultDisposition metadata");
	}
	return value as unknown as ToolResultDispositionMetadata;
}

function assertByteAccounting(result: ToolResult): void {
	const applied = disposition(result);
	strictEqual(toolResultPresentationText(result), resultText(result));
	ok(applied.capturedBytes >= Number(result.details?.outputBytes ?? 0));
	strictEqual(applied.displayedBytes, Buffer.byteLength(resultText(result), "utf8"));
	strictEqual(applied.contextBytes, Buffer.byteLength(toolResultContextText(result), "utf8"));
	ok(applied.contextBytes <= applied.context.maxBytes);
}

describe("contracts/bash result disposition", () => {
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
		for (const [key, value] of Object.entries(savedEnv)) restoreEnv(key as keyof typeof savedEnv, value);
		resetXdgCache();
	});

	it("advertises one canonical optional policy and normalizes omission to bounded before execution", async () => {
		useStateDir();
		const parameters = bashTool.parameters as unknown as {
			properties?: Record<string, { anyOf?: Array<{ const?: string }>; description?: string }>;
		};
		const policySchema = parameters.properties?.output_policy;
		deepStrictEqual(
			policySchema?.anyOf?.map((entry) => entry.const),
			["full", "bounded", "summary", "metadata-only"],
		);
		ok(policySchema?.description?.includes("bounded tail"));
		deepStrictEqual(normalizeBashArguments({ command: "printf stable" }), {
			command: "printf stable",
			output_policy: "bounded",
		});
		strictEqual(BASH_DEFAULT_RESULT_DISPOSITION.context.mode, "bounded");

		const omitted = await invokeBash(
			{ command: "printf stable" },
			{ sessionId: "default-equivalence", toolCallId: "same" },
		);
		const explicit = await invokeBash(
			{ command: "printf stable", output_policy: "bounded" },
			{ sessionId: "default-equivalence", toolCallId: "same" },
		);
		deepStrictEqual(omitted, explicit);
		strictEqual(disposition(omitted).context.requestedMode, "bounded");
		strictEqual(disposition(omitted).context.appliedMode, "bounded");
	});

	it("records every admitted mode for successful and nonzero commands without losing exit facts", async () => {
		useStateDir();
		for (const mode of ["full", "bounded", "summary", "metadata-only"] as const) {
			const success = await invokeBash(
				{ command: `printf success-${mode}`, output_policy: mode },
				{ sessionId: `success-${mode}`, toolCallId: "call" },
			);
			strictEqual(success.kind, "ok", mode);
			strictEqual(success.details?.exitCode, 0, mode);
			strictEqual(success.details?.timedOut, false, mode);
			strictEqual(success.details?.aborted, false, mode);
			strictEqual(success.details?.outputCapped, false, mode);
			strictEqual(disposition(success).context.requestedMode, mode, mode);
			strictEqual(disposition(success).context.appliedMode, mode, mode);
			ok(toolResultContextText(success).includes('"exitCode":0'), mode);
			assertByteAccounting(success);

			const failureMarker = `stdout-body-${mode}`;
			const failure = await invokeBash(
				{ command: `printf ${failureMarker}; exit 7`, output_policy: mode },
				{ sessionId: `failure-${mode}`, toolCallId: "call" },
			);
			strictEqual(failure.kind, "error", mode);
			strictEqual(failure.details?.exitCode, 7, mode);
			strictEqual(failure.details?.outcome, "nonzero", mode);
			strictEqual(disposition(failure).context.requestedMode, mode, mode);
			strictEqual(disposition(failure).context.appliedMode, mode, mode);
			ok(toolResultContextText(failure).includes('"exitCode":7'), mode);
			ok(resultText(failure).includes(failureMarker), mode);
			if (mode === "metadata-only") strictEqual(toolResultContextText(failure).includes(failureMarker), false);
			assertByteAccounting(failure);
		}
	});

	it("admits full only within budget and records a typed tail downgrade with retrieval", async () => {
		const stateDir = useStateDir();
		const small = await invokeBash(
			{ command: "printf full-small", output_policy: "full" },
			{ sessionId: "full-small", toolCallId: "call" },
		);
		strictEqual(disposition(small).context.appliedMode, "full");
		strictEqual(disposition(small).downgrade, undefined);
		ok(toolResultContextText(small).includes("full-small"));

		const large = await invokeBash(
			{ command: `node -e 'process.stdout.write("x".repeat(100000) + "TAIL🙂")'`, output_policy: "full" },
			{ sessionId: "full-large", toolCallId: "call" },
		);
		const applied = disposition(large);
		deepStrictEqual(applied.downgrade, { from: "full", to: "bounded", reason: "hard-budget" });
		strictEqual(applied.context.requestedMode, "full");
		strictEqual(applied.context.appliedMode, "bounded");
		ok(toolResultContextText(large).includes("TAIL🙂"));
		strictEqual(toolResultContextText(large).includes("�"), false);
		ok(applied.offloadPath && existsSync(applied.offloadPath));
		const spilled = readFileSync(applied.offloadPath, "utf8");
		strictEqual(
			applied.offloadPath,
			join(stateDir, "scratch", "full-large", `${createHash("sha256").update(spilled).digest("hex")}.txt`),
		);
		ok(spilled.includes("TAIL🙂"));
		assertByteAccounting(large);
	});

	it("produces a stable redacted diagnostic summary with head, error-like middle, and tail", async () => {
		useStateDir();
		const secret = "api_key=abcdefghijklmnop";
		const source = [
			"HEAD marker",
			secret,
			...Array.from({ length: 20 }, (_, index) => `ordinary line ${index}`),
			"ERROR middle diagnostic must survive",
			...Array.from({ length: 20 }, (_, index) => `later line ${index}`),
			"TAIL marker",
		].join("\n");
		const script = `process.stdout.write(${JSON.stringify(source)})`;
		const args = { command: `node -e ${JSON.stringify(script)}`, output_policy: "summary" as const };
		const options = { sessionId: "summary-stable", toolCallId: "call" };
		const first = await invokeBash(args, options);
		const second = await invokeBash(args, options);
		const context = toolResultContextText(first);

		strictEqual(context, toolResultContextText(second));
		deepStrictEqual(disposition(first).summaryProvenance, disposition(second).summaryProvenance);
		strictEqual(disposition(first).summaryProvenance?.algorithm, "sha256-diagnostic-v1");
		ok((disposition(first).summaryProvenance?.redactions ?? 0) >= 1);
		ok(context.includes("HEAD marker"), context);
		ok(context.includes("ERROR middle diagnostic must survive"), context);
		ok(context.includes("TAIL marker"), context);
		ok(context.includes("api_key=[redacted:assignment]"), context);
		strictEqual(context.includes(secret), false);
		ok(resultText(first).includes(secret), "presentation remains independent from redacted model context");
		assertByteAccounting(first);
	});

	it("keeps metadata-only failures actionable while excluding stdout and stderr content", async () => {
		useStateDir();
		const marker = "private-failure-body";
		const result = await invokeBash(
			{ command: `printf ${marker}; exit 23`, output_policy: "metadata-only" },
			{ sessionId: "omit", toolCallId: "call" },
		);
		const applied = disposition(result);
		const context = toolResultContextText(result);

		strictEqual(result.kind, "error");
		strictEqual(result.details?.exitCode, 23);
		strictEqual(result.details?.outcome, "nonzero");
		strictEqual(context.includes(marker), false);
		ok(context.includes("kind=error"));
		ok(context.includes('"exitCode":23'));
		ok(context.includes("capturedBytes="));
		ok(context.includes("retrieve="));
		ok(applied.offloadPath && existsSync(applied.offloadPath));
		ok(readFileSync(applied.offloadPath, "utf8").includes(marker));
		ok(applied.retrieval.includes(applied.offloadPath));
		assertByteAccounting(result);
	});

	it("preserves timeout, abort, and hard-cap facts in deterministic summary context", async () => {
		useStateDir();
		const timeout = await invokeBash(
			{ command: "printf timeout-marker; sleep 2", timeout_ms: 100, output_policy: "summary" },
			{ sessionId: "timeout", toolCallId: "call" },
		);
		strictEqual(timeout.kind, "error");
		strictEqual(timeout.details?.timedOut, true);
		strictEqual(timeout.details?.outcome, "timeout");
		ok(toolResultContextText(timeout).includes('"timedOut":true'));
		ok(toolResultContextText(timeout).includes("timeout-marker"));

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const aborted = await invokeBash(
			{ command: "printf abort-marker; sleep 2", output_policy: "summary" },
			{ signal: controller.signal, sessionId: "abort", toolCallId: "call" },
		);
		strictEqual(aborted.kind, "error");
		strictEqual(aborted.details?.aborted, true);
		strictEqual(aborted.details?.outcome, "abort");
		ok(toolResultContextText(aborted).includes('"aborted":true'));
		ok(toolResultContextText(aborted).includes("abort-marker"));

		const unicodeCapScript =
			`process.stdout.write(Buffer.alloc(${BASH_HARD_CAP_BYTES - 1}, 97));` +
			"process.stdout.write(Buffer.from([240,159,153,130]));process.stdout.write('overflow')";
		const capped = await invokeBash(
			{ command: `node -e ${JSON.stringify(unicodeCapScript)}`, output_policy: "summary" },
			{ sessionId: "cap", toolCallId: "call" },
		);
		strictEqual(capped.kind, "error");
		strictEqual(capped.details?.outputCapped, true);
		strictEqual(capped.details?.outcome, "output-cap");
		strictEqual(capped.details?.outputBytes, BASH_HARD_CAP_BYTES);
		ok(toolResultContextText(capped).includes('"outputCapped":true'));
		strictEqual(resultText(capped).includes("�"), false, "a cap-split code point is discarded cleanly");
		assertByteAccounting(capped);
	});

	it("keeps UTF-8 boundaries and huge single-line tails valid and within every cap", async () => {
		useStateDir();
		const splitEmoji = await invokeBash({
			command: "printf '\\360'; sleep 0.02; printf '\\237'; sleep 0.02; printf '\\231'; sleep 0.02; printf '\\202'",
			output_policy: "bounded",
		});
		strictEqual(splitEmoji.kind, "ok");
		ok(resultText(splitEmoji).includes("🙂"));
		strictEqual(resultText(splitEmoji).includes("�"), false);

		const hugeLine = await invokeBash(
			{ command: `node -e 'process.stdout.write("z".repeat(100000) + "HUGE-TAIL🙂")'`, output_policy: "bounded" },
			{ sessionId: "huge-line", toolCallId: "call" },
		);
		ok(resultText(hugeLine).includes("HUGE-TAIL🙂"));
		ok(toolResultContextText(hugeLine).includes("HUGE-TAIL🙂"));
		strictEqual(resultText(hugeLine).includes("�"), false);
		strictEqual(toolResultContextText(hugeLine).includes("�"), false);
		assertByteAccounting(hugeLine);
	});

	it("keeps NUL and ANSI safe through every mode, in context and in presentation", async () => {
		useStateDir();
		// Raw NUL, CSI colour sequences, and a 4-byte code point in one capture,
		// with an error-like line so the summary strategy has a middle to keep.
		const payload =
			`head ${ESC}[31mred${ESC}[0m 🙂 ${NUL} start\n` +
			`${`${ESC}[2mnoise 🙂${ESC}[0m\n`.repeat(400)}` +
			`ERROR ${NUL} middle diagnostic 🙂\n` +
			`${ESC}[1mTAIL${ESC}[0m 🙂 ${NUL} end`;
		const script = `process.stdout.write(${JSON.stringify(payload)})`;
		for (const mode of ["full", "bounded", "summary", "metadata-only"] as const) {
			const result = await invokeBash(
				{ command: `node -e ${JSON.stringify(script)}`, output_policy: mode },
				{ sessionId: `control-bytes-${mode}`, toolCallId: "call" },
			);
			const applied = disposition(result);
			const context = toolResultContextText(result);

			strictEqual(result.kind, "ok", mode);
			strictEqual(context.includes(NUL), false, `${mode} sends no raw NUL to the model`);
			strictEqual(context.includes("�"), false, `${mode} context has no replacement character`);
			strictEqual(Buffer.from(context, "utf8").toString("utf8"), context, `${mode} context round-trips as UTF-8`);
			for (let at = context.indexOf(ESC); at !== -1; at = context.indexOf(ESC, at + 1)) {
				ok(/^\[[0-9;]*m/u.test(context.slice(at + 1)), `${mode} keeps whole ANSI sequences`);
			}
			strictEqual(resultText(result).includes("�"), false, `${mode} presentation has no replacement character`);
			ok(resultText(result).includes(NUL), `${mode} presentation keeps the captured bytes`);
			ok(applied.offloadPath && existsSync(applied.offloadPath), mode);
			ok(readFileSync(applied.offloadPath, "utf8").includes(NUL), `${mode} retrieval keeps the captured bytes`);
			strictEqual(applied.contextTruncated, true, mode);
			assertByteAccounting(result);
			if (mode === "metadata-only") {
				strictEqual(context.includes("ERROR"), false);
			} else {
				ok(context.includes("🙂"), mode);
			}
		}
	});

	it("bounds live updates under the selected policy and writes only the terminal offload", async () => {
		const stateDir = useStateDir();
		const scratch = join(stateDir, "scratch", "live");
		let artifactSeenDuringUpdate = false;
		const updates: ToolResult[] = [];
		const script =
			"process.stdout.write('api_key=abcdefghijklmnop\\n' + 'noise\\n'.repeat(5000));" +
			"setTimeout(() => process.stdout.write('ERROR terminal\\n'), 150)";
		const result = await invokeBash(
			{ command: `node -e ${JSON.stringify(script)}`, output_policy: "summary" },
			{
				sessionId: "live",
				toolCallId: "call",
				onUpdate: (update) => {
					updates.push(update);
					if (existsSync(scratch)) artifactSeenDuringUpdate = true;
				},
			},
		);

		ok(updates.length >= 2, `expected cumulative live updates, got ${updates.length}`);
		strictEqual(artifactSeenDuringUpdate, false);
		for (const update of updates) {
			ok(Buffer.byteLength(resultText(update), "utf8") <= 16 * 1024);
			strictEqual(resultText(update).includes("abcdefghijklmnop"), false);
		}
		strictEqual(readdirSync(scratch).length, 1, "only the terminal shaper writes the retained artifact");
		strictEqual(disposition(result).applications, 1);
	});
});
