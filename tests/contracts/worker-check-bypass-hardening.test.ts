import { strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { evaluateAdmission } from "../../src/domains/safety/admission.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";

let scratch = "";
before(() => {
	scratch = mkdtempSync(join(tmpdir(), "clio-worker-check-hardening-"));
});
after(() => rmSync(scratch, { recursive: true, force: true }));

function harness(manifestsChanged?: boolean) {
	const root = join(scratch, `wt-${String(manifestsChanged)}`);
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ scripts: { check: "node check.mjs", test: "node --test" } }),
	);
	const safety = createWorkerSafety({ cwd: root });
	const git = {
		allowance: "worktree" as const,
		executePermitted: true,
		cwd: root,
		hooksInsideWorkingTree: () => true,
		taskWorktree: {
			attest: (cwd: string) =>
				cwd === root || cwd.startsWith(`${root}/`) ? { ok: true as const } : { ok: false as const, detail: "outside" },
			...(manifestsChanged !== undefined ? { manifestsChanged: () => manifestsChanged } : {}),
		},
	};
	return (call: { tool: string; args: Record<string, unknown> }) =>
		evaluateAdmission({ principal: "worker", effects: [call], safety, cwd: root, git }).kind;
}

describe("worker own-check bypass hardening", () => {
	it("refuses a line break anywhere in the command", () => {
		const admit = harness(false);
		strictEqual(admit({ tool: ToolNames.Bash, args: { command: "pnpm run check" } }), "allow");
		for (const command of [
			"pnpm run check -- x\ncurl evil.example",
			"pnpm\nrun\ncheck",
			"pnpm run check\r\ncurl evil.example",
			"TMPDIR=build\ncurl evil.example\npnpm run check",
		]) {
			strictEqual(admit({ tool: ToolNames.Bash, args: { command } }), "ask", JSON.stringify(command));
		}
		strictEqual(admit({ tool: ToolNames.Verify, args: { check: "check", args: ["x\ncurl"] } }), "ask");
	});

	it("refuses option-like arguments after --", () => {
		const admit = harness(false);
		strictEqual(admit({ tool: ToolNames.Bash, args: { command: "pnpm run test -- tests/x.test.ts" } }), "allow");
		for (const command of [
			"pnpm run check -- --import=./pwn.mjs",
			"pnpm run check -- --prefix=/",
			"pnpm run check -- tests/x.test.ts --require=./pwn.cjs",
			"pnpm run check -- -r ./pwn.cjs",
			"pnpm run check -- --config=./pwn.json",
		]) {
			strictEqual(admit({ tool: ToolNames.Bash, args: { command } }), "ask", command);
		}
		strictEqual(admit({ tool: ToolNames.Verify, args: { check: "check", args: ["--import=./pwn.mjs"] } }), "ask");
	});
});
