import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { classify } from "../../src/domains/safety/action-classifier.js";
import { compilePathPolicy, evaluatePathPolicy } from "../../src/domains/safety/path-policy.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { publishFileAtomically, withFileMutationQueue } from "../../src/tools/file-mutation-queue.js";
import { resolveReadPath, resolveToCwd } from "../../src/tools/path-utils.js";
import { readTool } from "../../src/tools/read.js";
import { createRegistry } from "../../src/tools/registry.js";
import { writeTool } from "../../src/tools/write.js";

/**
 * The kernel resolves `data/linkdir/../x` one component at a time: it reads
 * `linkdir` and steps up from the link's target. path.resolve collapses the
 * same string to `data/x` before any link is read. Admission, the tools, and
 * the shell must all land where the kernel does. The workspace root sits one
 * level inside its own temp directory, and `data/linkdir` points at
 * `<base>/elsewhere/deep`, so `data/linkdir/../x` lands in `<base>/elsewhere`.
 */
describe("physical `..` through a symlink", () => {
	let originalCwd: string;
	let base: string;
	let root: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		base = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-physical-dotdot-")));
		root = join(base, "root");
		mkdirSync(join(root, "data", "sub", "deeper"), { recursive: true });
		mkdirSync(join(base, "elsewhere", "deep"), { recursive: true });
		symlinkSync("../../elsewhere/deep", join(root, "data", "linkdir"));
		// Stays inside: its physical parent is data/sub, two levels below root.
		symlinkSync("sub/deeper", join(root, "data", "deeplink"));
		process.chdir(root);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(base, { recursive: true, force: true });
	});

	function shell(command: string): void {
		execFileSync("bash", ["-c", command], { cwd: root, stdio: "ignore" });
	}

	function bashClass(command: string): { actionClass: string; reasons: readonly string[] } {
		return classify({ tool: ToolNames.Bash, args: { command } });
	}

	function writeClass(path: string): { actionClass: string; reasons: readonly string[] } {
		return classify({ tool: ToolNames.Write, args: { path, content: "x" } });
	}

	/** A write tool call at default whose park, if any, the operator approves. */
	async function approvedWrite(path: string, content: string) {
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: root }), autonomy: () => "default" });
		registry.register(writeTool);
		registry.onPermissionRequired((_call, decision, meta) => {
			setImmediate(() => {
				void registry.resumeParkedCalls({
					actionClass: decision.classification.actionClass,
					requestId: meta.requestId,
					requestedBy: "contract-operator",
				});
			});
		});
		return registry.invoke({ tool: ToolNames.Write, args: { path, content } });
	}

	it("classifies a bash redirect through link/.. by where the shell writes it", () => {
		const command = "echo x > data/linkdir/../inside.txt";
		deepStrictEqual(bashClass(command), {
			actionClass: "system_modify",
			reasons: [`write-path-outside-cwd: ${join(base, "elsewhere", "inside.txt")}`],
		});
		shell(command);
		ok(existsSync(join(base, "elsewhere", "inside.txt")));
		strictEqual(existsSync(join(root, "data", "inside.txt")), false);
	});

	it("classifies a redirect through a directory the same command creates first", () => {
		const command = "mkdir -p data/missing && echo x > data/missing/../linkdir/../made.txt";
		deepStrictEqual(bashClass(command), {
			actionClass: "system_modify",
			reasons: [`write-path-outside-cwd: ${join(base, "elsewhere", "made.txt")}`],
		});
		shell(command);
		ok(existsSync(join(base, "elsewhere", "made.txt")));
	});

	it("escalates a cd through link/.. under the logical and the physical shell reading", () => {
		// Plain `cd` is logical and lands in data; `cd -P` is physical and lands
		// outside. Admission cannot tell which the shell uses, so it takes both.
		for (const command of ["cd data/linkdir/.. && echo x > cd.txt", "cd -P data/linkdir/.. && echo x > cd.txt"]) {
			deepStrictEqual(
				bashClass(command),
				{ actionClass: "system_modify", reasons: [`bash-cd-outside-workspace: ${join(base, "elsewhere")}`] },
				command,
			);
		}
		shell("cd -P data/linkdir/.. && echo x > cd.txt");
		ok(existsSync(join(base, "elsewhere", "cd.txt")));
		strictEqual(bashClass("cd data/sub/deeper/.. && echo x > cd.txt").actionClass, "execute");
	});

	it("classifies a write tool call through link/.. as outside and publishes it at the physical target", async () => {
		deepStrictEqual(writeClass("data/linkdir/../x.txt"), {
			actionClass: "system_modify",
			reasons: [`write-path-outside-cwd: ${join(base, "elsewhere", "x.txt")}`],
		});
		strictEqual(resolveToCwd("data/linkdir/../x.txt"), join(base, "elsewhere", "x.txt"));
		const verdict = await approvedWrite("data/linkdir/../x.txt", "approved\n");
		strictEqual(verdict.kind, "ok");
		strictEqual(readFileSync(join(base, "elsewhere", "x.txt"), "utf8"), "approved\n");
		strictEqual(existsSync(join(root, "data", "x.txt")), false);
	});

	it("admits a write whose lexical target is outside but whose physical target is inside, and lands it inside", async () => {
		// Lexically <base>/y.txt; physically data/sub/deeper → sub → data → root.
		const path = "data/deeplink/../../../y.txt";
		deepStrictEqual(writeClass(path), { actionClass: "write", reasons: [] });
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: root }), autonomy: () => "default" });
		registry.register(writeTool);
		const verdict = await registry.invoke({ tool: ToolNames.Write, args: { path, content: "inside\n" } });
		strictEqual(verdict.kind, "ok");
		strictEqual(readFileSync(join(root, "y.txt"), "utf8"), "inside\n");
		strictEqual(existsSync(join(base, "y.txt")), false);
	});

	it("reads through link/.. from the physical target and matches path policy there", async () => {
		writeFileSync(join(base, "elsewhere", "notes.txt"), "outside notes\n");
		writeFileSync(join(root, "data", "notes.txt"), "inside notes\n");
		const path = "data/linkdir/../notes.txt";
		strictEqual(resolveReadPath(path), join(base, "elsewhere", "notes.txt"));
		const secret = compilePathPolicy({ zeroAccessPaths: [join(base, "elsewhere", "notes.txt")] }, root);
		strictEqual(evaluatePathPolicy(secret, "read", path).kind, "block");
		const lexical = compilePathPolicy({ zeroAccessPaths: [join(root, "data", "notes.txt")] }, root);
		strictEqual(evaluatePathPolicy(lexical, "read", path).kind, "allow");
		// Outside the workspace, so the read runs unattended only at yolo.
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: root }), autonomy: () => "yolo" });
		registry.register(readTool);
		const verdict = await registry.invoke({ tool: ToolNames.Read, args: { path } });
		strictEqual(verdict.kind, "ok");
		ok(verdict.kind === "ok" && verdict.result.kind === "ok" && verdict.result.output.includes("outside notes"));
		strictEqual(execFileSync("bash", ["-c", `cat ${path}`], { cwd: root, encoding: "utf8" }), "outside notes\n");
	});

	it("publishes and queues through a crafted link target by the physical walk admission uses", async () => {
		// data/sub2 → <base>/elsewhere/deep, so `sub2/../../x` climbs to <base>.
		// path.resolve(data, target) reads <root>/x.txt instead.
		symlinkSync("../../elsewhere/deep", join(root, "data", "sub2"));
		symlinkSync("sub2/../../crafted.txt", join(root, "data", "crafted.txt"));
		// The reverse: lexically <base>/back.txt, physically <root>/back.txt.
		symlinkSync("deeplink/../../../back.txt", join(root, "data", "back.txt"));
		deepStrictEqual(writeClass("data/crafted.txt"), {
			actionClass: "system_modify",
			reasons: [`write-path-outside-cwd: ${join(base, "crafted.txt")}`],
		});
		deepStrictEqual(writeClass("data/back.txt"), { actionClass: "write", reasons: [] });

		await publishFileAtomically(join(root, "data", "crafted.txt"), "crafted\n");
		strictEqual(readFileSync(join(base, "crafted.txt"), "utf8"), "crafted\n");
		strictEqual(existsSync(join(root, "crafted.txt")), false);
		await publishFileAtomically(join(root, "data", "back.txt"), "back\n");
		strictEqual(readFileSync(join(root, "back.txt"), "utf8"), "back\n");
		strictEqual(existsSync(join(base, "back.txt")), false);

		// The link and its physical target share one queue: the second waits.
		const order: string[] = [];
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = withFileMutationQueue(join(root, "data", "crafted.txt"), async () => {
			order.push("first:start");
			await held;
			order.push("first:end");
		});
		const second = withFileMutationQueue(join(base, "crafted.txt"), async () => {
			order.push("second");
		});
		await new Promise((resolve) => setImmediate(resolve));
		release();
		await Promise.all([first, second]);
		deepStrictEqual(order, ["first:start", "first:end", "second"]);
	});

	it("refuses a write whose physical target cannot be resolved and publishes nothing", async () => {
		symlinkSync("loop-b", join(root, "data", "loop-a"));
		symlinkSync("loop-a", join(root, "data", "loop-b"));
		// Lexically data/z.txt; the kernel fails the lookup with ELOOP.
		const path = "data/loop-a/../z.txt";
		deepStrictEqual(writeClass(path), { actionClass: "system_modify", reasons: [`write-path-outside-cwd: ${path}`] });
		const verdict = await approvedWrite(path, "loop\n");
		strictEqual(verdict.kind, "ok");
		ok(verdict.kind === "ok" && verdict.result.kind === "error", "the tool reports an error");
		strictEqual(existsSync(join(root, "data", "z.txt")), false);
	});

	it("lands admission, the write tool, and the shell on the same file for every case", async () => {
		symlinkSync("../../elsewhere/deep", join(root, "data", "sub2"));
		symlinkSync("sub2/../../crafted.txt", join(root, "data", "crafted.txt"));
		symlinkSync("deeplink/../../../back.txt", join(root, "data", "back.txt"));
		const cases: Array<{ path: string; landing: string; lexical: string }> = [
			{ path: "data/linkdir/../a.txt", landing: join(base, "elsewhere", "a.txt"), lexical: join(root, "data", "a.txt") },
			{ path: "data/deeplink/../../../b.txt", landing: join(root, "b.txt"), lexical: join(base, "b.txt") },
			{ path: "data/crafted.txt", landing: join(base, "crafted.txt"), lexical: join(root, "crafted.txt") },
			{ path: "data/back.txt", landing: join(root, "back.txt"), lexical: join(base, "back.txt") },
		];
		for (const { path, landing, lexical } of cases) {
			const inside = landing.startsWith(`${root}${sep}`);
			deepStrictEqual(
				writeClass(path),
				inside
					? { actionClass: "write", reasons: [] }
					: { actionClass: "system_modify", reasons: [`write-path-outside-cwd: ${landing}`] },
				path,
			);
			const verdict = await approvedWrite(path, "tool\n");
			ok(verdict.kind === "ok" && verdict.result.kind === "ok", path);
			strictEqual(readFileSync(landing, "utf8"), "tool\n", path);
			shell(`printf 'shell\\n' > ${path}`);
			strictEqual(readFileSync(landing, "utf8"), "shell\n", path);
			strictEqual(existsSync(lexical), false, path);
		}
	});
});
