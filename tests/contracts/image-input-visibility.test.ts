import { deepStrictEqual } from "node:assert/strict";
import { it } from "node:test";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import { capabilityLabels } from "../../src/interactive/footer/dashboard.js";

it("the dashboard names image input for both vision and text-only models", () => {
	deepStrictEqual(capabilityLabels({ ...EMPTY_CAPABILITIES, chat: true }).includes("images no"), true);
	deepStrictEqual(capabilityLabels({ ...EMPTY_CAPABILITIES, chat: true, vision: true }).includes("images yes"), true);
});
