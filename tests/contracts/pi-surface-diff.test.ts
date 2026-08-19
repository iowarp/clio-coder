import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	comparePiSurfaceSnapshots,
	type PiSurfaceImports,
	type PiSurfaceSnapshot,
} from "../../scripts/pi-surface-diff.js";

function surface(exports: Record<string, string>, version = "0.84.0"): PiSurfaceSnapshot {
	return {
		schemaVersion: 1,
		packages: {
			"@earendil-works/pi-ai": {
				version,
				entryPoints: { ".": { declaration: "dist/index.d.ts", exports } },
			},
			"@earendil-works/pi-agent-core": {
				version,
				entryPoints: { ".": { declaration: "dist/index.d.ts", exports: {} } },
			},
			"@earendil-works/pi-tui": {
				version,
				entryPoints: { ".": { declaration: "dist/index.d.ts", exports: {} } },
			},
		},
	};
}

describe("Pi surface diff", () => {
	it("errors on changed or removed Clio imports and reports new exports", () => {
		const baseline = surface({ Changed: "old", Removed: "old", Stable: "same", Unused: "old" });
		const current = surface({ Changed: "new", NewHelper: "new", Stable: "same", Unused: "new" }, "0.85.0");
		const imports: PiSurfaceImports = {
			"@earendil-works/pi-ai": ["Changed", "Removed", "Stable"],
		};

		const result = comparePiSurfaceSnapshots(baseline, current, imports);

		assert.deepEqual(result.errors, [
			"@earendil-works/pi-ai: imported export Changed changed signature",
			"@earendil-works/pi-ai: imported export Removed was removed",
		]);
		assert.ok(result.infos.includes("@earendil-works/pi-ai: version 0.84.0 -> 0.85.0"));
		assert.ok(result.infos.includes("@earendil-works/pi-ai: new export NewHelper"));
		assert.ok(!result.errors.some((line) => line.includes("Unused")));
	});
});
