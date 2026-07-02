import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_YAML } from "../../src/core/defaults.js";

describe("contracts/defaults-yaml", () => {
	it("keeps DEFAULT_SETTINGS_YAML in lockstep with DEFAULT_SETTINGS", () => {
		deepStrictEqual(parseYaml(DEFAULT_SETTINGS_YAML), DEFAULT_SETTINGS);
	});
});
