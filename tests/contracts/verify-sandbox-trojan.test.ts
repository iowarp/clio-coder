import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import type { YoloScriptSandboxState } from "../../src/core/sandbox/main-session.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { clioConfigDir } from "../../src/core/xdg.js";
import type { ClassifierCall } from "../../src/domains/safety/action-classifier.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { bashTool } from "../../src/tools/bash.js";
import { createRegistry } from "../../src/tools/registry.js";
import { verifyTool } from "../../src/tools/verify/index.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

/**
 * A project whose test helper is a trojan: when `npm test` runs it, it marks
 * the workspace (proof it ran), copies the workspace's .env to a scratch file,
 * and deletes a directory in Clio's config, which the main-session sandbox
 * keeps read-only. Run contained, the mark lands and the rest fails.
 */
function trojanWorkspace(victim: string, exfil: string): string {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clio-verify-trojan-")));
	writeFileSync(join(cwd, ".env"), "PROBE_SECRET_TOKEN=trojan-secret\n");
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "trojan", scripts: { test: "node unit.test.js" } }));
	writeFileSync(
		join(cwd, "setup.js"),
		[
			'const fs = require("node:fs");',
			'fs.writeFileSync("ran.txt", "ran\\n");',
			`try { fs.writeFileSync(${JSON.stringify(exfil)}, fs.readFileSync(".env", "utf8")); } catch {}`,
			`try { fs.rmSync(${JSON.stringify(victim)}, { recursive: true, force: true }); } catch {}`,
			"",
		].join("\n"),
	);
	// Plain node: a nested `node --test` would see this runner's NODE_TEST_CONTEXT through bash and skip its files.
	writeFileSync(join(cwd, "unit.test.js"), 'require("./setup.js");\nconsole.log("ok");\n');
	return cwd;
}

function bwrapOrSkip(t: TestContext): boolean {
	const availability = sandboxAvailability();
	if (availability.available && availability.backend === "bwrap") return true;
	t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
	return false;
}

async function runTrojan(
	t: TestContext,
	call: ClassifierCall,
	autonomy: "default" | "yolo",
	scriptSandbox?: YoloScriptSandboxState,
): Promise<void> {
	const env = await isolateClioEnv("clio-verify-trojan-home-");
	t.after(() => env.restore());
	const victim = join(clioConfigDir(), "victim");
	mkdirSync(victim, { recursive: true });
	writeFileSync(join(victim, "keep.txt"), "keep\n");
	const exfil = join(realpathSync(mkdtempSync(join(tmpdir(), "clio-verify-exfil-"))), "exfil.txt");
	const cwd = trojanWorkspace(victim, exfil);
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => autonomy,
		scratchRoots: () => [],
		containment: () => ({ sandbox: true, snapshots: false }),
		...(scriptSandbox !== undefined ? { scriptSandbox: () => scriptSandbox } : {}),
	});
	registry.register(bashTool);
	registry.register(verifyTool);
	const verdict = await registry.invoke(call);
	const label = `${autonomy} ${JSON.stringify(call.args)}`;
	strictEqual(verdict.kind, "ok", verdict.kind === "blocked" ? `${label}: ${verdict.reason}` : label);
	strictEqual(existsSync(join(cwd, "ran.txt")), true, `${label}: the trojan never ran`);
	deepStrictEqual(
		{
			victim: existsSync(join(victim, "keep.txt")),
			exfil: existsSync(exfil) ? readFileSync(exfil, "utf8") : "",
		},
		{ victim: true, exfil: "" },
		label,
	);
}

// ob-yolo: verify ran a project's declared checks outside the sandbox bash ran in.
test("a trojan test helper run through verify at default cannot reach outside the sandbox", async (t) => {
	if (!bwrapOrSkip(t)) return;
	await runTrojan(t, { tool: ToolNames.Verify, args: { check: "test" } }, "default");
});

test("a trojan test helper run through bash at default cannot reach outside the sandbox", async (t) => {
	if (!bwrapOrSkip(t)) return;
	await runTrojan(t, { tool: ToolNames.Bash, args: { command: "npm test" } }, "default");
});

// Under yolo, safety.sandbox required contains the test runner, not only a named script file.
test("a trojan test helper run through verify at yolo under safety.sandbox required stays in the sandbox", async (t) => {
	if (!bwrapOrSkip(t)) return;
	await runTrojan(t, { tool: ToolNames.Verify, args: { check: "test" } }, "yolo", "sandboxed");
});

test("a trojan test helper run through bash at yolo under safety.sandbox required stays in the sandbox", async (t) => {
	if (!bwrapOrSkip(t)) return;
	await runTrojan(t, { tool: ToolNames.Bash, args: { command: "npm test" } }, "yolo", "sandboxed");
});
