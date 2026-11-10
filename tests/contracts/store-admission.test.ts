import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { storeBlobPath, storeProjectDir } from "../../src/core/store-paths.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { classify } from "../../src/domains/safety/action-classifier.js";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createGatewayTool } from "../../src/tools/gateway/index.js";
import { createRegistry } from "../../src/tools/registry.js";
import { createStoreTool } from "../../src/tools/store/store-tool.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("store safety admission", () => {
	let scratch: IsolatedClioEnv;
	let cwd: string;
	let previousCwd: string;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-store-admission-");
		cwd = join(scratch.dir, "workspace");
		mkdirSync(cwd, { recursive: true });
		previousCwd = process.cwd();
		process.chdir(cwd);
	});

	afterEach(() => {
		process.chdir(previousCwd);
		scratch.restore();
	});

	it("classifies each op by what it does and names the store target, never the source", () => {
		const store = (args: Record<string, unknown>) => classify({ tool: ToolNames.Store, args });
		for (const op of ["tags", "list", "stat", "get", "frobnicate", undefined]) {
			strictEqual(store({ op, tag: "sim", blob: "a.txt" }).actionClass, "read", String(op));
		}
		for (const op of ["create", "put", "note"]) {
			strictEqual(store({ op, tag: "sim", blob: "a.txt", path: "a.txt" }).actionClass, "write", op);
		}
		const put = store({ op: "put", tag: "sim", path: "out/a.txt" });
		deepStrictEqual(put.reasons, [`store-write: ${storeBlobPath(cwd, "sim", "a.txt")}`]);
		deepStrictEqual(store({ op: "remove", tag: "sim", blob: "a.txt" }), {
			actionClass: "destructive",
			reasons: ["store-remove: sim:a.txt"],
		});
		// The tool reads `ref` only without `tag`, so the reason names the blob it removes, not the ref's.
		deepStrictEqual(store({ op: "remove", tag: "sim", blob: "a.txt", ref: "other:b.txt" }).reasons, [
			"store-remove: sim:a.txt",
		]);
		deepStrictEqual(store({ op: "put", tag: "sim", path: "../outside.txt" }).reasons, [
			"store-put-source-outside-workspace",
		]);
	});

	it("admits a put over an existing blob like a remove", () => {
		const existing = storeBlobPath(cwd, "sim", "a.txt");
		mkdirSync(dirname(existing), { recursive: true });
		writeFileSync(existing, "irreplaceable\n");
		deepStrictEqual(classify({ tool: ToolNames.Store, args: { op: "put", tag: "sim", path: "out/a.txt" } }), {
			actionClass: "destructive",
			reasons: ["store-replace: sim:a.txt"],
		});
	});

	it("refuses a store write outside the run's write roots", () => {
		const engine = createSafetyPolicyEngine({ cwd, writeRoots: ["src/"] });
		const put = engine.evaluate({ tool: ToolNames.Store, args: { op: "put", tag: "sim", path: "a.txt" } });
		strictEqual(put.reasonCode, "write-root");
	});

	it("admits a cd into this project's store directory and not another project's", () => {
		const own = storeProjectDir(cwd);
		const other = storeProjectDir(scratch.dir);
		mkdirSync(own, { recursive: true });
		mkdirSync(other, { recursive: true });
		const cd = (dir: string) => classify({ tool: "bash", args: { command: `cd ${dir} && ls` } }).reasons;
		ok(!cd(own).some((reason) => reason.startsWith("bash-cd-outside-workspace")), cd(own).join("; "));
		ok(
			cd(other).some((reason) => reason.startsWith("bash-cd-outside-workspace")),
			cd(other).join("; "),
		);
	});

	it("gateway describe states the store's authority per op, not the read class for all of them", async () => {
		const registry = createRegistry({ safety: createWorkerSafety({ cwd }), autonomy: () => "default" });
		registry.register(createStoreTool({ getCwd: () => cwd, writable: true }));
		registry.register(createGatewayTool({ registry }));
		const verdict = await registry.invoke({ tool: "gateway", args: { op: "describe", capability: "store" } });
		ok(verdict.kind === "ok" && verdict.result.kind === "ok");
		const authority = (JSON.parse(verdict.result.output) as { authority: string[] }).authority.join(" ");
		doesNotMatch(authority, /Read class: runs at every autonomy level/u);
		match(authority, /create, put and note are write class/u);
		match(authority, /remove[^.;]*destructive/u);
		match(authority, /worker's store is read-only/u);
	});
});
