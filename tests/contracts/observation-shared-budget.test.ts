import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { findTool } from "../../src/tools/find.js";
import { lsTool } from "../../src/tools/ls.js";
import { OBSERVATION_TURN_BUDGET_ENV } from "../../src/tools/observation.js";
import { readTool } from "../../src/tools/read.js";
import type { ToolResult } from "../../src/tools/registry.js";
import { isSessionOffloadPath, writeToolOffload } from "../../src/tools/result-shaping.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const scratchRoots: string[] = [];
let isolatedClioEnv: IsolatedClioEnv | null = null;

function scratchTree(fileCount: number): string {
	const root = mkdtempSync(join(tmpdir(), "clio-shared-budget-"));
	scratchRoots.push(root);
	for (let i = 0; i < fileCount; i += 1) {
		const name = `file-${String(i).padStart(4, "0")}.txt`;
		writeFileSync(join(root, name), `line ${i}\n`, "utf8");
	}
	return root;
}

interface Probe {
	name: string;
	kind: string;
	bodyBytes: number;
	usedBeforeBytes: number | null;
}

function toProbe(name: string, result: ToolResult): Probe {
	const body = result.kind === "ok" ? result.output : result.message;
	const observation = (result.details?.observation ?? null) as {
		budget?: { usedBeforeBytes?: unknown };
	} | null;
	const usedBefore = observation?.budget?.usedBeforeBytes;
	return {
		name,
		kind: result.kind,
		bodyBytes: Buffer.byteLength(body, "utf8"),
		usedBeforeBytes: typeof usedBefore === "number" ? usedBefore : null,
	};
}

describe("contracts/observation shared turn budget", () => {
	afterEach(() => {
		while (scratchRoots.length > 0) {
			const dir = scratchRoots.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
		isolatedClioEnv?.restore();
		isolatedClioEnv = null;
	});

	it("does not double-spend the shared turn budget across concurrent OBSERVE calls", async () => {
		const root = scratchTree(500);
		const budget = 4096;
		const previous = process.env[OBSERVATION_TURN_BUDGET_ENV];
		process.env[OBSERVATION_TURN_BUDGET_ENV] = String(budget);
		try {
			const options = { sessionId: "s-shared-budget", turnId: `turn-${Date.now()}` };
			// find yields on its subprocess/readdir walk before finalizing; ls runs
			// synchronously. Ordered left-to-right so find reserves and must charge
			// the shared pool BEFORE ls reserves during find's in-flight window.
			const [findRes, lsRes] = await Promise.all([
				findTool.run({ pattern: "file-*.txt", path: root, limit: 5000 }, { ...options, toolCallId: "find" }),
				lsTool.run({ path: root }, { ...options, toolCallId: "ls" }),
			]);

			strictEqual(findRes.kind, "ok");
			strictEqual(lsRes.kind, "ok");

			const probes = [toProbe("find", findRes), toProbe("ls", lsRes)];

			// The shared pool starts empty for exactly one reserver; every later
			// concurrent OBSERVE call must observe the running spend.
			const zeroReservations = probes.filter((p) => p.usedBeforeBytes === 0).length;
			ok(
				zeroReservations <= 1,
				`at most one concurrent OBSERVE call may reserve against an empty pool; ${zeroReservations} saw usedBeforeBytes=0 (${JSON.stringify(probes)})`,
			);

			// Combined visible bytes must respect the one shared budget (plus a small
			// allowance for the envelope notice/limited-budget lines), never the sum
			// of independent full slices.
			const totalBodyBytes = probes.reduce((sum, p) => sum + p.bodyBytes, 0);
			ok(
				totalBodyBytes <= budget + 2048,
				`combined visible bytes ${totalBodyBytes} exceeded the ${budget}B turn budget beyond notice slack (${JSON.stringify(probes)})`,
			);
		} finally {
			if (previous === undefined) delete process.env[OBSERVATION_TURN_BUDGET_ENV];
			else process.env[OBSERVATION_TURN_BUDGET_ENV] = previous;
		}
	});

	it("lets session offload reads bypass an exhausted turn pool without charging it", async () => {
		isolatedClioEnv = isolateClioEnv("clio-offload-budget-");
		const budget = 1024;
		const previous = process.env[OBSERVATION_TURN_BUDGET_ENV];
		process.env[OBSERVATION_TURN_BUDGET_ENV] = String(budget);
		try {
			const root = scratchTree(0);
			const budgetFiller = join(root, "budget-filler.txt");
			const normal = join(root, "normal.txt");
			writeFileSync(budgetFiller, `${"x".repeat(100)}\n`.repeat(200), "utf8");
			writeFileSync(normal, "normal content\n", "utf8");

			const sessionId = `s-offload-${Date.now()}`;
			const turnId = `turn-${Date.now()}`;
			const options = { sessionId, turnId };
			const first = await readTool.run({ path: budgetFiller }, options);
			strictEqual(first.kind, "ok");

			const offloadPath = writeToolOffload("offload content survives the spent pool\n", {
				sessionId,
				toolCallId: "full-result",
			});
			ok(offloadPath, "offload fixture was written");

			const offload = await readTool.run({ path: offloadPath }, options);
			strictEqual(offload.kind, "ok");
			if (offload.kind === "ok") {
				ok(offload.output.includes("offload content survives"), "own scratch offload content is readable");
				ok(!offload.output.includes("observation budget exhausted"), "own scratch offload read bypasses the spent pool");
			}

			const after = await readTool.run({ path: normal }, options);
			strictEqual(after.kind, "ok");
			if (after.kind === "ok") {
				ok(after.output.includes("observation budget exhausted"), "normal reads still see the exhausted pool");
				ok(!after.output.includes("normal content"), "the offload read did not refund or expand the pool");
			}
		} finally {
			if (previous === undefined) delete process.env[OBSERVATION_TURN_BUDGET_ENV];
			else process.env[OBSERVATION_TURN_BUDGET_ENV] = previous;
		}
	});

	it("recognizes only files inside the current session's scratch offload directory", () => {
		isolatedClioEnv = isolateClioEnv("clio-offload-path-");
		const sessionId = "session-A";
		const stateDir = join(isolatedClioEnv.dir, "state");
		const ownDir = join(stateDir, "scratch", sessionId);
		mkdirSync(ownDir, { recursive: true });

		strictEqual(isSessionOffloadPath(join(ownDir, "call.txt"), sessionId), true);
		strictEqual(isSessionOffloadPath(join(stateDir, "scratch", "session-B", "call.txt"), sessionId), false);
		strictEqual(isSessionOffloadPath(ownDir, sessionId), false);
		strictEqual(isSessionOffloadPath(join(stateDir, "scratch", `${sessionId}-suffix`, "call.txt"), sessionId), false);
	});
});
