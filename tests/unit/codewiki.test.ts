import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type CodewikiEntry, writeCodewiki } from "../../src/domains/context/codewiki/indexer.js";
import { whereIsTool } from "../../src/tools/codewiki/where-is.js";

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
	const prev = process.cwd();
	process.chdir(cwd);
	try {
		return await fn();
	} finally {
		process.chdir(prev);
	}
}

function parseEntries(output: string): CodewikiEntry[] {
	const parsed = JSON.parse(output) as { entries?: CodewikiEntry[] };
	return parsed.entries ?? [];
}

interface FixtureOptions {
	prefix?: string;
}

function makeFixture(options: FixtureOptions = {}): string {
	const dir = mkdtempSync(join(tmpdir(), options.prefix ?? "clio-codewiki-where-is-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ main: "dist/index.js" }), "utf8");
	writeCodewiki(dir, {
		version: 1,
		generatedAt: "2026-05-07T00:00:00.000Z",
		language: "typescript",
		entries: [
			{ path: "src/interactive/tui.ts", exports: ["renderTui"], imports: [] },
			{ path: "src/interactive/chat-panel.ts", exports: ["ChatPanel"], imports: [] },
			{ path: "src/cli/index.ts", exports: ["main"], imports: [] },
			{ path: "src/cli/doctor.ts", exports: ["runDoctor"], imports: [] },
			{ path: "src/tools/registry.ts", exports: ["registerTool"], imports: [] },
		],
	});
	return dir;
}

describe("where_is pattern detection", () => {
	it("treats .*tui.* as a bare regex and finds tui-bearing paths", async () => {
		const dir = makeFixture();
		try {
			await withCwd(dir, async () => {
				const result = await whereIsTool.run({ pattern: ".*tui.*" });
				strictEqual(result.kind, "ok");
				if (result.kind !== "ok") return;
				const entries = parseEntries(result.output);
				strictEqual(entries.length, 1);
				strictEqual(entries[0]?.path, "src/interactive/tui.ts");
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("treats ^src/cli/ as an anchored bare regex", async () => {
		const dir = makeFixture();
		try {
			await withCwd(dir, async () => {
				const result = await whereIsTool.run({ pattern: "^src/cli/" });
				strictEqual(result.kind, "ok");
				if (result.kind !== "ok") return;
				const entries = parseEntries(result.output);
				strictEqual(entries.length, 2);
				const paths = entries.map((e) => e.path).sort();
				strictEqual(paths[0], "src/cli/doctor.ts");
				strictEqual(paths[1], "src/cli/index.ts");
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still parses /cli/i as a regex literal with flags", async () => {
		const dir = makeFixture();
		try {
			await withCwd(dir, async () => {
				const result = await whereIsTool.run({ pattern: "/cli/i" });
				strictEqual(result.kind, "ok");
				if (result.kind !== "ok") return;
				const entries = parseEntries(result.output);
				strictEqual(entries.length, 2);
				ok(entries.every((e) => e.path.startsWith("src/cli/")));
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still treats src/interactive/*.ts as a glob", async () => {
		const dir = makeFixture();
		try {
			await withCwd(dir, async () => {
				const result = await whereIsTool.run({ pattern: "src/interactive/*.ts" });
				strictEqual(result.kind, "ok");
				if (result.kind !== "ok") return;
				const entries = parseEntries(result.output);
				strictEqual(entries.length, 2);
				const paths = entries.map((e) => e.path).sort();
				strictEqual(paths[0], "src/interactive/chat-panel.ts");
				strictEqual(paths[1], "src/interactive/tui.ts");
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still treats a bare token like tui as a substring match", async () => {
		const dir = makeFixture();
		try {
			await withCwd(dir, async () => {
				const result = await whereIsTool.run({ pattern: "tui" });
				strictEqual(result.kind, "ok");
				if (result.kind !== "ok") return;
				const entries = parseEntries(result.output);
				strictEqual(entries.length, 1);
				strictEqual(entries[0]?.path, "src/interactive/tui.ts");
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls through cleanly when a regex-shaped pattern fails to compile", async () => {
		const dir = makeFixture();
		try {
			await withCwd(dir, async () => {
				// "(?:" looks like regex (matches REGEX_SYNTAX_HINTS) but is invalid as a RegExp.
				// It also has no glob metachars and is not a substring of any entry path,
				// so the tool should return an empty list rather than throw.
				const result = await whereIsTool.run({ pattern: "(?:" });
				strictEqual(result.kind, "ok");
				if (result.kind !== "ok") return;
				const entries = parseEntries(result.output);
				strictEqual(entries.length, 0);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
