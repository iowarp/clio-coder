import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { buildAuditRecord, openAuditWriter } from "../../src/domains/safety/audit.js";
import { createSafetyPolicyEngine, type SafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { loadProjectSafetyPolicy } from "../../src/domains/safety/project-policy.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

const INVALID_POLICY_YAML = ["version: 1", "zeroAccessPaths:", "  - /etc", ""].join("\n");

describe("contracts/safety ordering: hard blocks win over the ask rail", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-safety-ordering-"));
		mkdirSync(join(scratch, ".clio"), { recursive: true });
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	function engineAt(dir: string): SafetyPolicyEngine {
		return createSafetyPolicyEngine({ cwd: dir, projectPolicy: loadProjectSafetyPolicy(dir) });
	}

	it("blocks a confirmed ask-rule command whose write target is a zero-access path", () => {
		const engine = engineAt(scratch);
		// `: > .env` matches the colon-truncate ask rule while its redirect
		// write target is the default zero-access `.env` entry. The path-policy
		// block must win at every posture; confirmation must not admit it.
		const call = { tool: ToolNames.Bash, args: { command: ": > .env" } };
		const confirmed = engine.evaluate(call, "confirmed");
		strictEqual(confirmed.kind, "block");
		strictEqual(confirmed.reasonCode, "path-policy:zeroAccessPaths");
		const unconfirmed = engine.evaluate(call);
		strictEqual(unconfirmed.kind, "block");
		strictEqual(unconfirmed.reasonCode, "path-policy:zeroAccessPaths");
	});

	it("blocks a confirmed ask-rule command that targets a zero-access path by token", () => {
		const engine = engineAt(scratch);
		// The traced escape shape: truncate matches the truncate-size-zero ask
		// rule and its operand is a zero-access path. The zero-access rail must
		// hard-stop it instead of parking behind an ordinary confirm.
		const call = { tool: ToolNames.Bash, args: { command: "truncate -s 0 .env" } };
		const confirmed = engine.evaluate(call, "confirmed");
		strictEqual(confirmed.kind, "block");
		strictEqual(confirmed.reasonCode, "secret_path_bash");
		strictEqual(engine.evaluate(call).kind, "block");
	});

	it("fails an ask-rule-matched execution command closed under an invalid project policy", () => {
		writeFileSync(join(scratch, ".clio", "safety.yaml"), INVALID_POLICY_YAML, "utf8");
		const loaded = loadProjectSafetyPolicy(scratch);
		strictEqual(loaded.valid, false);
		const engine = createSafetyPolicyEngine({ cwd: scratch, projectPolicy: loaded });
		const call = { tool: ToolNames.Bash, args: { command: "git stash drop" } };
		const unconfirmed = engine.evaluate(call);
		strictEqual(unconfirmed.kind, "block");
		strictEqual(unconfirmed.reasonCode, "project-policy-invalid");
		const confirmed = engine.evaluate(call, "confirmed");
		strictEqual(confirmed.kind, "block");
		strictEqual(confirmed.reasonCode, "project-policy-invalid");
	});

	it("keeps the ask rail unchanged for ask-rule commands that hit no block", () => {
		const engine = engineAt(scratch);
		for (const command of ["git stash drop", "truncate -s 0 server.log"]) {
			const call = { tool: ToolNames.Bash, args: { command } };
			const first = engine.evaluate(call);
			strictEqual(first.kind, "ask", `${command} must ask when unconfirmed`);
			ok(first.reasonCode.startsWith("damage-control:"), first.reasonCode);
			const confirmed = engine.evaluate(call, "confirmed");
			strictEqual(confirmed.kind, "allow", `${command} must allow when confirmed`);
			ok(confirmed.reasonCode.startsWith("damage-control:"), confirmed.reasonCode);
		}
	});
});

describe("contracts/safety ordering: default path policy survives an invalid config", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-safety-invalid-policy-"));
		mkdirSync(join(scratch, ".clio"), { recursive: true });
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("blocks typed access to default zero-access paths under an invalid policy", () => {
		writeFileSync(join(scratch, ".clio", "safety.yaml"), INVALID_POLICY_YAML, "utf8");
		const loaded = loadProjectSafetyPolicy(scratch);
		strictEqual(loaded.valid, false);
		const engine = createSafetyPolicyEngine({ cwd: scratch, projectPolicy: loaded });

		const envRead = engine.evaluate({ tool: ToolNames.Read, args: { path: ".env" } });
		strictEqual(envRead.kind, "block");
		strictEqual(envRead.reasonCode, "path-policy:zeroAccessPaths");

		const sshRead = engine.evaluate({ tool: ToolNames.Read, args: { path: "~/.ssh/id_rsa" } });
		strictEqual(sshRead.kind, "block");
		strictEqual(sshRead.reasonCode, "path-policy:zeroAccessPaths");

		const envWrite = engine.evaluate({ tool: ToolNames.Write, args: { path: ".env", content: "x" } });
		strictEqual(envWrite.kind, "block");
		strictEqual(envWrite.reasonCode, "path-policy:zeroAccessPaths");

		// The fail-closed rail under an invalid policy covers execution tools
		// and default-protected paths, not the whole filesystem: ordinary
		// workspace reads stay open.
		const plainRead = engine.evaluate({ tool: ToolNames.Read, args: { path: "notes.txt" } });
		strictEqual(plainRead.kind, "allow");
	});

	it("keeps current behavior with an absent or valid policy", () => {
		const absent = createSafetyPolicyEngine({ cwd: scratch, projectPolicy: loadProjectSafetyPolicy(scratch) });
		strictEqual(absent.evaluate({ tool: ToolNames.Read, args: { path: ".env" } }).kind, "block");
		strictEqual(absent.evaluate({ tool: ToolNames.Read, args: { path: "notes.txt" } }).kind, "allow");

		writeFileSync(
			join(scratch, ".clio", "safety.yaml"),
			["version: 1", "zeroAccessPaths:", "  - secrets", ""].join("\n"),
			"utf8",
		);
		const valid = createSafetyPolicyEngine({ cwd: scratch, projectPolicy: loadProjectSafetyPolicy(scratch) });
		strictEqual(valid.evaluate({ tool: ToolNames.Read, args: { path: ".env" } }).kind, "block");
		strictEqual(valid.evaluate({ tool: ToolNames.Read, args: { path: "secrets/key.txt" } }).kind, "block");
		strictEqual(valid.evaluate({ tool: ToolNames.Read, args: { path: "notes.txt" } }).kind, "allow");
	});
});

describe("contracts/safety ordering: audit rows stay readable without per-row fsync", () => {
	const ORIGINAL_ENV = { ...process.env };
	let scratch: string;

	beforeEach(() => {
		scratch = newScratchClioHome("clio-safety-audit-");
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		clearScratchClioHome(scratch);
	});

	function readRows(): Array<Record<string, unknown>> {
		const auditDir = join(scratch, "state", "audit");
		return readdirSync(auditDir)
			.filter((name) => name.endsWith(".jsonl"))
			.flatMap((name) =>
				readFileSync(join(auditDir, name), "utf8")
					.split("\n")
					.filter((line) => line.length > 0)
					.map((line) => JSON.parse(line) as Record<string, unknown>),
			);
	}

	it("keeps rows immediately readable in-process and durable through flush and close", async () => {
		const writer = openAuditWriter();
		const record = (tool: string) =>
			buildAuditRecord({ tool, classification: { actionClass: "execute", reasons: [] }, decision: "classified" });
		writer.write(record("bash"));
		writer.write(record("verify"));

		// writeSync makes rows visible to in-process readers before any fsync.
		const beforeFlush = readRows();
		strictEqual(beforeFlush.length, 2);
		strictEqual(beforeFlush[0]?.tool, "bash");
		strictEqual(beforeFlush[1]?.tool, "verify");

		writer.flush();
		writer.write(record("read"));
		await writer.close();

		// Content and order are unchanged after the explicit flush and the
		// closing fsync.
		const afterClose = readRows();
		strictEqual(afterClose.length, 3);
		strictEqual(afterClose[2]?.tool, "read");
		ok(afterClose.every((row) => row.kind === "tool_call"));
	});
});
