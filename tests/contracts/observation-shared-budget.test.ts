import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { findTool } from "../../src/tools/find.js";
import { lsTool } from "../../src/tools/ls.js";
import { OBSERVATION_TURN_BUDGET_ENV } from "../../src/tools/observation.js";
import type { ToolResult } from "../../src/tools/registry.js";

const scratchRoots: string[] = [];

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
});
