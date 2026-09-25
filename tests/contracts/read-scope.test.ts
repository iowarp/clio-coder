import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { type AutonomyLevel, mapAutonomy } from "../../src/domains/safety/autonomy.js";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { AcpToolMediator } from "../../src/engine/acp/tool-mediator.js";
import { emitClaudeToolPermissionDecision } from "../../src/engine/claude/tool-safety.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { findTool } from "../../src/tools/find.js";
import { grepTool } from "../../src/tools/grep.js";
import { lsTool } from "../../src/tools/ls.js";
import { readTool } from "../../src/tools/read.js";
import { createRegistry } from "../../src/tools/registry.js";
import { writeTool } from "../../src/tools/write.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * Search scope: read, ls, grep, and find stay read class, and a path that
 * resolves outside the workspace asks below full-auto and runs at full-auto.
 * The workspace sits one level inside its own temp directory, so `..` from it
 * and `data/out -> ../..` both land in that directory.
 */
describe("read scope admission", () => {
	let originalCwd: string;
	let env: IsolatedClioEnv;
	let base: string;
	let root: string;

	const SCOPED = [
		{ tool: ToolNames.Read, spec: readTool, outside: "../outside/notes.txt", linked: "data/out/outside/notes.txt" },
		{ tool: ToolNames.Ls, spec: lsTool, outside: "../outside", linked: "data/out/outside" },
		{ tool: ToolNames.Grep, spec: grepTool, outside: "../outside", linked: "data/out/outside" },
		{ tool: ToolNames.Find, spec: findTool, outside: "../outside", linked: "data/out/outside" },
	] as const;

	function argsFor(tool: string, path: string): Record<string, unknown> {
		if (tool === ToolNames.Grep) return { pattern: "OUTSIDE", literal: true, path };
		if (tool === ToolNames.Find) return { pattern: "*.txt", path };
		return { path };
	}

	beforeEach(async () => {
		originalCwd = process.cwd();
		env = await isolateClioEnv("read-scope-");
		base = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-read-scope-")));
		root = join(base, "root");
		mkdirSync(join(root, "data"), { recursive: true });
		mkdirSync(join(base, "outside"));
		writeFileSync(join(base, "outside", "notes.txt"), "OUTSIDE marker\n");
		writeFileSync(join(root, "data", "inside.txt"), "OUTSIDE marker, but inside\n");
		symlinkSync("../..", join(root, "data", "out"));
		process.chdir(root);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(base, { recursive: true, force: true });
		env.restore();
	});

	it("flags a path outside the workspace for every scoped tool, by `..`, by link, and by absolute path", () => {
		const engine = createSafetyPolicyEngine({ cwd: root });
		for (const entry of SCOPED) {
			for (const path of [entry.outside, entry.linked, join(base, "outside")]) {
				const decision = engine.evaluate({ tool: entry.tool, args: argsFor(entry.tool, path) });
				strictEqual(decision.kind, "allow", `${entry.tool} ${path}`);
				strictEqual(decision.actionClass, "read", `${entry.tool} ${path}`);
				strictEqual(decision.readScope, "outside-workspace", `${entry.tool} ${path}`);
				ok(
					decision.reasons.some((reason) => reason.startsWith(`read-path-outside-workspace: ${join(base, "outside")}`)),
					`${entry.tool} ${path}: ${decision.reasons.join("; ")}`,
				);
			}
		}
	});

	it("leaves a path inside the workspace, a missing one, and a defaulted one unflagged", () => {
		const engine = createSafetyPolicyEngine({ cwd: root });
		symlinkSync("inside.txt", join(root, "data", "alias.txt"));
		for (const entry of SCOPED) {
			for (const path of ["data", "data/inside.txt", "data/alias.txt", "data/out/root/data", "data/absent", root]) {
				const decision = engine.evaluate({ tool: entry.tool, args: argsFor(entry.tool, path) });
				strictEqual(decision.kind, "allow", `${entry.tool} ${path}`);
				strictEqual(decision.readScope, undefined, `${entry.tool} ${path}`);
			}
		}
		strictEqual(engine.evaluate({ tool: ToolNames.Grep, args: { pattern: "x" } }).readScope, undefined);
		strictEqual(engine.evaluate({ tool: ToolNames.Ls, args: {} }).readScope, undefined);
	});

	it("treats a path that cannot be canonicalized as outside", () => {
		symlinkSync("loop-b", join(root, "data", "loop-a"));
		symlinkSync("loop-a", join(root, "data", "loop-b"));
		const decision = createSafetyPolicyEngine({ cwd: root }).evaluate({
			tool: ToolNames.Read,
			args: { path: "data/loop-a/x.txt" },
		});
		strictEqual(decision.readScope, "outside-workspace");
	});

	it("keeps Clio's skill roots and offload scratch readable, and nothing else under Clio's home", () => {
		const engine = createSafetyPolicyEngine({ cwd: root });
		const skill = join(env.dir, "config", "skills", "demo");
		for (const path of [join(skill, "SKILL.md"), join(env.dir, "state", "scratch", "s1", "full.txt")]) {
			strictEqual(engine.evaluate({ tool: ToolNames.Read, args: { path } }).readScope, undefined, path);
		}
		const sessions = join(env.dir, "data", "sessions", "other.jsonl");
		strictEqual(engine.evaluate({ tool: ToolNames.Read, args: { path: sessions } }).readScope, "outside-workspace");
		// `..` out of an exempt root is judged by where it lands.
		const climbed = join(skill, "..", "..", "..", "data", "sessions");
		strictEqual(
			engine.evaluate({ tool: ToolNames.Ls, args: { path: `${skill}/../../../data/sessions` } }).readScope,
			"outside-workspace",
			climbed,
		);
	});

	it("admits a skill an operator installed as a link, and not a link inside the Clio-written scratch", () => {
		const engine = createSafetyPolicyEngine({ cwd: root });
		mkdirSync(join(env.dir, "config", "skills"), { recursive: true });
		mkdirSync(join(env.dir, "state", "scratch"), { recursive: true });
		symlinkSync(join(base, "outside"), join(env.dir, "config", "skills", "linked"));
		symlinkSync(join(base, "outside"), join(env.dir, "state", "scratch", "linked"));
		const skillRead = { path: join(env.dir, "config", "skills", "linked", "notes.txt") };
		const scratchRead = { path: join(env.dir, "state", "scratch", "linked", "notes.txt") };
		strictEqual(engine.evaluate({ tool: ToolNames.Read, args: skillRead }).readScope, undefined);
		strictEqual(engine.evaluate({ tool: ToolNames.Read, args: scratchRead }).readScope, "outside-workspace");
	});

	it("still refuses a zero-access path outside the workspace, and drops the flag once the operator confirmed", () => {
		writeFileSync(join(base, "outside", ".env"), "TOKEN=x\n");
		const engine = createSafetyPolicyEngine({ cwd: root });
		const blocked = engine.evaluate({ tool: ToolNames.Read, args: { path: "../outside/.env" } });
		strictEqual(blocked.kind, "block");
		strictEqual(blocked.reasonCode, "path-policy:zeroAccessPaths");
		const confirmed = engine.evaluate({ tool: ToolNames.Read, args: { path: "../outside/notes.txt" } }, "confirmed");
		strictEqual(confirmed.kind, "allow");
		strictEqual(confirmed.readScope, undefined);
	});

	it("ignores a `cwd` the read tools never read, however it is padded", async () => {
		mkdirSync(join(root, "sub", "deeper"), { recursive: true });
		const engine = createSafetyPolicyEngine({ cwd: root });
		for (const entry of SCOPED) {
			for (const cwd of ["sub/deeper", "n/n/n/n/n", "../outside"]) {
				const args = { ...argsFor(entry.tool, entry.outside), cwd };
				strictEqual(engine.evaluate({ tool: entry.tool, args }).readScope, "outside-workspace", `${entry.tool} ${cwd}`);
			}
			const inside = { ...argsFor(entry.tool, "data"), cwd: "../outside" };
			strictEqual(engine.evaluate({ tool: entry.tool, args: inside }).readScope, undefined, entry.tool);
		}
		// The same padding used to pull a zero-access path back inside the workspace.
		const store = join(env.dir, "config", "credentials.yaml");
		const secret = engine.evaluate({
			tool: ToolNames.Read,
			args: { path: relative(root, store), cwd: "n/n/n/n/n/n/n/n/n/n/n/n" },
		});
		strictEqual(secret.kind, "block", store);
		strictEqual(secret.reasonCode, "path-policy:zeroAccessPaths");
	});

	it("judges the path the tools open once they drop a leading `@`", async () => {
		const engine = createSafetyPolicyEngine({ cwd: root });
		for (const entry of SCOPED) {
			const decision = engine.evaluate({ tool: entry.tool, args: argsFor(entry.tool, `@${entry.outside}`) });
			strictEqual(decision.readScope, "outside-workspace", entry.tool);
		}
		const secret = engine.evaluate({ tool: ToolNames.Read, args: { path: "@~/.ssh/id_rsa" } });
		strictEqual(secret.kind, "block", join(homedir(), ".ssh"));
		strictEqual(secret.reasonCode, "path-policy:zeroAccessPaths");

		const write = engine.evaluate({ tool: ToolNames.Write, args: { path: "@../at-escape.txt", content: "x" } });
		strictEqual(write.actionClass, "system_modify");
		strictEqual(write.kind, "ask");
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: root }), autonomy: () => "default" });
		registry.register(writeTool);
		registry.onPermissionRequired((_call, _decision, meta) => {
			registry.cancelParkedCall(meta.requestId, "contract: denied");
		});
		const verdict = await registry.invoke({ tool: ToolNames.Write, args: { path: "@../at-escape.txt", content: "x" } });
		strictEqual(verdict.kind, "blocked");
		strictEqual(existsSync(join(base, "at-escape.txt")), false);
	});

	it("judges the spellings a read falls back to when the plain one does not exist", () => {
		// resolveReadPath tries a curly apostrophe, NFD, and the macOS AM/PM space.
		symlinkSync(join(base, "outside", "notes.txt"), join(root, "it\u2019s.txt"));
		symlinkSync(join(base, "outside"), join(root, "cafe\u0301"));
		symlinkSync(join(base, "outside", "notes.txt"), join(root, "shot 1\u202FPM.txt"));
		const engine = createSafetyPolicyEngine({ cwd: root });
		for (const path of ["it's.txt", "caf\u00e9/notes.txt", "shot 1 PM.txt"]) {
			strictEqual(engine.evaluate({ tool: ToolNames.Read, args: { path } }).readScope, "outside-workspace", path);
		}
		strictEqual(engine.evaluate({ tool: ToolNames.Ls, args: { path: "caf\u00e9" } }).readScope, "outside-workspace");
		writeFileSync(join(root, "plain's.txt"), "inside\n");
		strictEqual(engine.evaluate({ tool: ToolNames.Read, args: { path: "plain's.txt" } }).readScope, undefined);
	});

	it("keeps the installed package's docs and source readable, and nothing else in the package", () => {
		const engine = createSafetyPolicyEngine({ cwd: root });
		const packageRoot = resolvePackageRoot();
		for (const path of [
			join(packageRoot, "docs", "README.md"),
			join(packageRoot, "src", "core", "package-root.ts"),
			join(packageRoot, "README.md"),
			join(packageRoot, "CHANGELOG.md"),
		]) {
			strictEqual(engine.evaluate({ tool: ToolNames.Read, args: { path } }).readScope, undefined, path);
		}
		for (const path of [
			join(packageRoot, "package.json"),
			join(packageRoot, "node_modules"),
			join(packageRoot, "dist", "assets", "codewiki.json"),
			`${join(packageRoot, "docs")}/../package.json`,
		]) {
			strictEqual(engine.evaluate({ tool: ToolNames.Read, args: { path } }).readScope, "outside-workspace", path);
		}
	});

	it("keeps the interop skill roots and dispatch receipts readable", () => {
		const engine = createSafetyPolicyEngine({ cwd: root });
		for (const path of [
			join(homedir(), ".claude", "skills", "demo", "SKILL.md"),
			join(env.dir, "state", "receipts", "run-1.json"),
		]) {
			strictEqual(engine.evaluate({ tool: ToolNames.Read, args: { path } }).readScope, undefined, path);
		}
		const sibling = join(homedir(), ".claude", "skillsX", "demo.md");
		strictEqual(engine.evaluate({ tool: ToolNames.Read, args: { path: sibling } }).readScope, "outside-workspace");
	});

	it("holds when the workspace itself is reached through a link", () => {
		symlinkSync(root, join(base, "ws-link"));
		const engine = createSafetyPolicyEngine({ cwd: join(base, "ws-link") });
		strictEqual(engine.evaluate({ tool: ToolNames.Read, args: { path: "data/inside.txt" } }).readScope, undefined);
		const absolute = { path: join(base, "ws-link", "data", "inside.txt") };
		strictEqual(engine.evaluate({ tool: ToolNames.Read, args: absolute }).readScope, undefined);
		strictEqual(
			engine.evaluate({ tool: ToolNames.Read, args: { path: "../outside/notes.txt" } }).readScope,
			"outside-workspace",
		);
	});

	it("reaches the Claude SDK seam: outside paths, search directories, and globs that leave the directory", () => {
		const outside = join(base, "outside");
		const decide = (toolName: string, input: Record<string, unknown>, autonomy: AutonomyLevel) =>
			emitClaudeToolPermissionDecision({
				toolName,
				input,
				safety: createWorkerSafety({ cwd: root }),
				cwd: root,
				autonomy,
				emit: () => {},
			});
		const cases: Array<[string, Record<string, unknown>]> = [
			["Read", { file_path: join(outside, "notes.txt") }],
			["LS", { path: outside }],
			["Grep", { pattern: "x", path: outside }],
			["Grep", { pattern: "x", path: outside, file_path: "data/inside.txt" }],
			["Grep", { pattern: "x", glob: `${outside}/*.txt` }],
			["Glob", { pattern: `${outside}/**` }],
			["Glob", { pattern: "../outside/*.txt" }],
			["Glob", { pattern: "*.txt", path: outside }],
		];
		for (const [toolName, input] of cases) {
			const denied = decide(toolName, input, "default");
			strictEqual(denied.kind, "deny", `${toolName} ${JSON.stringify(input)}`);
			match(denied.reason, /outside the workspace/u, toolName);
			strictEqual(decide(toolName, input, "yolo").kind, "allow", `${toolName} ${JSON.stringify(input)}`);
		}
		strictEqual(decide("Glob", { pattern: "data/**/*.txt" }, "default").kind, "allow");
		strictEqual(decide("Grep", { pattern: "x", glob: "*.txt", path: "data" }, "default").kind, "allow");
	});

	it("reaches the ACP seam, including a search that names its directory and one with no kind", async () => {
		const outside = join(base, "outside");
		const handle = async (toolCall: Record<string, unknown>, autonomy: AutonomyLevel) => {
			const reasons: string[] = [];
			const mediator = new AcpToolMediator({
				safety: createWorkerSafety({ cwd: root }),
				cwd: root,
				toolGovernance: "clio-coder-policy",
				autonomy,
				onPermissionResolved: (event) => reasons.push(event.reason),
			});
			await mediator.handle({ toolCall, options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }] });
			return reasons;
		};
		const cases: Array<Record<string, unknown>> = [
			{ kind: "read", rawInput: { path: join(outside, "notes.txt") } },
			{ kind: "search", rawInput: { pattern: "x", path: outside } },
			{ kind: "search", rawInput: { directory: outside } },
			{ kind: "search", rawInput: { dir_path: outside } },
			{ title: "grep", rawInput: { pattern: "x", path: outside } },
		];
		for (const toolCall of cases) {
			const denied = await handle(toolCall, "default");
			strictEqual(denied.length, 1, JSON.stringify(toolCall));
			match(denied[0] as string, /a path outside the workspace/u, JSON.stringify(toolCall));
			deepStrictEqual(await handle(toolCall, "yolo"), [], JSON.stringify(toolCall));
		}
		deepStrictEqual(await handle({ kind: "search", rawInput: { pattern: "x", path: "data" } }, "default"), []);
	});

	it("maps an outside read to deny, ask, ask, allow across the levels and leaves inside reads alone", () => {
		const levels: AutonomyLevel[] = ["default", "yolo"];
		deepStrictEqual(
			levels.map((level) => mapAutonomy(level, "read", { readOutsideWorkspace: true })),
			["ask", "allow"],
		);
		deepStrictEqual(
			levels.map((level) => mapAutonomy(level, "read")),
			["allow", "allow"],
		);
	});

	function registryAt(level: AutonomyLevel, readOnly = false) {
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: root }), autonomy: () => level, readOnly });
		for (const entry of SCOPED) registry.register(entry.spec);
		return registry;
	}

	it("parks every scoped tool at auto-edit, denies it unattended, and runs it once approved", async () => {
		for (const entry of SCOPED) {
			const denied = registryAt("default");
			denied.onPermissionRequired((_call, decision, meta) => {
				match(decision.kind === "ask" ? decision.rejection.short : "", /path is outside the workspace/u);
				denied.cancelParkedCall(meta.requestId, "contract: denied");
			});
			const blocked = await denied.invoke({ tool: entry.tool, args: argsFor(entry.tool, entry.linked) });
			strictEqual(blocked.kind, "blocked", entry.tool);

			const approved = registryAt("default");
			approved.onPermissionRequired((_call, _decision, meta) => {
				void approved.resumeParkedCalls({
					actionClass: "read",
					requestId: meta.requestId,
					requestedBy: "contract-operator",
				});
			});
			const ran = await approved.invoke({ tool: entry.tool, args: argsFor(entry.tool, entry.linked) });
			strictEqual(ran.kind, "ok", `${entry.tool}: ${JSON.stringify(ran)}`);
		}
	});

	it("runs every scoped tool at full-auto, denies it at read-only, and never asks for an inside path", async () => {
		for (const entry of SCOPED) {
			const suggest = registryAt("default");
			let asked = 0;
			suggest.onPermissionRequired((_call, _decision, meta) => {
				asked += 1;
				suggest.cancelParkedCall(meta.requestId, "contract: denied");
			});
			strictEqual((await suggest.invoke({ tool: entry.tool, args: argsFor(entry.tool, entry.outside) })).kind, "blocked");
			strictEqual(asked, 1, entry.tool);

			const fullAuto = registryAt("yolo");
			const ran = await fullAuto.invoke({ tool: entry.tool, args: argsFor(entry.tool, entry.outside) });
			strictEqual(ran.kind, "ok", `${entry.tool}: ${JSON.stringify(ran)}`);

			const readOnly = registryAt("default", true);
			const denied = await readOnly.invoke({ tool: entry.tool, args: argsFor(entry.tool, entry.outside) });
			strictEqual(denied.kind, "blocked", entry.tool);
			if (denied.kind === "blocked") match(denied.reason, /this run is read-only/u);

			const inside = entry.tool === ToolNames.Read ? "data/inside.txt" : "data";
			const insideRun = await readOnly.invoke({ tool: entry.tool, args: argsFor(entry.tool, inside) });
			strictEqual(insideRun.kind, "ok", `${entry.tool}: ${JSON.stringify(insideRun)}`);
		}
	});
});
