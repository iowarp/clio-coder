/**
 * Domain wiring for the pane layer.
 *
 * `createExtension` runs the detection ladder once at boot. This module only
 * loads on a `--with-panes` boot (src/entry/with-panes.ts), so a plain session
 * never reaches this code at all; within an active session, detection failures
 * are never fatal, and a wedged herdr server delays boot by at most the
 * one-second ping budget per socket candidate.
 */

import type { OutputStyle } from "../../core/defaults.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { createMuxRuntime, type MuxContract } from "./contract.js";
import { detectMux, type MuxEnablement } from "./detect.js";
import type { MuxLog } from "./types.js";

export interface MuxDomainOptions {
	/** `off` skips detection; `auto` runs the guest ladder. */
	enabled?: MuxEnablement;
	env?: NodeJS.ProcessEnv;
	log?: MuxLog;
	/**
	 * Registers a listener for session-only output style changes. Sessions are
	 * created lazily, so `config.session_changed` stays silent until the first
	 * prompt; the host reports every session-scope toggle through this seam.
	 */
	onSessionOutputStyle?: (listener: (style: OutputStyle) => void) => void;
}

export async function createMuxBundle(
	context: DomainContext,
	options: MuxDomainOptions = {},
): Promise<DomainBundle<MuxContract>> {
	const log = options.log ?? ((): void => undefined);
	const { detection, client } = await detectMux({
		...(options.enabled ? { enabled: options.enabled } : {}),
		...(options.env ? { env: options.env } : {}),
		log,
	});
	// A `none` that nobody asked for is background noise and stays at debug. A
	// refusal is the operator's own setting being turned down, so it goes to
	// `warning`, which the orchestrator routes to boot stderr.
	log(
		detection.refused ? "warning" : detection.mode === "none" ? "debug" : "info",
		detection.refused ? `panes refused: ${detection.reason}` : `mux mode ${detection.mode}: ${detection.reason}`,
	);

	const runtime = createMuxRuntime({ detection, client, log });

	// Inside Clio's own pane host, its chrome follows the output style. The
	// style is read from each change rather than at boot, so a session-only
	// toggle and a saved edit both land.
	let appliedStyle: OutputStyle | null = null;
	const followOutputStyle = (payload: unknown): void => {
		applyOutputStyle(
			(payload as { settings?: { interface?: { outputDetail?: OutputStyle } } } | null)?.settings?.interface?.outputDetail,
		);
	};
	const applyOutputStyle = (style: OutputStyle | undefined): void => {
		if (client === null || detection.mode !== "guest" || style === undefined || style === appliedStyle) return;
		const previous = appliedStyle;
		appliedStyle = style;
		void import("./workspace/config.js")
			.then(({ reloadHostChrome }) =>
				reloadHostChrome(style, () => client.serverReloadConfig(), options.env ?? process.env),
			)
			.catch((error: unknown) => {
				appliedStyle = previous;
				log("debug", `pane host chrome not reloaded: ${error instanceof Error ? error.message : String(error)}`);
			});
	};
	const unsubscribers: Array<() => void> = [];
	let started = false;
	options.onSessionOutputStyle?.((style) => {
		if (started) applyOutputStyle(style);
	});

	const extension: DomainExtension = {
		async start(): Promise<void> {
			await runtime.start();
			unsubscribers.push(
				context.bus.subscribe("config.hot_reloaded", followOutputStyle),
				context.bus.subscribe("config.session_changed", followOutputStyle),
			);
			started = true;
		},
		async stop(): Promise<void> {
			started = false;
			for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
			await runtime.stop();
		},
	};

	return { extension, contract: runtime.contract };
}
