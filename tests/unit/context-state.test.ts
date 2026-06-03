import { equal, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { serializeClioMd } from "../../src/domains/context/clio-md.js";
import { createContextBundle } from "../../src/domains/context/extension.js";
import { computeFingerprint } from "../../src/domains/context/fingerprint.js";
import { writeClioState } from "../../src/domains/context/state.js";

const previousDataDir = process.env.CLIO_DATA_DIR;
const scratchDirs: string[] = [];

afterEach(() => {
	if (previousDataDir === undefined) Reflect.deleteProperty(process.env, "CLIO_DATA_DIR");
	else process.env.CLIO_DATA_DIR = previousDataDir;
	resetXdgCache();
	for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	scratchDirs.push(dir);
	return dir;
}

function contextContract() {
	const ctx = { bus: {}, getContract: () => undefined } as unknown as DomainContext;
	return createContextBundle(ctx).contract;
}

function writeValidClioMd(cwd: string): void {
	const fingerprint = computeFingerprint(cwd);
	writeFileSync(
		join(cwd, "CLIO.md"),
		serializeClioMd({
			projectName: "Demo",
			identity: "Demo project context for tests.",
			conventions: [],
			invariants: [],
			fingerprint: {
				initAt: "2026-01-01T00:00:00.000Z",
				model: "test-model",
				gitHead: fingerprint.gitHead,
				treeHash: fingerprint.treeHash,
				loc: fingerprint.loc,
			},
		}),
		"utf8",
	);
}

function seedMemory(dataDir: string): void {
	mkdirSync(join(dataDir, "memory"), { recursive: true });
	writeFileSync(
		join(dataDir, "memory", "records.json"),
		`${JSON.stringify(
			{
				version: 1,
				records: [
					{
						id: "mem-0123456789abcdef",
						scope: "repo",
						key: "demo",
						lesson: "Use the demo invariant.",
						evidenceRefs: ["ev-1"],
						appliesWhen: [],
						avoidWhen: [],
						confidence: 0.8,
						createdAt: "2026-01-01T00:00:00.000Z",
						approved: true,
					},
				],
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

describe("context contract contextState", () => {
	it("reports CLIO.md ok and memory count through the public contract", () => {
		const cwd = scratch("clio-context-ok-");
		const dataDir = scratch("clio-context-data-");
		process.env.CLIO_DATA_DIR = dataDir;
		resetXdgCache();
		writeValidClioMd(cwd);
		writeClioState(cwd, { version: 1, fingerprint: computeFingerprint(cwd) });
		seedMemory(dataDir);

		const state = contextContract().contextState(cwd);
		strictEqual(state.clioMd, "ok");
		strictEqual(state.memoryCount, 1);
	});

	it("distinguishes missing, malformed, no-fingerprint, and stale CLIO.md", () => {
		const contract = contextContract();
		const missing = scratch("clio-context-missing-");
		strictEqual(contract.contextState(missing).clioMd, "none");

		const malformed = scratch("clio-context-malformed-");
		writeFileSync(join(malformed, "CLIO.md"), "not a clio guide", "utf8");
		strictEqual(contract.contextState(malformed).clioMd, "malformed");

		const noFingerprint = scratch("clio-context-no-fingerprint-");
		writeFileSync(join(noFingerprint, "CLIO.md"), "# Demo\n\nDemo identity.\n", "utf8");
		strictEqual(contract.contextState(noFingerprint).clioMd, "no-fingerprint");

		const stale = scratch("clio-context-stale-");
		writeValidClioMd(stale);
		writeClioState(stale, { version: 1, fingerprint: computeFingerprint(stale) });
		writeFileSync(join(stale, "new.ts"), `${Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n")}\n`, "utf8");
		equal(contract.contextState(stale).clioMd, "stale");
	});
});
