/**
 * What System One is doing in this process. Which engine answers is
 * fixed at startup, so choosing one belongs to `clio-coder systemone use`.
 */

import type { ClioSettings } from "../core/config.js";
import { credentialAvailable } from "../domains/providers/credentials.js";
import type { RuntimeLookup } from "../domains/system-one/status.js";
import { describeStatus, formatStatus } from "../domains/system-one/status.js";

export interface SystemOneControl {
	/** The lines to show. Never throws. */
	run(): string[];
}

export function createSystemOneControl(deps: {
	settings: () => Readonly<ClioSettings>;
	runtimes: RuntimeLookup;
	refusedEngines: () => ReadonlyMap<string, string>;
}): SystemOneControl {
	return {
		run: () =>
			formatStatus(
				describeStatus({
					settings: deps.settings(),
					runtimes: deps.runtimes,
					hasCredential: credentialAvailable,
					refusedEngines: deps.refusedEngines(),
				}),
			),
	};
}
