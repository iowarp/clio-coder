/** Type-only boot contract kept outside the heavyweight orchestrator graph. */

import type { ClioSettings } from "../core/config.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import type { ThinkingLevel } from "../domains/providers/index.js";
import type { AutonomyLevel } from "../domains/safety/index.js";
import type { AcpJsonRpcPeerTransport, StdioServerTransportOptions } from "../engine/acp/transport.js";
import type { ImageContent } from "../engine/types.js";
import type { TerminalLease } from "../interactive/terminal-lease.js";

export interface HeadlessSamplingOverrides {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	frequencyPenalty?: number;
	repeatPenalty?: number;
}

/**
 * The wall-clock limit `clio-coder run --timeout` arms before boot. The CLI owns
 * the timer; on expiry it starts the same coordinated shutdown a SIGTERM does,
 * with exit code 124. The headless turn reads it to seal a timed-out receipt
 * rather than a canceled one, and settles it once the turn has settled so a
 * late expiry cannot contradict a receipt already sealed.
 */
export interface HeadlessRunDeadline {
	readonly seconds: number;
	/** True once the limit elapsed and the deadline started the shutdown. */
	expired(): boolean;
	/** Disarm the timer; a run that settled on its own is no longer bounded. */
	settle(): void;
}

export interface BootOptions {
	/** Interactive demo guidance override for this session. */
	demo?: boolean;
	apiKey?: string;
	noContextFiles?: boolean;
	noSkills?: boolean;
	skillPaths?: ReadonlyArray<string>;
	/** Internal Stage 0 terminal owner; never supplied by ACP/headless callers. */
	terminalLease?: TerminalLease;
	/** Strict effective settings snapshot shared by preflight, Stage 0, and hydration. */
	startupSettings?: Readonly<ClioSettings>;
	/** `--with-panes` / `--no-panes`. The flag beats `panes.enabled` in both directions. */
	panes?: "with" | "without";
	/** Global `--autonomy <level>`: a one-session override for the interactive app; settings.yaml is untouched. */
	autonomy?: AutonomyLevel;
	headless?: {
		prompt: string;
		constraints?: TurnConstraints;
		images?: ReadonlyArray<ImageContent>;
		workingContextPaths?: ReadonlyArray<string>;
		mode?: "text" | "json";
		jsonEvents?: "full" | "terminal";
		target?: string;
		model?: string;
		thinking?: ThinkingLevel;
		autonomy?: AutonomyLevel;
		sampling?: HeadlessSamplingOverrides;
		noSkills?: boolean;
		skillPaths?: ReadonlyArray<string>;
		steerChannel?: string;
		resumeSession?: { kind: "id"; id: string } | { kind: "latest" };
		/** `clio-coder run --fail-on-noop`: a no-op run exits 1 with outcome failed. */
		failOnNoop?: boolean;
		/** `clio-coder run --timeout`: the armed wall-clock limit for the whole run. */
		deadline?: HeadlessRunDeadline;
	};
	acp?: {
		transport?: AcpJsonRpcPeerTransport;
		transportOptions?: StdioServerTransportOptions;
		permissionTimeoutMs?: number;
	};
}
