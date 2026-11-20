/** Type-only boot contract kept outside the heavyweight orchestrator graph. */

import type { ScriptedAnswers } from "../cli/run-answers.js";
import type { ClioSettings } from "../core/config.js";
import type { SessionToolLimits } from "../core/tool-limit-flags.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import type { ThinkingLevel } from "../domains/providers/index.js";
import type { SessionVerifier } from "../domains/safety/finish-contract.js";
import type { AutonomyLevel } from "../domains/safety/index.js";
import type { HeadlessCompactionRequest } from "../domains/session/headless-compact.js";
import type { AcpHandshake } from "../engine/acp/server.js";
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
	/** Time left before the limit, so post-turn work never runs past `--timeout`. */
	remainingMs?(): number;
}

/** The session an interactive boot opens on: one id, the latest with a model turn, or the `/resume` picker. */
export type StartupResume =
	| { kind: "id"; id: string; fork?: boolean }
	| { kind: "latest"; fork?: boolean }
	| { kind: "picker" };

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
	/** Set when the launch trust card ran: these notices replace the per-file trust notices (S-76). */
	trustCardNotices?: ReadonlyArray<string>;
	/** `--with-panes`: join the current pane host as a guest. */
	panes?: "with";
	/** Global `--autonomy <level>`: a one-session override for the interactive app; settings.yaml is untouched. */
	autonomy?: AutonomyLevel;
	/**
	 * `--allow-tools`/`--delegate-tools` of the interactive session or `clio-coder acp`:
	 * every turn of the session runs under them, as `clio-coder run` runs its one task.
	 */
	toolLimits?: SessionToolLimits;
	/** Global `--session-file <path>` (absolute): the interactive session writes its exit record there. */
	sessionFile?: string;
	/** Global `--max-context-tokens <N>`: the interactive session's planning ceiling, carried like `run`'s flag. */
	maxContextTokens?: number;
	/**
	 * Global `--resume`/`--continue` of the interactive session. `clio-coder` resolves an id or prefix before
	 * boot, so the orchestrator receives the full id; `latest` with nothing to continue starts a fresh session.
	 */
	resume?: StartupResume;
	headless?: {
		/** `run --systemone`: the one setting for this run, an engine name or `off`. */
		systemOne?: string;
		prompt: string;
		constraints?: TurnConstraints;
		images?: ReadonlyArray<ImageContent>;
		workingContextPaths?: ReadonlyArray<string>;
		mode?: "text" | "json";
		jsonEvents?: "full" | "terminal";
		/** The sentence naming a route borrowed for this run only; `--json` carries it as a notice frame. */
		routeNotice?: string;
		target?: string;
		model?: string;
		thinking?: ThinkingLevel;
		autonomy?: AutonomyLevel;
		sampling?: HeadlessSamplingOverrides;
		noSkills?: boolean;
		skillPaths?: ReadonlyArray<string>;
		steerChannel?: string;
		/** `run --resume|--continue`; `fork` branches a new session from it and never writes it (`run --fork`). */
		resumeSession?: { kind: "id"; id: string; fork?: boolean } | { kind: "latest"; fork?: boolean };
		/**
		 * `session compact`: compact the resumed session once and end, sending no turn; `prompt` is unused. The
		 * session is named by `resumeSession`.
		 */
		compact?: HeadlessCompactionRequest;
		/** `run --name`: written as the run's session opens, whether created, resumed or forked. */
		sessionName?: string;
		/** `clio-coder run --fail-on-noop`: a no-op run exits 1 with outcome failed. */
		failOnNoop?: boolean;
		/** `clio-coder run --fail-on-verify`: a failed or timed-out `--verify` check exits 1 (`verify_failed`). */
		failOnVerify?: boolean;
		/** `clio-coder run --on-permission fail`: the first refused ask ends the run with exit 3. */
		onPermission?: "fail";
		/** `clio-coder run --max-cost-usd`: priced spend the run may add on top of what its session already spent. */
		maxCostUsd?: number;
		/** `clio-coder run --timeout`: the armed wall-clock limit for the whole run. */
		deadline?: HeadlessRunDeadline;
		/** `clio-coder run --verify`: the run's own acceptance checks and the limit for each. */
		verify?: { checks: ReadonlyArray<SessionVerifier>; timeoutMs: number };
		/**
		 * `clio-coder run --answers`: the author's scripted answers. With it the run
		 * registers ask_user and asks extension interviews, answered from the file.
		 */
		answers?: ScriptedAnswers;
	};
	acp?: {
		transport?: AcpJsonRpcPeerTransport;
		handshake?: AcpHandshake;
		onReady?: () => void;
		transportOptions?: StdioServerTransportOptions;
		permissionTimeoutMs?: number;
		/** `clio-coder acp --autonomy`: the most autonomy any hosted session runs at; it lowers settings, never raises them. */
		autonomyCeiling?: "default" | "yolo";
	};
}
