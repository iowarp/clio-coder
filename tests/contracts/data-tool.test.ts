import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import type { ToolRegistry, ToolResult } from "../../src/tools/registry.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * The data capability's own run(): argument repair, workspace path
 * resolution, the observation envelope, and refusal mapping. The readers
 * underneath are pinned by data-csv, data-json, and data-jsonl; this file
 * holds the tool contract over real files, called the way a model reaches it
 * (through the gateway) and by name, where the tool's own guards answer.
 */

describe("data tool", () => {
	let scratch: IsolatedClioEnv;
	let registry: ToolRegistry;
	let previousCwd: string;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-data-tool-");
		writeFileSync(join(scratch.dir, "obs.csv"), "id,temp,site\n1,20.5,A\n2,NaN,B\n3,22.0,C\n4,-999,D\n");
		writeFileSync(
			join(scratch.dir, "runs.json"),
			'{"runs":[{"id":1,"energy":12345678901234567890},{"id":2,"energy":3.5}]}',
		);
		writeFileSync(join(scratch.dir, "events.jsonl"), '{"a":1}\n{"a":2}\nnot json\n');
		writeFileSync(join(scratch.dir, "blob.bin"), "x");
		previousCwd = process.cwd();
		process.chdir(scratch.dir);
		registry = createWorkerToolRegistry(undefined, createWorkerSafety({ cwd: scratch.dir }));
	});
	afterEach(() => {
		process.chdir(previousCwd);
		scratch.restore();
	});

	async function viaGateway(args: Record<string, unknown>): Promise<ToolResult> {
		const verdict = await registry.invoke({ tool: ToolNames.Gateway, args: { op: "call", capability: "data", args } });
		if (verdict.kind !== "ok") throw new Error(`data was not admitted: ${JSON.stringify(verdict)}`);
		return verdict.result;
	}

	async function byName(args: Record<string, unknown>): Promise<ToolResult> {
		const verdict = await registry.invoke({ tool: ToolNames.Data, args });
		if (verdict.kind !== "ok") throw new Error(`data was not admitted: ${JSON.stringify(verdict)}`);
		return verdict.result;
	}

	function body(result: ToolResult): Record<string, unknown> {
		if (result.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
		return JSON.parse(result.output) as Record<string, unknown>;
	}

	it("inspects a CSV relative to the workspace and labels the view it reports", async () => {
		const result = await viaGateway({ op: "inspect", path: "obs.csv" });
		const inspected = body(result);
		deepStrictEqual([inspected.format, inspected.rowCount, inspected.header], ["csv", 4, ["id", "temp", "site"]]);
		const details = result.kind === "ok" ? result.details : undefined;
		deepStrictEqual(
			[details?.op, details?.path, details?.format, details?.viewLabel, details?.capability],
			["inspect", join(scratch.dir, "obs.csv"), "csv", "exact", "data"],
		);
	});

	it("selects a row window verbatim and hands back the offset that continues it", async () => {
		const result = await viaGateway({ op: "select", path: "obs.csv", offset: 1, limit: 2, columns: ["temp", "site"] });
		const selected = body(result);
		deepStrictEqual(selected.rows, [
			["NaN", "B"],
			["22.0", "C"],
		]);
		const observation = (result.kind === "ok" ? result.details?.observation : undefined) as Record<string, unknown>;
		deepStrictEqual(
			[observation.unit, observation.shownCount, observation.truncated, observation.next],
			["entries", 2, true, "offset=3"],
		);
	});

	it("reports an unsafe integer as its literal instead of rounding it", async () => {
		const selected = body(await viaGateway({ op: "select", path: "runs.json", pointer: "/runs/0" }));
		deepStrictEqual((selected.value as { energy: unknown }).energy, {
			$literal: "12345678901234567890",
			precision: "unsafe-integer",
		});
		strictEqual((selected.precision as { count: number }).count, 1);
	});

	it("validates JSON Lines and names the first invalid line", async () => {
		const validated = body(await viaGateway({ op: "validate", path: "events.jsonl" }));
		strictEqual(validated.valid, false);
		strictEqual((validated.invalid as { first: Array<{ line: number }> }).first[0]?.line, 3);
	});

	it("maps each reader refusal to an error that names the op and the reason", async () => {
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ op: "inspect", path: "missing.csv" }, "not-found"],
			[{ op: "inspect", path: "blob.bin" }, "unsupported-format"],
			[{ op: "select", path: "runs.json", pointer: "/nope" }, "pointer-not-found"],
			[{ op: "select", path: "obs.csv", columns: ["pressure"] }, "unknown-column"],
		];
		for (const [args, reason] of cases) {
			const result = await viaGateway(args);
			if (result.kind !== "error") throw new Error(`expected a refusal for ${JSON.stringify(args)}`);
			match(result.message, new RegExp(`^data: ${args.op} refused \\(${reason}\\): `));
			strictEqual((result.details?.refusal as { reason: string }).reason, reason);
		}
	});

	it("repairs weak-model argument shapes by name and refuses what it cannot repair", async () => {
		strictEqual(body(await byName({ op: "inspect", file: "obs.csv" })).rowCount, 4);
		deepStrictEqual(body(await byName({ op: "select", path: " obs.csv ", offset: "3", limit: "5" })).rows, [
			["4", "-999", "D"],
		]);
		for (const [args, expected] of [
			[{ op: "count", path: "obs.csv" }, "data: op must be inspect, select, or validate; got 'count'"],
			[{ op: "inspect", path: "   " }, "data: path is required"],
		] as const) {
			const result = await byName(args);
			strictEqual(result.kind === "error" ? result.message : JSON.stringify(result), expected);
		}
		const schema = await viaGateway({ op: "count", path: "obs.csv" });
		match(schema.kind === "error" ? schema.message : "", /^gateway: data arguments rejected: /);
	});
});
