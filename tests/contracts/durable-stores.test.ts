import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { disableExtension, installExtension } from "../../src/domains/extensions/index.js";
import { loadMemoryRecords, memoryStorePath, writeMemoryRecords } from "../../src/domains/memory/store.js";
import type { MemoryRecord } from "../../src/domains/memory/types.js";

describe("contracts/durable customization stores", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(path.join(tmpdir(), "clio-durable-stores-"));
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("writes memory records with the existing JSON shape", async () => {
		const dataDir = path.join(scratch, "data");
		const record: MemoryRecord = {
			id: "mem-0000000000000001",
			scope: "repo",
			key: "durable-write",
			lesson: "Use atomic resource writes.",
			evidenceRefs: ["test:durable-stores"],
			appliesWhen: [],
			avoidWhen: [],
			confidence: 0.9,
			createdAt: new Date(0).toISOString(),
			approved: true,
		};

		const writtenPath = await writeMemoryRecords(dataDir, [record]);

		strictEqual(writtenPath, memoryStorePath(dataDir));
		strictEqual(readFileSync(writtenPath, "utf8").endsWith("\n"), true);
		strictEqual((await loadMemoryRecords(dataDir))[0]?.id, "mem-0000000000000001");
		strictEqual(existsSync(`${writtenPath}.bak`), false);
	});

	it("writes extension state.json with the existing JSON shape", () => {
		const project = path.join(scratch, "project");
		const source = path.join(scratch, "extension-source");
		mkdirSync(source, { recursive: true });
		writeFileSync(
			path.join(source, "clio-extension.yaml"),
			[
				"manifestVersion: 1",
				"id: durable-ext",
				"name: Durable Extension",
				"version: 1.0.0",
				"description: Durable extension state.",
				"resources: {}",
				"",
			].join("\n"),
			"utf8",
		);

		const installed = installExtension(source, { cwd: project, scope: "project" });
		strictEqual(
			installed.diagnostics.some((diagnostic) => diagnostic.type === "error"),
			false,
		);
		const disabled = disableExtension("durable-ext", { cwd: project, scope: "project" });
		strictEqual(disabled.diagnostics.length, 0);

		const statePath = path.join(project, ".clio", "extensions", "state.json");
		const state = JSON.parse(readFileSync(statePath, "utf8")) as {
			version: number;
			disabled: string[];
			installed: Record<string, unknown>;
		};
		strictEqual(state.version, 1);
		ok(state.disabled.includes("durable-ext"));
		ok("durable-ext" in state.installed);
		strictEqual(readFileSync(statePath, "utf8").endsWith("\n"), true);
	});
});
