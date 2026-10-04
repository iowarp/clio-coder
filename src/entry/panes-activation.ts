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
 * `panes.enabled` setting, then the shipped default of `embedded`.
 *
 * `embedded` means Clio hosts its own workspace. The hosting is the launcher's
 * job (src/cli/workspace-launch.ts), which runs before this process would boot
 * and puts Clio in a pane. So by the time this function sees `embedded` there
 * are two cases: Clio is in a pane host, where it joins as a guest like any
 * other, or the launcher stood down (no terminal, tmux, `--no-panes`, a
 * declined download) and this is a plain session that must not pay for panes.
 */

/** Mirrors `MuxEnablement` in src/domains/mux/detect.ts without importing it. */
export type PanesEnablement = "auto" | "embedded" | "off";

export function resolvePanesEnablement(
	flag: "with" | "without" | undefined,
	setting: PanesEnablement | undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
): "auto" | "off" {
	if (flag === "without") return "off";
	if (flag === "with") return "auto";
	// Inside a workspace Clio hosts, the guest layer is on whatever the setting
	// says. The operator accepted that workspace, and a Clio that did not join
	// it would be an anonymous terminal there: no docks, and no state reported
	// to the pane host, which is what tells it this pane is waiting on an
	// approval. The session-name prefix is the one in
	// src/domains/mux/workspace/exit-marker.ts, repeated here because this
	// module must not pull pane code into a plain boot.
	if (env.HERDR_ENV === "1" && /[\\/]sessions[\\/]clio-coder-[^\\/]+[\\/][^\\/]+$/u.test(env.HERDR_SOCKET_PATH ?? "")) {
		return "auto";
	}
	const effective = setting ?? "embedded";
	if (effective === "embedded") return env.HERDR_ENV === "1" ? "auto" : "off";
	return effective;
}
