import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { diagnosticSeverityToken, runtimeResolutionDiagnosticLine } from "../../src/interactive/overlay-frame.js";
import { clioTheme } from "../../src/interactive/theme/index.js";

describe("contracts/overlay-frame diagnostics", () => {
	it("colors a warning diagnostic amber, not red", () => {
		const theme = clioTheme();
		const line = runtimeResolutionDiagnosticLine(
			{ severity: "warning", code: "thinking-coerced", message: "xhigh coerced to high" },
			60,
		);
		ok(line.startsWith(theme.fgSequence("warning")), "warning severity renders in the amber warning token");
		ok(!line.startsWith(theme.fgSequence("error")), "warning severity must not render red");
	});

	it("colors an error diagnostic red", () => {
		const theme = clioTheme();
		const line = runtimeResolutionDiagnosticLine(
			{ severity: "error", code: "model-not-configured", message: "no model" },
			60,
		);
		ok(line.startsWith(theme.fgSequence("error")), "error severity renders in the red error token");
	});

	it("maps severity to a stable semantic token", () => {
		strictEqual(diagnosticSeverityToken("error"), "error");
		strictEqual(diagnosticSeverityToken("warning"), "warning");
		strictEqual(diagnosticSeverityToken("info"), "muted");
	});
});
