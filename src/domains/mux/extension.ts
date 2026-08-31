/**
 * Domain wiring for the pane layer.
 *
 * `createExtension` runs the detection ladder once at boot. With `HERDR_ENV`
 * unset that costs nothing: no socket is opened, the contract resolves to
 * `none`, and every consumer degrades to the native fleet surfaces. Detection
 * failures are never fatal, so a wedged herdr server delays boot by at most the
 * one-second ping budget per socket candidate.
 */

import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { createMuxRuntime, type MuxContract, type MuxRuntimeOptions } from "./contract.js";
import { detectMux, type MuxEnablement } from "./detect.js";
import type { MuxLog } from "./types.js";

export interface MuxDomainOptions {
	/** `off` skips detection entirely; `embedded` degrades to `none` until phase 5. */
	enabled?: MuxEnablement;
	env?: NodeJS.ProcessEnv;
	log?: MuxLog;
	cwd?: string;
	viewerCommand?: MuxRuntimeOptions["viewerCommand"];
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

	const runtime = createMuxRuntime({
		detection,
		client,
		log,
		...(options.cwd ? { cwd: options.cwd } : {}),
		...(options.viewerCommand ? { viewerCommand: options.viewerCommand } : {}),
	});

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
