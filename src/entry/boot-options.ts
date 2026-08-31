/** Type-only boot contract kept outside the heavyweight orchestrator graph. */

import type { ClioSettings } from "../core/config.js";
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

export interface BootOptions {
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
	headless?: {
		prompt: string;
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
	};
	acp?: {
		transport?: AcpJsonRpcPeerTransport;
		transportOptions?: StdioServerTransportOptions;
		permissionTimeoutMs?: number;
	};
}
