import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { createArtifactTool } from "../../src/tools/artifact.js";
import type { RegistryVerdict, ToolRegistry, ToolResult } from "../../src/tools/registry.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * artifact through the gateway of a worker registry over a real workspace:
 * where a pathless document lands, what the terminal result carries, and
 * every refusal. Gateway parity with a direct call lives in
 * gateway-authority.test.ts.
 */

describe("artifact tool", () => {
	let scratch: IsolatedClioEnv;
	let registry: ToolRegistry;
	let workspace: string;
	let previousCwd: string;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-artifact-tool-");
		workspace = join(scratch.dir, "workspace");
		mkdirSync(workspace);
		previousCwd = process.cwd();
		process.chdir(workspace);
		registry = createWorkerToolRegistry(undefined, createWorkerSafety({ cwd: workspace }));
	});
	afterEach(() => {
		process.chdir(previousCwd);
		scratch.restore();
	});

	function viaGateway(args: Record<string, unknown>): Promise<RegistryVerdict> {
		return registry.invoke({ tool: ToolNames.Gateway, args: { op: "call", capability: ToolNames.Artifact, args } });
	}

	async function written(args: Record<string, unknown>): Promise<Extract<ToolResult, { kind: "ok" }>> {
		const verdict = await viaGateway(args);
		if (verdict.kind !== "ok" || verdict.result.kind !== "ok") throw new Error(JSON.stringify(verdict));
		return verdict.result;
	}

	it("lands a pathless document per kind under .clio-coder/artifacts and ends the turn", async () => {
		const plan = await written({ kind: "plan", content: "step one", title: "Plan" });
		const target = join(workspace, ".clio-coder", "artifacts", "PLAN.md");
		strictEqual(readFileSync(target, "utf8"), "# Plan\n\nstep one");
		strictEqual(plan.terminate, true);
		strictEqual(plan.output, "wrote plan artifact (16B) to .clio-coder/artifacts/PLAN.md");
		deepStrictEqual(
			[plan.details?.kind, plan.details?.paths, plan.details?.observation],
			["plan", [target], { shownBytes: 16 }],
		);
		for (const [kind, file] of [
			["review", "REVIEW.md"],
			["report", "REPORT.md"],
		] as const) {
			await written({ kind, content: "# Already titled\n\nbody", title: "Ignored" });
			strictEqual(readFileSync(join(workspace, ".clio-coder", "artifacts", file), "utf8"), "# Already titled\n\nbody");
		}
		for (const file of ["PLAN.md", "REVIEW.md", "REPORT.md"]) {
			strictEqual(existsSync(join(workspace, file)), false, `${file} never lands in the working tree unasked`);
		}
	});

	it("writes an explicit path inside the workspace and reports the file it replaced", async () => {
		const first = await written({ kind: "report", content: "v1", path: "notes/deep/REPORT.md" });
		strictEqual(readFileSync(join(workspace, "notes", "deep", "REPORT.md"), "utf8"), "v1");
		strictEqual((first.details?.file as { before: unknown }).before, null);
		const second = await written({ kind: "report", content: "version two", path: "notes/deep/REPORT.md" });
		const file = second.details?.file as { before: { bytes: number }; after: { bytes: number } };
		deepStrictEqual([file.before.bytes, file.after.bytes], [2, 11]);
	});

	it("refuses empty content, an unknown kind, and a path outside the workspace without writing", async () => {
		const empty = await viaGateway({ kind: "review", content: "" });
		ok(empty.kind === "ok" && empty.result.kind === "error", JSON.stringify(empty));
		if (empty.kind === "ok" && empty.result.kind === "error") {
			strictEqual(empty.result.message, "artifact: kind=review requires non-empty content");
		}
		const unknown = await viaGateway({ kind: "memo", content: "x" });
		ok(unknown.kind === "ok" && unknown.result.kind === "error", JSON.stringify(unknown));
		if (unknown.kind === "ok" && unknown.result.kind === "error") {
			match(unknown.result.message, /^gateway: artifact arguments rejected: /);
		}
		const escaping = await viaGateway({ kind: "report", content: "x", path: "../outside.md" });
		strictEqual(escaping.kind, "blocked", "an outside write parks for the operator before the tool runs");
		strictEqual(existsSync(join(scratch.dir, "outside.md")), false);
		strictEqual(existsSync(join(workspace, ".clio-coder")), false);

		// The tool's own guard holds even when a caller skips admission.
		const direct = createArtifactTool({ getCwd: () => workspace });
		const bypass = await direct.run({ kind: "report", content: "x", path: "../outside.md" });
		strictEqual(
			bypass.kind === "error" ? bypass.message : "",
			`artifact: path escapes workspace root: ${join(scratch.dir, "outside.md")}`,
		);
		const unknownByName = await direct.run({ kind: "memo", content: "x" });
		strictEqual(
			unknownByName.kind === "error" ? unknownByName.message : "",
			"artifact: kind must be plan, review, or report; got 'memo'",
		);
		strictEqual(existsSync(join(scratch.dir, "outside.md")), false);
	});
});
