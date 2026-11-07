/**
 * Whether this boot activates the panes extension.
 *
 * The decision is made here, before any panes module loads, because the whole
 * point of the activation model is that a plain boot never pays for the
 * extension: no socket probe, no guest-mode detection, and none of the mux
 * domain's code in the import closure. The orchestrator dynamically imports
 * `src/entry/with-panes.ts` only when this resolves to `auto`, and a
 * built-graph contract test (tests/contracts/instant-shell-import-graph.test.ts)
 * pins that the default boot chunk carries no mux domain code.
 *
 * Hosting is the launcher's job (src/cli/workspace-launch.ts), which runs
 * before this process would boot and puts Clio in a pane of its private host.
 * So by the time this runs there are two cases: Clio is in a pane host (its
 * own, or the operator's herdr when the launcher stood down there), where it
 * joins as a guest, or the launcher stood down outside any host (no terminal,
 * tmux, a failed install) and this is a plain session that must not pay for
 * panes. `--with-panes` asks for the guest layer explicitly.
 */

export function resolvePanesEnablement(
	flag: "with" | undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
): "auto" | "off" {
	if (flag === "with") return "auto";
	return env.HERDR_ENV === "1" ? "auto" : "off";
}
