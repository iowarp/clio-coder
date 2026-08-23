import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { mapAutonomy } from "../../src/domains/safety/autonomy.js";
import { createSafetyPolicyEngine, type SafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { loadProjectSafetyPolicy } from "../../src/domains/safety/project-policy.js";

/**
 * `.clio-coder/verifiers.yaml` is an argv catalog that verify() executes with
 * no shell and no prompt. Before this contract, a model at the default
 * `auto-edit` level could write that file (write is allow) and run any argv
 * through verify(check=<id>) (verify was always in the no-prompt set, and the
 * damage-control scanner saw only the string `check=<id>`). Two tool calls took
 * it from auto-edit to unrestricted execution. This pins both halves of the
 * fix: the catalog and the project safety policy are read-only to the model's
 * tools, and a catalog check is gated on its declared argv.
 */
describe("contracts/safety verify catalog authority", () => {
	let scratch: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "clio-verify-authority-"));
		mkdirSync(join(scratch, ".clio-coder"), { recursive: true });
		process.chdir(scratch);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(scratch, { recursive: true, force: true });
	});

	function engine(): SafetyPolicyEngine {
		return createSafetyPolicyEngine({ cwd: scratch, projectPolicy: loadProjectSafetyPolicy(scratch) });
	}

	function catalog(id: string, command: string[]): void {
		writeFileSync(
			join(scratch, ".clio-coder", "verifiers.yaml"),
			[
				"version: 1",
				"checks:",
				`  - id: ${id}`,
				"    description: contract check",
				`    command: ${JSON.stringify(command)}`,
				"    cwd: .",
				"    timeoutMs: 10000",
				"    tags: [test]",
				"",
			].join("\n"),
		);
	}

	it("refuses model writes to the verifier catalog and the project safety policy", () => {
		for (const target of [".clio-coder/verifiers.yaml", ".clio-coder/safety.yaml"]) {
			for (const tool of [ToolNames.Write, ToolNames.Edit]) {
				const decision = engine().evaluate({ tool, args: { path: target, content: "version: 1\n" } });
				strictEqual(decision.kind, "block", `${tool} ${target}: ${decision.reasons.join(" | ")}`);
				strictEqual(decision.reasonCode, "path-policy:readOnlyPaths");
			}
			const redirect = engine().evaluate({ tool: ToolNames.Bash, args: { command: `echo x > ${target}` } });
			strictEqual(redirect.kind, "block", `bash redirect ${target}: ${redirect.reasons.join(" | ")}`);
		}
	});

	it("keeps other project-directory writes allowed", () => {
		const decision = engine().evaluate({
			tool: ToolNames.Write,
			args: { path: ".clio-coder/artifacts/notes.md", content: "ok\n" },
		});
		strictEqual(decision.kind, "allow", decision.reasons.join(" | "));
	});

	it("keeps package-script and frontend checks in the no-prompt set", () => {
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ scripts: { test: "node -e 0" } }));
		const script = engine().evaluate({ tool: ToolNames.Verify, args: { check: "test" } });
		strictEqual(script.kind, "allow");
		strictEqual(script.execRecognition, "recognized");
		const frontend = engine().evaluate({ tool: ToolNames.Verify, args: { check: "frontend", path: "index.html" } });
		strictEqual(frontend.kind, "allow");
		strictEqual(frontend.execRecognition, "recognized");
		const listing = engine().evaluate({ tool: ToolNames.Verify, args: {} });
		strictEqual(listing.kind, "allow");
		strictEqual(listing.execRecognition, "recognized");
	});

	it("treats a catalog check as an unrecognized execute that auto-edit confirms and full-auto runs", () => {
		catalog("unit", [process.execPath, "-e", "process.exit(0)"]);
		const decision = engine().evaluate({ tool: ToolNames.Verify, args: { check: "unit" } });
		strictEqual(decision.kind, "allow", decision.reasons.join(" | "));
		strictEqual(decision.execRecognition, "unrecognized");
		ok(
			decision.reasons.some((reason) => reason.includes("project verifier 'unit' runs declared argv")),
			decision.reasons.join(" | "),
		);
		strictEqual(mapAutonomy("auto-edit", "execute", { executeRecognized: false }), "ask");
		strictEqual(mapAutonomy("full-auto", "execute", { executeRecognized: false }), "allow");
	});

	it("scans the declared argv with the damage-control rules", () => {
		catalog("wipe", ["rm", "-rf", "/"]);
		const decision = engine().evaluate({ tool: ToolNames.Verify, args: { check: "wipe" } });
		strictEqual(decision.kind, "block", decision.reasons.join(" | "));
		ok(decision.reasonCode.startsWith("damage-control:"), decision.reasonCode);
	});

	it("blocks a declared argv that reads a zero-access path", () => {
		writeFileSync(join(scratch, ".env"), "SECRET=1\n");
		catalog("leak", ["cat", ".env"]);
		const decision = engine().evaluate({ tool: ToolNames.Verify, args: { check: "leak" } });
		strictEqual(decision.kind, "block", decision.reasons.join(" | "));
		strictEqual(decision.reasonCode, "secret_path_bash");
	});

	it("does not gate an id the catalog does not declare on catalog contents", () => {
		catalog("unit", [process.execPath, "-e", "process.exit(0)"]);
		const decision = engine().evaluate({ tool: ToolNames.Verify, args: { check: "typecheck" } });
		strictEqual(decision.kind, "allow");
		strictEqual(decision.execRecognition, "recognized");
	});
});
