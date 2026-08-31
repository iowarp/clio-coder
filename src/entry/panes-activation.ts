/**
 * Whether this boot activates the panes extension.
 *
 * The decision is made here, before any panes module loads, because the whole
 * point of the activation model is that a plain boot never pays for the
 * extension: no socket probe, no guest-mode detection, and none of the mux
 * domain's code in the import closure. The orchestrator dynamically imports
 * `src/entry/with-panes.ts` only when this resolves to an active rung, and a
 * built-graph contract test (tests/contracts/instant-shell-import-graph.test.ts)
 * pins that the default boot chunk carries no mux domain code.
 *
 * Precedence: the command-line flag wins in both directions, then the
 * `panes.enabled` setting, then the shipped default of `off`.
 */

/** Mirrors `MuxEnablement` in src/domains/mux/detect.ts without importing it. */
export type PanesEnablement = "auto" | "embedded" | "off";

export function resolvePanesEnablement(
	flag: "with" | "without" | undefined,
	setting: PanesEnablement | undefined,
): PanesEnablement {
	if (flag === "without") return "off";
	if (flag === "with") {
		// `--with-panes` on a settings file that names `embedded` honors the
		// stronger setting; on `off` or absent settings it activates guest
		// detection, which is the flag's promise.
		return setting === "embedded" ? "embedded" : "auto";
	}
	return setting ?? "off";
}
