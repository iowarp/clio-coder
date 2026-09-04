import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { abbreviateModelId } from "../../src/interactive/theme/labels.js";

describe("model labels", () => {
	it("keeps a meaningful node prefix on physical gateway routes", () => {
		strictEqual(abbreviateModelId("dynamo/qwen3.8-27b"), "dynamo/qwen3.8-27b");
		strictEqual(abbreviateModelId("mini/ornith1.5-35b-moe"), "mini/ornith1.5-35b-moe");
	});

	it("keeps the compact leaf behavior for unqualified model ids", () => {
		strictEqual(abbreviateModelId("qwen3-coder-30b-a3b-instruct"), "qwen3-coder-30b");
	});
});
