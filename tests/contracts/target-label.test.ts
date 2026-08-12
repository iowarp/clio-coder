/**
 * One spelling for "Clio does not know what it is talking to".
 *
 * Five surfaces answered that question five ways. The welcome banner read
 * `not configured/not configured`, because it joined two halves that had each
 * substituted the same phrase. The editor rail read `no model`, the footer read
 * `none · none`, the settings overlay `(unset)`, and the providers overlay
 * `(no model)`. A user comparing a banner, a rail, and a footer is checking
 * whether Clio agrees with itself about its own state.
 */
import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { formatTargetLabel } from "../../src/interactive/theme/labels.js";

describe("contracts/target label", () => {
	it("has one phrase for neither half configured", () => {
		strictEqual(formatTargetLabel(null, null), "not configured");
		strictEqual(formatTargetLabel(undefined, undefined), "not configured");
		strictEqual(formatTargetLabel("", "   "), "not configured");
	});

	it("names which half is missing rather than repeating the same phrase", () => {
		// The banner used to render both halves as `not configured` and join them
		// with a slash, which said the same thing twice and neither time usefully.
		strictEqual(formatTargetLabel("declared", null), "declared · no model");
		strictEqual(formatTargetLabel(null, "some-model"), "no target · some-model");
	});

	it("abbreviates the model by default and joins with a middle dot", () => {
		strictEqual(formatTargetLabel("dynamo", "claude-sonnet-5"), "dynamo · claude-sonnet-5");
		strictEqual(formatTargetLabel("mini", "qwen3-coder-30b-a3b-instruct"), "mini · qwen3-coder-30b");
		strictEqual(
			formatTargetLabel("mini", "qwen3-coder-30b-a3b-instruct", { abbreviate: false }),
			"mini · qwen3-coder-30b-a3b-instruct",
		);
	});

	it("lets the narrow editor rail drop the spaces without changing the words", () => {
		strictEqual(formatTargetLabel("dynamo", "claude-sonnet-5", { separator: "·" }), "dynamo·claude-sonnet-5");
		// The separator is for the configured form only; the unset phrases are
		// prose and stay spaced on every surface.
		strictEqual(formatTargetLabel(null, null, { separator: "·" }), "not configured");
		strictEqual(formatTargetLabel("dynamo", null, { separator: "·" }), "dynamo · no model");
	});
});
