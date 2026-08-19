import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clampTimeoutMs, parseNullDelimitedEnv, runBashCommand } from "../../src/core/bash-exec.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { assessFinishContract } from "../../src/domains/safety/finish-contract.js";
import {
	createFinishContractRegistration,
	HIGH_RIGOR_REVALIDATION_MESSAGE,
} from "../../src/domains/safety/finish-contract-registration.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { bashTool } from "../../src/tools/bash.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { buildFdArgs, findTool } from "../../src/tools/find.js";
import { grepTool } from "../../src/tools/grep.js";
import { fdIgnoreArgs, rgIgnoreArgs } from "../../src/tools/ignore-policy.js";
import { DEFAULT_READ_MAX_BYTES, readTool } from "../../src/tools/read.js";
import { createRegistry } from "../../src/tools/registry.js";
import { DEFAULT_MAX_BYTES, truncateHead, truncateTail } from "../../src/tools/truncate.js";
import { verifyTool } from "../../src/tools/verify/index.js";
import { extractWebFetchContent } from "../../src/tools/web-fetch.js";

const TIMEOUT_MAX = 2_147_483_647;

describe("contracts/tool-hardening clampTimeoutMs", () => {
	it("passes normal timeouts through, floored", () => {
		strictEqual(clampTimeoutMs(300_000), 300_000);
		strictEqual(clampTimeoutMs(1500.9), 1500);
	});
	it("caps huge and non-finite timeouts at the max schedulable delay", () => {
		// Before the fix these overflowed setTimeout and were silently clamped to 1ms.
		strictEqual(clampTimeoutMs(3_000_000_000), TIMEOUT_MAX);
		strictEqual(clampTimeoutMs(Number.POSITIVE_INFINITY), TIMEOUT_MAX);
	});
	it("disables the timeout for zero, negative, or NaN input", () => {
		strictEqual(clampTimeoutMs(0), 0);
		strictEqual(clampTimeoutMs(-5), 0);
		strictEqual(clampTimeoutMs(Number.NaN), 0);
	});
});

describe("contracts/tool-hardening truncate primitives", () => {
	it("truncateTail keeps the LAST lines, not the first", () => {
		const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
		const result = truncateTail(content, { maxLines: 3, maxBytes: 64 * 1024 });
		ok(result.truncated);
		strictEqual(result.truncatedBy, "lines");
		strictEqual(result.content, "line 8\nline 9\nline 10");
		strictEqual(result.totalLines, 10);
	});

	it("truncateTail keeps the end of an oversized final line (partial edge case)", () => {
		const content = `${"x".repeat(100)}TAIL`;
		const result = truncateTail(content, { maxLines: 2000, maxBytes: 8 });
		ok(result.truncated);
		ok(result.lastLinePartial);
		strictEqual(result.content, "xxxxTAIL");
	});

	it("splitLinesForCounting-backed counts do not over-report newline-terminated files", () => {
		// A 3-line, newline-terminated file must count as 3 lines, not 4.
		const result = truncateHead("a\nb\nc\n", { maxLines: 2000, maxBytes: 64 * 1024 });
		strictEqual(result.totalLines, 3);
	});

	it("keeps Clio's 16 KiB observation cap while Pi owns UTF-8-safe truncation", () => {
		strictEqual(DEFAULT_MAX_BYTES, 16 * 1024);
		const exact = truncateHead("x".repeat(DEFAULT_MAX_BYTES));
		strictEqual(exact.truncated, false);
		const over = truncateTail(`${"x".repeat(DEFAULT_MAX_BYTES)}😀END`);
		strictEqual(over.truncated, true);
		strictEqual(over.outputBytes <= DEFAULT_MAX_BYTES, true);
		strictEqual(over.content.endsWith("😀END"), true);
	});
});

describe("contracts/tool-hardening bash tail-biased non-destructive output", () => {
	const roots: string[] = [];

	afterEach(() => {
		while (roots.length > 0) {
			const dir = roots.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("surfaces the TAIL (FAIL) of a >1MB output and spills the full output to an offload file", async () => {
		const sessionId = `hardening-${process.pid}`;
		const toolCallId = `bash-tail-${Date.now()}`;
		// ~1.049MB of "A\n" then a trailing "FAIL" with no newline: the actionable
		// tail lives past clio's old 1MB head-truncation point.
		const result = await bashTool.run({ command: "yes A | head -c 1049000; printf FAIL" }, { sessionId, toolCallId });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.output.includes("FAIL"), "model-facing output must include the trailing FAIL");
		ok(result.output.includes("tail-truncated"), "output should announce tail truncation");

		const resultSize = (result.details as { resultSize?: { offloadPath?: string; bytes?: number } } | undefined)
			?.resultSize;
		ok(resultSize?.offloadPath, "full output should be offloaded to a scratch file");
		const offloadPath = resultSize?.offloadPath as string;
		roots.push(offloadPath);
		const spilled = readFileSync(offloadPath, "utf8");
		ok(spilled.includes("FAIL"), "offload file must contain the full output including FAIL");
		ok(spilled.length > 1_000_000, "offload file must hold the full >1MB output, not a 1MB head slice");
	});

	it("returns small output verbatim with no truncation or offload", async () => {
		const result = await bashTool.run({ command: "printf 'hello\\nworld\\n'" }, undefined);
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		strictEqual(result.output.trim(), "hello\nworld");
		strictEqual((result.details as { resultSize?: unknown } | undefined)?.resultSize, undefined);
	});

	it("streams cumulative snapshots through pi before the terminal result", async () => {
		const updates: string[] = [];
		const result = await bashTool.run(
			{ command: "printf first; sleep 0.15; printf '\\nsecond\\n'" },
			{
				onUpdate: (partial) => {
					if (partial.kind === "ok") updates.push(partial.output);
				},
			},
		);

		strictEqual(result.kind, "ok");
		ok(updates.length >= 2, `expected an initial/live/final snapshot sequence, got ${updates.length}`);
		strictEqual(updates[0], "", "pi receives an empty initial snapshot so the UI can show a running body");
		ok(
			updates.some((snapshot) => snapshot.includes("first")),
			JSON.stringify(updates),
		);
		ok(updates.at(-1)?.includes("first\nsecond"), JSON.stringify(updates));
	});
});

describe("contracts/tool-hardening bash cwd pinning (W5)", () => {
	it("rejects an absolute cwd outside the workspace in the tool itself", async () => {
		// Defense in depth: the safety net blocks this at admission, but a direct
		// tool invocation must not reach spawn with an escaping cwd either.
		const result = await bashTool.run({ command: "pwd", cwd: "/etc" }, undefined);
		strictEqual(result.kind, "error");
		if (result.kind !== "error") return;
		ok(result.message.includes("escapes workspace root"), result.message);
	});

	it("rejects a relative cwd that resolves outside the workspace", async () => {
		const result = await bashTool.run({ command: "pwd", cwd: ".." }, undefined);
		strictEqual(result.kind, "error");
		if (result.kind !== "error") return;
		ok(result.message.includes("escapes workspace root"), result.message);
	});

	it("resolves a relative in-workspace cwd and defaults to the workspace root", async () => {
		const relative = await bashTool.run({ command: "pwd", cwd: "tests" }, undefined);
		strictEqual(relative.kind, "ok");
		if (relative.kind === "ok") strictEqual(relative.output.trim(), join(process.cwd(), "tests"));

		const defaulted = await bashTool.run({ command: "pwd" }, undefined);
		strictEqual(defaulted.kind, "ok");
		if (defaulted.kind === "ok") strictEqual(defaulted.output.trim(), process.cwd());
	});
});

describe("contracts/tool-hardening bash spawn env and shell freshness (W5)", () => {
	afterEach(() => {
		Reflect.deleteProperty(process.env, "CLIO_CODER_INTERACTIVE");
		Reflect.deleteProperty(process.env, "CLIO_CODER_TEST_BLEED");
	});

	it("strips the CLIO control keys from the child environment", async () => {
		process.env.CLIO_CODER_INTERACTIVE = "1";
		const result = await runBashCommand("printenv CLIO_CODER_INTERACTIVE || printf unset");
		strictEqual(result.exitCode, 0);
		strictEqual(result.stdout, "unset");
	});

	it("gives every call a fresh shell: no state bleed between commands", async () => {
		const first = await runBashCommand("export CLIO_CODER_TEST_BLEED=leaked; cd /tmp; umask 077");
		strictEqual(first.exitCode, 0);
		const second = await runBashCommand('printenv CLIO_CODER_TEST_BLEED || printf clean; printf ":"; pwd');
		strictEqual(second.exitCode, 0);
		ok(second.stdout.startsWith("clean:"), `shell state must not bleed: ${second.stdout}`);
		ok(!second.stdout.includes("/tmp"), `cwd must reset per call: ${second.stdout}`);
	});

	it("runs commands without a TTY on stdout", async () => {
		const result = await runBashCommand("if [ -t 1 ]; then echo tty; else echo notty; fi");
		strictEqual(result.stdout.trim(), "notty");
	});

	it("parseNullDelimitedEnv parses NUL-separated entries and rejects captures without PATH", () => {
		const parsed = parseNullDelimitedEnv("PATH=/usr/bin:/bin\0HOME=/home/u\0MULTI=line one\nline two\0");
		ok(parsed !== null);
		strictEqual(parsed?.PATH, "/usr/bin:/bin");
		strictEqual(parsed?.MULTI, "line one\nline two");
		strictEqual(parseNullDelimitedEnv("HOME=/home/u\0"), null);
		strictEqual(parseNullDelimitedEnv(""), null);
	});
});

describe("contracts/tool-hardening bash kill and cap semantics (W5)", () => {
	it("timeout kills the whole process group, including a backgrounded grandchild", async () => {
		const startedAt = Date.now();
		const result = await runBashCommand("sleep 30 & echo child:$!; wait", { timeoutMs: 400 });
		const elapsed = Date.now() - startedAt;
		ok(result.timedOut, "must report the timeout");
		ok(elapsed < 10_000, `must not wait for the 30s grandchild (took ${elapsed}ms)`);
		const pidMatch = /child:(\d+)/.exec(result.stdout);
		ok(pidMatch?.[1], `stdout must carry the grandchild pid: ${result.stdout}`);
		const pid = Number(pidMatch?.[1]);
		// SIGTERM delivery is asynchronous; give the group kill a moment.
		let dead = false;
		for (let attempt = 0; attempt < 30; attempt += 1) {
			try {
				process.kill(pid, 0);
				await new Promise((resolve) => setTimeout(resolve, 100));
			} catch {
				dead = true;
				break;
			}
		}
		ok(dead, `grandchild ${pid} must be dead after the group kill`);
	});

	it("abort signal stops the command and reports aborted", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 150);
		const startedAt = Date.now();
		const result = await runBashCommand("sleep 30", { signal: controller.signal });
		ok(result.aborted, "must report aborted");
		ok(Date.now() - startedAt < 10_000, "abort must not wait out the command");
	});

	it("kills a runaway command at the 16MB hard output cap", async () => {
		const startedAt = Date.now();
		const result = await runBashCommand("yes AAAAAAAAAAAAAAAA", { timeoutMs: 60_000 });
		ok(result.outputCapped, "must report the output cap");
		ok(!result.timedOut, "the cap, not the timeout, must stop the command");
		ok(Date.now() - startedAt < 30_000, "the kill must be prompt");
		const bytes = Buffer.byteLength(result.stdout, "utf8");
		ok(bytes <= 16 * 1024 * 1024, `captured output must respect the cap (${bytes} bytes)`);
	});
});

describe("contracts/tool-hardening grep pure-Node fallback", () => {
	let scratch: string;
	let originalPath: string | undefined;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-grep-"));
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "a.ts"), "export function findMe() {}\nconst other = 1;\n", "utf8");
		writeFileSync(join(scratch, "src", "b.md"), "# doc\nfindMe is documented here\n", "utf8");
		// Force rg-resolution failure by pointing PATH at an rg-free directory.
		originalPath = process.env.PATH;
		process.env.PATH = join(scratch, "empty-bin");
		mkdirSync(process.env.PATH, { recursive: true });
	});
	afterEach(() => {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		rmSync(scratch, { recursive: true, force: true });
	});

	it("returns matches in path:line: format when ripgrep is unavailable", async () => {
		const result = await grepTool.run({ pattern: "findMe", path: scratch }, undefined);
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.output.includes("src/a.ts:1: export function findMe() {}"), result.output);
		ok(result.output.includes("src/b.md:2: findMe is documented here"), result.output);
	});

	it("honors the glob filter in the fallback", async () => {
		const result = await grepTool.run({ pattern: "findMe", path: scratch, glob: "*.ts" }, undefined);
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.output.includes("src/a.ts:1:"), result.output);
		ok(!result.output.includes("b.md"), "glob *.ts must exclude the markdown match");
	});

	it("honors ignore_case and literal in the fallback", async () => {
		const insensitive = await grepTool.run({ pattern: "FINDME", path: scratch, ignore_case: true }, undefined);
		strictEqual(insensitive.kind, "ok");
		if (insensitive.kind === "ok") ok(insensitive.output.includes("src/a.ts:1:"), insensitive.output);

		const literal = await grepTool.run({ pattern: "findMe()", path: scratch, literal: true }, undefined);
		strictEqual(literal.kind, "ok");
		if (literal.kind === "ok") ok(literal.output.includes("src/a.ts:1:"), literal.output);
	});

	it("hides generated dirs by default and reveals them with include_ignored", async () => {
		mkdirSync(join(scratch, "dist"), { recursive: true });
		writeFileSync(join(scratch, "dist", "bundle.js"), "var findMe = 42;\n", "utf8");

		const hidden = await grepTool.run({ pattern: "findMe", path: scratch }, undefined);
		strictEqual(hidden.kind, "ok");
		if (hidden.kind !== "ok") return;
		ok(!hidden.output.includes("dist/bundle.js"), `generated dist must be excluded by default: ${hidden.output}`);

		const revealed = await grepTool.run({ pattern: "findMe", path: scratch, include_ignored: true }, undefined);
		strictEqual(revealed.kind, "ok");
		if (revealed.kind !== "ok") return;
		ok(revealed.output.includes("dist/bundle.js:1:"), `include_ignored must reveal dist: ${revealed.output}`);
	});
});

describe("contracts/tool-hardening find/grep gitignore visibility", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-fd-"));
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("find passes --no-require-git only outside a git repo", () => {
		const outside = buildFdArgs("*.ts", scratch, 1000, false);
		ok(outside.includes("--no-require-git"), "outside a repo fd must honor ignore files via --no-require-git");

		mkdirSync(join(scratch, ".git"), { recursive: true });
		const inside = buildFdArgs("*.ts", scratch, 1000, false);
		ok(!inside.includes("--no-require-git"), "inside a repo fd must use git-aware behavior (nested-repo boundaries)");
	});

	it("grep and find answer tree visibility from one shared ignore policy", () => {
		// Layer 1 (clio-internal) and layer 3 (generated dirs) are force-excluded.
		const rg = rgIgnoreArgs(scratch, false);
		for (const excluded of ["!**/.clio-coder/**", "!**/.git/**", "!**/node_modules/**", "!**/dist/**"]) {
			ok(rg.includes(excluded), `rg must exclude ${excluded}: ${rg.join(" ")}`);
		}

		// include_ignored disables gitignore + generated layers; layer 1 stands.
		const revealed = rgIgnoreArgs(scratch, true);
		ok(revealed.includes("--no-ignore"));
		ok(revealed.includes("!**/.clio-coder/**"));
		ok(!revealed.includes("!**/dist/**"), "include_ignored must lift the generated-dirs layer");

		// Targeting an excluded dir directly must not suppress it.
		const targeted = rgIgnoreArgs(join(scratch, "node_modules", "pkg"), false);
		ok(!targeted.includes("!**/node_modules/**"), "explicit node_modules target must stay visible");
		ok(targeted.includes("!**/.clio-coder/**"));

		// fd mirrors the same exclusions through its own argv dialect.
		const fd = fdIgnoreArgs(scratch, false);
		ok(fd.includes("--exclude"));
		for (const dir of [".clio-coder", "node_modules", "dist"]) {
			ok(fd.includes(dir), `fd must exclude ${dir}: ${fd.join(" ")}`);
		}
	});
});

describe("contracts/tool-hardening find dir filtering + read line count", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-find-"));
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("find skips node_modules and .git like grep", async () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		mkdirSync(join(scratch, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(scratch, "src", "a.ts"), "x\n", "utf8");
		writeFileSync(join(scratch, "node_modules", "pkg", "b.ts"), "y\n", "utf8");

		const result = await findTool.run({ pattern: "**/*.ts", path: scratch });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.output.includes("src/a.ts"), result.output);
		ok(!result.output.includes("node_modules"), `must not walk node_modules: ${result.output}`);
	});

	it("read does not over-report remaining lines on a newline-terminated file", async () => {
		const file = join(scratch, "three.txt");
		writeFileSync(file, "a\nb\nc\n", "utf8");
		const result = await readTool.run({ path: file, limit: 2 }, undefined);
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		// Only line "c" remains; the envelope notice must count 3 total lines, not
		// 4, and continue at offset 3.
		ok(result.output.includes("read: 2/3 lines shown"), result.output);
		ok(result.output.includes("next: offset=3"), result.output);
	});
});

describe("contracts/tool-hardening read large-file ergonomics", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-read-"));
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("tail=N reads the last N lines and points back to earlier lines", async () => {
		const file = join(scratch, "log.txt");
		writeFileSync(file, `${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")}\n`, "utf8");
		const result = await readTool.run({ path: file, tail: 3 }, undefined);
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.output.includes("line 18\nline 19\nline 20"), result.output);
		ok(!result.output.includes("line 17"), "tail=3 must not include earlier lines");
		ok(result.output.includes("read: 3/20 lines shown"), result.output);
		ok(result.output.includes("next: offset=15 limit=3"), result.output);
	});

	it("reads a >16KB file (under the 50KB cap) in a single call without truncating", async () => {
		const file = join(scratch, "medium.ts");
		// ~30KB, comfortably above the old 16KB cap and below the 50KB cap.
		const body = `${Array.from({ length: 600 }, (_, i) => `const x${i} = ${i}; // padding padding padding`).join("\n")}\n`;
		ok(Buffer.byteLength(body, "utf8") > 16 * 1024 && Buffer.byteLength(body, "utf8") < DEFAULT_READ_MAX_BYTES);
		writeFileSync(file, body, "utf8");
		const result = await readTool.run({ path: file }, undefined);
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.output.includes("const x0 ="), "first line present");
		ok(result.output.includes("const x599 ="), "last line present in one call");
		ok(!result.output.includes("lines shown"), `must not truncate under the cap: ${result.output.slice(-200)}`);
	});

	it("registry result-shaping does not re-truncate a full read below the read cap", async () => {
		const registry = createRegistry({
			safety: {
				classify: () => ({ actionClass: "read", reasons: [] }),
				evaluate: () => ({ kind: "allow", classification: { actionClass: "read", reasons: [] } }),
				observeLoop: () => ({ looping: false, key: "t", count: 0 }),
				scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
				isSubset: () => true,
				audit: { recordCount: () => 0 },
			},
		});
		registerAllTools(registry);
		const file = join(scratch, "big.ts");
		const body = `${Array.from({ length: 600 }, (_, i) => `const y${i} = ${i}; // padding padding padding`).join("\n")}\n`;
		writeFileSync(file, body, "utf8");
		const verdict = await registry.invoke({ tool: ToolNames.Read, args: { path: file } });
		strictEqual(verdict.kind, "ok");
		if (verdict.kind !== "ok" || verdict.result.kind !== "ok") return;
		ok(verdict.result.output.includes("const y599 ="), "full read must survive result-shaping");
		ok(!verdict.result.output.includes("tool result truncated"), "must not be offloaded/truncated by the re-shaper");
	});
});

describe("contracts/tool-hardening web_fetch extraction", () => {
	it("does not throw on out-of-range numeric entities and keeps the escape text", () => {
		const html = `<!doctype html><html><head><title>t</title></head><body><p>bad &#1114112; and &#xFFFFFFFF; entity</p></body></html>`;
		const extracted = extractWebFetchContent(html, "text/html", "https://example.com/", "auto");
		strictEqual(extracted.format, "markdown");
		ok(extracted.content.includes("&#1114112;"));
		ok(extracted.content.includes("entity"));
	});

	it("preserves newlines and $-patterns inside <pre> code blocks", () => {
		const html = `<!doctype html><html><body><pre><code>line1\nline2 $&amp; $1 $\`</code></pre></body></html>`;
		const extracted = extractWebFetchContent(html, "text/html", "https://example.com/", "auto");
		ok(extracted.content.includes("line1\nline2"), "newline preserved inside code fence");
		ok(extracted.content.includes("$& $1 $`"), "literal $-patterns preserved, entity decoded");
	});
});

describe("contracts/tool-hardening verify frontend html structure", () => {
	let scratch: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "clio-vf-"));
		mkdirSync(scratch, { recursive: true });
		process.chdir(scratch);
	});
	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(scratch, { recursive: true, force: true });
	});

	async function structureCheck(html: string): Promise<{ status: string; message: string }> {
		writeFileSync(join(scratch, "page.html"), html, "utf8");
		const result = await verifyTool.run({ check: "frontend", path: "page.html", browser: "off" }, undefined);
		const details = result.details as { checks?: Array<{ name: string; status: string; message: string }> } | undefined;
		const check = details?.checks?.find((c) => c.name === "html structure");
		return { status: check?.status ?? "missing", message: check?.message ?? "" };
	}

	it("does not treat tags inside comments as real elements", async () => {
		const { status } = await structureCheck(
			`<!doctype html><html><body><!-- <section> commented out --><p>ok</p></body></html>`,
		);
		strictEqual(status, "pass");
	});

	it("accepts HTML5 elements with omitted optional end tags", async () => {
		const { status } = await structureCheck(
			`<!doctype html><html><body><ul><li>a<li>b</ul><table><tr><td>x<td>y</tr></table></body></html>`,
		);
		strictEqual(status, "pass");
	});

	it("still fails on a genuine mismatched non-optional tag", async () => {
		const { status } = await structureCheck(`<!doctype html><html><body><div><span></div></body></html>`);
		strictEqual(status, "fail");
	});
});

describe("contracts/tool-hardening finish-contract action-scoped trigger", () => {
	// Session-entry builders mirroring the production turn-id model: every entry
	// carries its own turnId, and the assistant turnId at turn_end (a final id
	// not present among the receipts) makes the window everything after the last
	// user prompt. Verified against the real assessFinishContract.
	const user = (text: string): unknown => ({ kind: "message", role: "user", turnId: "u1", payload: { text } });
	const call = (name: string, args: Record<string, unknown>, id: string): unknown => ({
		kind: "message",
		role: "tool_call",
		turnId: `c-${id}`,
		payload: { name, toolCallId: id, args },
	});
	const okResult = (name: string, id: string, details?: Record<string, unknown>): unknown => ({
		kind: "message",
		role: "tool_result",
		turnId: `r-${id}`,
		payload: {
			toolName: name,
			toolCallId: id,
			isError: false,
			result: details === undefined ? { kind: "ok" } : { details },
		},
	});
	const errorResult = (name: string, id: string): unknown => ({
		kind: "message",
		role: "tool_result",
		turnId: `r-${id}`,
		payload: { toolName: name, toolCallId: id, isError: true, result: { details: { kind: "error" } } },
	});
	const protectedArtifact = (path: string): unknown => ({
		kind: "protectedArtifact",
		action: "protect",
		turnId: "pa1",
		artifact: { path },
	});
	const dispatchResult = (id: string): unknown => ({
		kind: "message",
		role: "tool_result",
		turnId: `r-${id}`,
		payload: {
			toolName: "dispatch",
			toolCallId: id,
			isError: false,
			result: { details: { exitCode: 0, runId: "run-1", agentId: "coder" } },
		},
	});
	const editPair = (path = "src/app.ts", id = "e1"): unknown[] => [call("edit", { path }, id), okResult("edit", id)];

	const assess = (userText: string, assistantText: string, entries: unknown[]) =>
		assessFinishContract({
			assistantText,
			sessionEntries: [user(userText), ...entries],
			assistantTurnId: "assistant-final",
		});

	it("engages when a turn mutated a file with no evidence and no limitation", () => {
		const assessment = assess("edit the parser", "Done.", editPair("src/parser.ts"));
		strictEqual(assessment.kind, "engage");
		if (assessment.kind === "engage") {
			strictEqual(assessment.reason, "unvalidated_mutation");
			strictEqual(assessment.mutatedPaths[0], "src/parser.ts");
		}
	});

	it("clears a mutation validated by any receipt-based evidence source", () => {
		const validated: Array<[string, unknown[]]> = [
			["npm test", [...editPair(), call("bash", { command: "npm test" }, "v"), okResult("bash", "v", { exitCode: 0 })]],
			[
				"verify script",
				[...editPair(), call("verify", { check: "test:contracts" }, "v"), okResult("verify", "v", { exitCode: 0 })],
			],
			[
				"verify frontend",
				[...editPair(), call("verify", { check: "frontend", path: "page.html" }, "v"), okResult("verify", "v")],
			],
			["dispatch", [...editPair(), call("dispatch", { agent: "coder", task: "do" }, "v"), dispatchResult("v")]],
			["protected-artifact", [...editPair(), protectedArtifact("report.md")]],
		];
		for (const [label, entries] of validated) {
			const assessment = assess("make the change", "Done.", entries);
			strictEqual(assessment.kind, "ok", `${label} must clear the contract`);
			if (assessment.kind === "ok") strictEqual(assessment.reason, "validation_evidence", label);
		}
	});

	it("clears a mutation when the turn records an explicit limitation", () => {
		const assessment = assess(
			"edit it",
			"Updated the parser. Tests: not run — blocked by a missing fixture.",
			editPair(),
		);
		strictEqual(assessment.kind, "ok");
		if (assessment.kind === "ok") strictEqual(assessment.reason, "explicit_limitation");
	});

	it("never fires on a read-only turn (read/grep/find/ls/git status)", () => {
		const readOnly: Array<[string, unknown[]]> = [
			["read", [call("read", { path: "src/x.ts" }, "t"), okResult("read", "t")]],
			["grep", [call("grep", { pattern: "x" }, "t"), okResult("grep", "t")]],
			["find", [call("find", { pattern: "*.ts" }, "t"), okResult("find", "t")]],
			["ls", [call("ls", { path: "src" }, "t"), okResult("ls", "t")]],
			["git status", [call("git", { op: "status" }, "t"), okResult("git", "t", { exitCode: 0 })]],
		];
		for (const [label, entries] of readOnly) {
			const assessment = assess("show me the state", "Done. Here is the current state.", entries);
			strictEqual(assessment.kind, "ok", label);
			if (assessment.kind === "ok") strictEqual(assessment.reason, "no_mutation", label);
		}
	});

	it("never fires on an execution-only turn — FC-1 (bash sleep)", () => {
		const assessment = assess("run sleep 3 && echo finished", "The command completed.", [
			call("bash", { command: "sleep 3 && echo finished" }, "b"),
			okResult("bash", "b", { exitCode: 0 }),
		]);
		strictEqual(assessment.kind, "ok");
		if (assessment.kind === "ok") strictEqual(assessment.reason, "no_mutation");
	});

	it("never fires on a retrieval turn — FC-1 (web_fetch, read-and-show)", () => {
		const webFetch = assess("fetch https://x/api and show me the JSON", "Here is the JSON body.", [
			call("web_fetch", { url: "https://x/api" }, "w"),
			okResult("web_fetch", "w"),
		]);
		strictEqual(webFetch.kind, "ok");
		if (webFetch.kind === "ok") strictEqual(webFetch.reason, "no_mutation");

		const readShow = assess("read src/app.ts and show me the exports", "Here are the exports.", [
			call("read", { path: "src/app.ts" }, "r"),
			okResult("read", "r"),
		]);
		strictEqual(readShow.kind, "ok");
		if (readShow.kind === "ok") strictEqual(readShow.reason, "no_mutation");
	});

	it("engages a question-shaped work request that mutated a file — FC-2", () => {
		for (const prompt of [
			"Can you make the parser work?",
			"Can you update the parser?",
			"Could you refactor the auth module?",
			"Will you wire up the logger?",
		]) {
			const assessment = assess(prompt, "Done. Updated the parser.", editPair());
			strictEqual(assessment.kind, "engage", prompt);
		}
	});

	it("stays silent on the same question-shaped prompt when nothing mutated — FC-2 control", () => {
		const assessment = assess(
			"Can you make the parser work?",
			"Here is how the parser works: it tokenizes, then builds the AST.",
			[call("read", { path: "src/parser.ts" }, "r"), okResult("read", "r")],
		);
		strictEqual(assessment.kind, "ok");
		if (assessment.kind === "ok") strictEqual(assessment.reason, "no_mutation");
	});

	it("engages on a bash in-place / redirect mutation with no evidence", () => {
		const sed = assess("fix the import", "Done.", [
			call("bash", { command: "sed -i 's/a/b/' src/x.ts" }, "s"),
			okResult("bash", "s", { exitCode: 0 }),
		]);
		strictEqual(sed.kind, "engage");
		if (sed.kind === "engage") strictEqual(sed.mutatedPaths[0], "src/x.ts");

		const redirect = assess("append the flag", "Done.", [
			call("bash", { command: "echo FLAG=1 > src/y.ts" }, "r"),
			okResult("bash", "r", { exitCode: 0 }),
		]);
		strictEqual(redirect.kind, "engage");
		if (redirect.kind === "engage") strictEqual(redirect.mutatedPaths[0], "src/y.ts");
	});

	it("does not treat a failed mutation or failed validation as settling the contract", () => {
		// The edit errored: nothing actually changed, so there is nothing to gate.
		const failedEdit = assess("edit it", "Done.", [call("edit", { path: "src/x.ts" }, "e"), errorResult("edit", "e")]);
		strictEqual(failedEdit.kind, "ok");
		if (failedEdit.kind === "ok") strictEqual(failedEdit.reason, "no_mutation");

		// The edit succeeded but the validation command failed: still unvalidated.
		const failedValidation = assess("edit it", "Done. Tests pass.", [
			...editPair(),
			call("bash", { command: "npm test" }, "v"),
			errorResult("bash", "v"),
		]);
		strictEqual(failedValidation.kind, "engage");
	});

	it("gates by rigor: normal advises softly, high withholds completion", () => {
		const entries = [user("edit it"), ...editPair()];
		const turnEnd = (): MiddlewareHookInput => ({
			hook: "turn_end",
			turnId: "assistant-final",
			text: "Done.",
			metadata: { stopReason: "stop" },
		});

		const normal = createFinishContractRegistration({
			readSessionEntries: () => entries,
			resolveRigor: () => "normal",
		}).evaluate(turnEnd());
		strictEqual(normal.length, 1);
		ok(normal[0]?.kind === "inject_reminder" && normal[0].severity === "warn");
		ok(!normal.some((effect) => effect.kind === "request_continuation"));

		const high = createFinishContractRegistration({
			readSessionEntries: () => entries,
			resolveRigor: () => "high",
		}).evaluate(turnEnd());
		strictEqual(high.length, 2);
		const continuation = high.find((effect) => effect.kind === "request_continuation");
		ok(continuation?.kind === "request_continuation" && continuation.message === HIGH_RIGOR_REVALIDATION_MESSAGE);
		ok(high.some((effect) => effect.kind === "inject_reminder" && effect.severity === "warn"));
	});
});

describe("contracts/tool-hardening oversized search pattern validation", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-huge-pattern-"));
		writeFileSync(join(scratch, "a.txt"), "hello world\n", "utf8");
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	// A single argv entry over MAX_ARG_STRLEN (128 KiB on Linux) makes spawn throw
	// a raw `spawn E2BIG` before rg/fd ever runs. BUG-008 (grep) and BUG-009 (find)
	// share this root cause: the pattern is the one unbounded argument, so both
	// searchers must reject an oversized pattern with a bounded validation error
	// before spawning — never throw, never leak the raw platform fault.
	const huge = "x".repeat(256_000);

	it("grep rejects an oversized pattern before spawn (BUG-008)", async () => {
		const result = await grepTool.run({ pattern: huge, path: scratch }, undefined);
		strictEqual(result.kind, "error");
		if (result.kind !== "error") return;
		ok(result.message.startsWith("grep:"), `must be a grep-scoped tool error: ${result.message}`);
		ok(/too large/i.test(result.message), `must explain the pattern is too large: ${result.message}`);
		ok(!/E2BIG/i.test(result.message), `must not leak the raw spawn error: ${result.message}`);
		ok(result.message.length < 500, `validation error must stay bounded: ${result.message.length} bytes`);
	});

	it("find rejects an oversized pattern before spawn (BUG-009)", async () => {
		const result = await findTool.run({ pattern: huge, path: scratch }, undefined);
		strictEqual(result.kind, "error");
		if (result.kind !== "error") return;
		ok(result.message.startsWith("find:"), `must be a find-scoped tool error: ${result.message}`);
		ok(/too large/i.test(result.message), `must explain the pattern is too large: ${result.message}`);
		ok(!/E2BIG/i.test(result.message), `must not leak the raw spawn error: ${result.message}`);
		ok(result.message.length < 500, `validation error must stay bounded: ${result.message.length} bytes`);
	});

	it("both searchers still accept a normal-sized pattern", async () => {
		const grepped = await grepTool.run({ pattern: "hello", path: scratch }, undefined);
		strictEqual(grepped.kind, "ok");
		const found = await findTool.run({ pattern: "*.txt", path: scratch }, undefined);
		strictEqual(found.kind, "ok");
	});
});
