/**
 * Domain wiring for the pane layer.
 *
 * `createExtension` runs the detection ladder once at boot. This module only
 * loads on a `--with-panes` boot (src/entry/with-panes.ts), so a plain session
 * never reaches this code at all; within an active session, detection failures
 * are never fatal, and a wedged herdr server delays boot by at most the
 * one-second ping budget per socket candidate.
 */

import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { createMuxRuntime, type MuxContract } from "./contract.js";
import { detectMux, type MuxEnablement } from "./detect.js";
import type { MuxLog } from "./types.js";

export interface MuxDomainOptions {
	/** `off` skips detection entirely; `embedded` degrades to `none` until phase 5. */
	enabled?: MuxEnablement;
	env?: NodeJS.ProcessEnv;
	log?: MuxLog;
}

export async function createMuxBundle(
	_context: DomainContext,
	options: MuxDomainOptions = {},
): Promise<DomainBundle<MuxContract>> {
	const log = options.log ?? ((): void => undefined);
	const { detection, client } = await detectMux({
		...(options.enabled ? { enabled: options.enabled } : {}),
		...(options.env ? { env: options.env } : {}),
		log,
	});
	log(detection.mode === "none" ? "debug" : "info", `mux mode ${detection.mode}: ${detection.reason}`);

	const runtime = createMuxRuntime({ detection, client, log });

	const extension: DomainExtension = {
		async start(): Promise<void> {
			await runtime.start();
		},
		async stop(): Promise<void> {
			await runtime.stop();
		},
	};

	return { extension, contract: runtime.contract };
}
