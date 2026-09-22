import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { createRegistry, type ToolRegistry, type ToolResult } from "../../src/tools/registry.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * clio_library through the gateway of a session registry, over a project with
 * one skill and the catalog this checkout ships. HOME points at the scratch
 * home so the operator's own skill folders never reach the listing. The
 * exhaustive projection of an installed plugin lives in
 * tests/extended/library-context.test.ts; this file holds the call contract.
 */

interface LibraryRow {
	row: string;
	kind: string;
	name: string;
	owner?: string;
	scope?: string;
	invocation?: string;
	origin: { kind: string; path?: string };
}

interface LibraryPage {
	total: number;
	shown: number;
	offset: number;
	nextOffset?: number;
	rows: LibraryRow[];
	note: string;
}

const SKILL_BODY = "Compare every cell against the reference grid before reporting.";

describe("clio_library tool", () => {
	let scratch: IsolatedClioEnv;
	let registry: ToolRegistry;
	let project: string;
	let previousCwd: string;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-clio-library-");
		process.env.HOME = scratch.dir;
		project = join(scratch.dir, "project");
		mkdirSync(join(project, ".clio-coder", "skills", "grid-check"), { recursive: true });
		writeFileSync(
			join(project, ".clio-coder", "skills", "grid-check", "SKILL.md"),
			`---\nname: grid-check\ndescription: Check a numeric grid against a reference.\n---\n\n# Grid check\n\n${SKILL_BODY}\n`,
		);
		previousCwd = process.cwd();
		process.chdir(project);
		registry = createRegistry({ safety: createWorkerSafety({ cwd: project }) });
		registerAllTools(registry, { mcpCapabilities: false });
	});
	afterEach(() => {
		process.chdir(previousCwd);
		scratch.restore();
	});

	async function call(args: Record<string, unknown>): Promise<ToolResult> {
		const verdict = await registry.invoke({
			tool: ToolNames.Gateway,
			args: { op: "call", capability: ToolNames.ClioLibrary, args },
		});
		if (verdict.kind !== "ok") throw new Error(`clio_library was not admitted: ${JSON.stringify(verdict)}`);
		return verdict.result;
	}

	async function page(args: Record<string, unknown> = {}): Promise<LibraryPage> {
		const result = await call(args);
		if (result.kind !== "ok") throw new Error(`expected ok for ${JSON.stringify(args)}, got ${JSON.stringify(result)}`);
		ok(!result.output.includes(SKILL_BODY), "the catalog never returns an instruction body");
		return JSON.parse(result.output) as LibraryPage;
	}

	it("lists the project skill with its owner, origin, and invocation, and writes nothing", async () => {
		const before = readdirSync(project, { recursive: true, encoding: "utf8" }).sort();
		const listed = await page({ query: "grid" });
		strictEqual(listed.total, 1);
		const [row] = listed.rows;
		deepStrictEqual(
			{ row: row?.row, kind: row?.kind, name: row?.name, owner: row?.owner, scope: row?.scope },
			{ row: "resource", kind: "skill", name: "grid-check", owner: "project", scope: "project" },
		);
		strictEqual(row?.invocation, "/skill grid-check");
		deepStrictEqual(row?.origin, {
			kind: "local",
			path: join(project, ".clio-coder", "skills", "grid-check", "SKILL.md"),
		});
		match(listed.note, /Read-only catalog: this tool does not install or activate/);
		deepStrictEqual(readdirSync(project, { recursive: true, encoding: "utf8" }).sort(), before);
	});

	it("selects one record by ref and answers an unknown ref with an honest empty page", async () => {
		deepStrictEqual(
			(await page({ ref: "grid-check" })).rows.map((row) => row.name),
			["grid-check"],
		);
		const missing = await page({ ref: "no-such-recipe" });
		deepStrictEqual([missing.total, missing.shown, missing.rows], [0, 0, []]);
	});

	it("pages a stable order without overlap, clamps the page size, and filters by kind", async () => {
		const first = await page({ limit: 2 });
		strictEqual(first.shown, 2);
		strictEqual(first.nextOffset, 2);
		const second = await page({ limit: 2, offset: first.nextOffset });
		strictEqual(second.offset, 2);
		const seen = [...first.rows, ...second.rows].map((row) => `${row.kind}:${row.name}:${row.owner}`);
		strictEqual(new Set(seen).size, 4, "consecutive pages never repeat a row");
		ok((await page({ limit: 10_000 })).shown <= 50, "a page is never unbounded");
		const skills = await page({ kind: "skill", limit: 50 });
		ok(skills.rows.length > 0 && skills.rows.every((row) => row.kind === "skill"), JSON.stringify(skills.rows));
	});

	it("refuses an unknown kind at the gateway and refuses the read entirely in a worker registry", async () => {
		const rejected = await call({ kind: "spellbook" });
		match(rejected.kind === "error" ? rejected.message : "", /^gateway: clio_library arguments rejected: /);
		const worker = await createWorkerToolRegistry(undefined, createWorkerSafety({ cwd: project })).invoke({
			tool: ToolNames.ClioLibrary,
			args: {},
		});
		strictEqual(worker.kind, "ok");
		if (worker.kind === "ok") {
			strictEqual(worker.result.kind, "error");
			if (worker.result.kind === "error") match(worker.result.message, /unavailable/);
		}
	});
});
