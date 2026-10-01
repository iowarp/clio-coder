/**
 * bin/clio-coder.cjs decides, before dist/ is loaded, whether this Node can run
 * Clio (#408). Its floor must match package.json engines.node.
 */
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const guard = require("../../bin/clio-coder.cjs") as {
	isSupportedNode: (version: string, min?: number[]) => boolean;
	MIN_NODE: number[];
};

describe("contracts/launcher-guard", () => {
	it("compares major, minor and patch against the engines floor", () => {
		const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
			engines: { node: string };
		};
		deepStrictEqual(`>=${guard.MIN_NODE.join(".")}`, pkg.engines.node);
		for (const [version, supported] of [
			["18.20.8", false],
			["20.19.5", false],
			["22.18.9", false],
			["22.19.0", true],
			["v22.19.1", true],
			["24.0.0", true],
			["garbage", false],
		] as const) {
			strictEqual(guard.isSupportedNode(version), supported, version);
		}
	});
});
