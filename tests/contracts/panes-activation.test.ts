import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { extractGlobalFlags } from "../../src/cli/argv.js";
import { resolvePanesEnablement } from "../../src/entry/panes-activation.js";

describe("panes activation", () => {
	it("resolves the flag over the setting in both directions", () => {
		// --no-panes beats every setting, including embedded.
		strictEqual(resolvePanesEnablement("without", "auto"), "off");
		strictEqual(resolvePanesEnablement("without", "embedded"), "off");
		strictEqual(resolvePanesEnablement("without", "off"), "off");
		strictEqual(resolvePanesEnablement("without", undefined), "off");
		// --with-panes activates guest detection even over enabled=off, and
		// honors an embedded setting rather than downgrading it.
		strictEqual(resolvePanesEnablement("with", "off"), "auto");
		strictEqual(resolvePanesEnablement("with", "auto"), "auto");
		strictEqual(resolvePanesEnablement("with", "embedded"), "embedded");
		strictEqual(resolvePanesEnablement("with", undefined), "auto");
	});

	it("defaults to off: plain boots do zero pane-host work", () => {
		strictEqual(resolvePanesEnablement(undefined, undefined), "off");
		strictEqual(resolvePanesEnablement(undefined, "off"), "off");
		// Settings alone can still turn the extension on durably.
		strictEqual(resolvePanesEnablement(undefined, "auto"), "auto");
		strictEqual(resolvePanesEnablement(undefined, "embedded"), "embedded");
	});

	it("parses --with-panes and --no-panes as global flags, last one winning", () => {
		strictEqual(extractGlobalFlags(["--with-panes"]).panes, "with");
		strictEqual(extractGlobalFlags(["--no-panes"]).panes, "without");
		strictEqual(extractGlobalFlags([]).panes, undefined);
		// A wrapper's baked-in default is overridable by appending the opposite.
		strictEqual(extractGlobalFlags(["--with-panes", "--no-panes"]).panes, "without");
		// The flag composes with the other global flags without eating values.
		const combined = extractGlobalFlags(["--with-panes", "--api-key", "k"]);
		strictEqual(combined.panes, "with");
		strictEqual(combined.apiKey, "k");
		deepStrictEqual(combined.rest, []);
	});
});
