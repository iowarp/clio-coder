/**
 * `/systemone`: the terminal control over the one setting. Task and session
 * scopes live in this process and the session's ledger; user and project scopes
 * write the settings layers. Choosing an engine that cannot run reports why, and
 * nothing is sent until it can.
 */

import type { ClioSettings } from "../core/config.js";
import { credentialAvailable } from "../domains/providers/credentials.js";
import { createMeasurementReader } from "../domains/system-one/measurement.js";
import type { RuntimeLookup } from "../domains/system-one/recorder/bindings.js";
import type { SystemOneCommand, SystemOneScopes } from "../domains/system-one/scopes.js";
import { SYSTEM_ONE_OFF } from "../domains/system-one/selection.js";
import { describeStatus, formatStatus } from "../domains/system-one/status.js";
import type { SiteId } from "../domains/system-one/types.js";
import { writeSystemOneUse } from "./system-one-settings.js";

export interface SystemOneControl {
	/** The lines to show for this command. Never throws: a refused write is a line. */
	run(command: SystemOneCommand): string[];
}

export const SYSTEM_ONE_SCOPE_ENTRY = "systemOneScope";

export function createSystemOneControl(deps: {
	cwd: () => string;
	settings: () => Readonly<ClioSettings>;
	scopes: SystemOneScopes;
	runtimes: RuntimeLookup;
	recording: () => boolean;
	latencyMs: (site: SiteId) => number | null;
	persistSession: (use: string | null) => void;
}): SystemOneControl {
	const measurements = createMeasurementReader();
	const status = (): string[] => {
		const override = deps.scopes.current();
		return formatStatus(
			describeStatus({
				settings: deps.settings(),
				...(override !== null ? { override } : {}),
				runtimes: deps.runtimes,
				hasCredential: credentialAvailable,
				recording: deps.recording(),
				latencyMs: deps.latencyMs,
				measurements: measurements(),
			}),
		);
	};
	return {
		run(command) {
			if (command.action === "status") return status();
			const use = command.action === "off" ? SYSTEM_ONE_OFF : (command.name ?? "");
			const scope = command.scope ?? "session";
			try {
				if (scope === "task") deps.scopes.set("task", use);
				else if (scope === "session") {
					deps.scopes.set("session", use);
					deps.persistSession(use);
				} else writeSystemOneUse(deps.cwd(), scope, use);
			} catch (error) {
				return [`could not set System One for ${scope}: ${error instanceof Error ? error.message : String(error)}`];
			}
			return [`System One ${command.action === "off" ? "off" : use} for this ${scope}`, ...status()];
		},
	};
}
