/**
 * The pane layer's cross-domain surface.
 *
 * Every method is best-effort. A mux failure never fails a dispatch, never
 * throws at a caller, and never blocks the event loop on a dead socket: it logs
 * and degrades to `available() === false`, which the consumers read as "use the
 * native fleet surfaces instead". That is why every method here returns a
 * fallback value rather than rejecting.
 *
 * Two ownership rules run through the whole file. Clio acts only on panes it
 * created, tracked in `pane-registry.ts` and tagged with the `clio_coder_owner`
 * metadata token so `clio-coder doctor` can find orphans. The one documented
 * exception is Clio's own hosting pane in guest mode, which `reportSelf`
 * writes to without requiring Clio ownership.
 *
 * Runs are viewed through the workers-view watch pane
 * (src/interactive/watch-pane.ts). This single utility pane follows a selection
 * file, opens on operator demand, and is retargeted by file writes that never
 * touch this socket. Dispatch does not create per-run viewer panes.
 */

import type { DomainContract } from "../../core/domain-loader.js";
import type { MuxDetection } from "./detect.js";
import {
	createDockController,
	type DockController,
	type DockSlot,
	type DockState,
	PARKING_TAB_LABEL,
} from "./dock-controller.js";
import { createPaneRegistry, type MuxPaneRegistry, paneRecord } from "./pane-registry.js";
import { muxSupportsMethod } from "./protocol.js";
import type {
	MuxClient,
	MuxSubscription,
	MuxWorktreeCreatedResult,
	MuxWorktreeCreateRequest,
} from "./socket-client.js";
import {
	type MuxAgentState,
	MuxError,
	type MuxEvent,
	type MuxLog,
	type MuxMode,
	type MuxNotificationSound,
	type MuxPanePurpose,
	type MuxPaneRecord,
	type MuxPaneRef,
	type MuxSelfReport,
} from "./types.js";

/** Metadata source for everything Clio's pane layer writes. */
const METADATA_SOURCE = "clio-coder:mux";
/** Agent-authority source for Clio's own hosting pane, per SA-3. */
const SELF_AGENT_SOURCE = "clio-coder:coder";
/** Token every Clio-created pane carries so orphans are findable. */
const OWNER_TOKEN_KEY = "clio_coder_owner";
const OWNER_TOKEN_VALUE = "clio-coder:mux";
/**
 * The token 0.4 sessions wrote. Clio no longer writes it, but ownership readers
 * keep matching it so a pane an older session left open is still found and
 * cleaned up.
 */
const LEGACY_OWNER_TOKEN_KEY = "clio_owner";
const LEGACY_OWNER_TOKEN_VALUE = "clio:mux";
/** herdr caps a metadata token value at 80 characters. */
const TOKEN_VALUE_MAX = 80;
/** How long `available()` stays false after a transport failure before probing again. */
const DEGRADE_COOLDOWN_MS = 5_000;

export type MuxPaneOpenFailure =
	| { source: "mux"; kind: MuxError["kind"]; wireCode: string | null; method: string | null; message: string }
	| { source: "local"; message: string };

export interface MuxOpenUtilityPaneRequest {
	/** Request-scoped diagnostics; the pane-or-null best-effort result is unchanged. */
	onFailure?: (failure: MuxPaneOpenFailure) => void;
	argv: ReadonlyArray<string>;
	cwd: string;
	label: string;
	/** Operator-facing pane title. Omitted when the caller wants the shell default. */
	title?: string;
	purpose?: MuxPanePurpose;
	/** Opaque file identity (at most 80 characters), persisted for dock adoption. */
	dockKey?: string;
	direction?: "right" | "down";
	env?: Readonly<Record<string, string>>;
	/**
	 * Absolute path the pane's stdout is redirected into. Full-screen programs
	 * such as Yazi reopen `/dev/tty` for their interface when stdout is not a tty.
	 */
	stdoutPath?: string;
	/**
	 * Managed placement: the pane becomes this slot's dock, split from the
	 * anchor with the slot's direction and sized to `share` of the axis
	 * (clamped, cell-floored). Requires the layout tier (protocol 17); below
	 * the floor the request degrades to a plain split and `direction` applies.
	 * `hidden` creates the pane in the session's parking tab instead, so the
	 * layout does not change until `showDock`.
	 */
	dock?: { slot: DockSlot; share?: number; hidden?: boolean };
}

export interface MuxNotifyRequest {
	title: string;
	body?: string;
	sound?: MuxNotificationSound;
}

export const MUX_INTERRUPT_KEYS = ["esc", "ctrl+c"] as const;
export type MuxInterruptKey = (typeof MUX_INTERRUPT_KEYS)[number];

export type MuxPromptOutcome =
	| { status: "sent" }
	/** `unsupported`: the host admits prompts only for agent kinds it supports natively. */
	| { status: "refused"; why: "blocked" | "no-agent" | "not-owned" | "unsupported" }
	| { status: "failed"; reason: string };

export interface MuxContract extends DomainContract {
	readonly mode: MuxMode;
	/** `mode !== "none"` and the socket is currently healthy. */
	available(): boolean;
	/**
	 * The rung detection resolved to, with the socket it answered on and the
	 * protocol recorded from the handshake. `/panes` and `clio-coder doctor`
	 * print it; the notify and worktree paths gate on its protocol.
	 */
	detection(): Readonly<MuxDetection>;
	openUtilityPane(request: MuxOpenUtilityPaneRequest): Promise<MuxPaneRef | null>;
	/** Close one Clio-created pane by pane id. Refuses a pane Clio did not create. */
	closePane(paneId: string): Promise<boolean>;
	/** Current pane width from mux geometry; null when it cannot be read. */
	paneWidth(paneId: string): Promise<number | null>;
	/** The recent terminal text of one Clio-created pane, or null when it cannot be read. */
	readPane(paneId: string, lines: number): Promise<{ text: string; truncated: boolean } | null>;
	/**
	 * Submit a prompt to the agent in one Clio-created pane through the host's
	 * own admission, and only through it: a host refusal stays a refusal, and
	 * nothing is typed into the pane by any other route. `refused` carries why.
	 */
	promptPane(paneId: string, text: string): Promise<MuxPromptOutcome>;
	/**
	 * Interrupt whatever is running in one Clio-created pane. The only keys this
	 * layer ever presses on its own are these two, because neither can accept
	 * an approval. False when the pane is not Clio's or the host refused.
	 */
	interruptPane(paneId: string, key: MuxInterruptKey): Promise<boolean>;
	/**
	 * The pane host's view of one Clio-created pane: which agent it recognizes
	 * there, if any, and that agent's state. Null when the pane is gone or the
	 * host could not be asked, which callers must not read as any state at all.
	 */
	paneAgent(
		paneId: string,
		options?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<{ agent: string | null; state: MuxAgentState; tokens: Readonly<Record<string, string>> } | null>;
	/**
	 * Publish, or with null withdraw, one metadata token on Clio's own hosting
	 * pane. The peer inbox id travels this way; a value over the host's 80
	 * character limit is refused here rather than truncated there.
	 */
	advertiseSelfToken(key: string, value: string | null): Promise<boolean>;
	/**
	 * Re-adopt one pane of the given purpose that outlived the process that made
	 * it. A fresh `session.snapshot` is scanned for a pane carrying Clio's owner
	 * token and a matching `role` token; the first hit is recorded and returned.
	 * This is what stops a restarted session's Enter-in-the-workers-view from
	 * opening a second watch pane beside the surviving one.
	 */
	adoptPane(request: { purpose: MuxPanePurpose; label: string; dock?: DockSlot }): Promise<MuxPaneRef | null>;
	/**
	 * Focus one Clio-created pane, switching the user's view to it (pane.focus
	 * moves the focused tab too). Explicit-request only; refuses foreign panes
	 * and servers below the pane.focus floor.
	 */
	focusPane(paneId: string): Promise<boolean>;
	/** Zoom one Clio-created pane on, off, or toggled. Zooming steals focus; same rule as focusPane. */
	zoomPane(paneId: string, mode: "on" | "off" | "toggle"): Promise<boolean>;
	/**
	 * Bring keyboard focus back to Clio's own hosting pane. This is the return
	 * half of every explicit pane interaction: a pick in the files pane, a
	 * toggle that closed a pane the operator was looking at. False outside
	 * guest mode, without an anchor pane, or below the pane.focus floor.
	 */
	focusSelf(): Promise<boolean>;
	/**
	 * Leave zoom on the tab that hosts Clio, so a dock split from the anchor is
	 * visible again. A zoomed tab hides every pane but one; opening or focusing
	 * the files pane behind a zoom would report success for a pane the operator
	 * cannot see. False when nothing was zoomed or the tier is absent.
	 */
	unzoomSelf(): Promise<boolean>;
	/** Live dock geometry states, for `/panes` status. */
	docks(): ReadonlyArray<DockState>;
	/** Whether a slot's dock is in the layout, parked in the hidden tab, or not running. */
	dockVisibility(slot: DockSlot): "visible" | "hidden" | "closed";
	/**
	 * Park a visible dock in the session's parking tab. Its process keeps
	 * running and `showDock` brings it back where it was. True when the dock is
	 * hidden afterwards; failure reasons go to `onFailure`.
	 */
	hideDock(slot: DockSlot, options?: { onFailure?: (failure: MuxPaneOpenFailure) => void }): Promise<boolean>;
	/**
	 * Return a hidden dock to its slot at its remembered share. Leaves zoom only
	 * when herdr refuses the move for it, and never focuses the dock (`focusPane`
	 * is the explicit half). Null when the slot has no dock or the anchor is too small.
	 */
	showDock(slot: DockSlot, options?: { onFailure?: (failure: MuxPaneOpenFailure) => void }): Promise<MuxPaneRef | null>;
	/** End a dock's process for real, visible or hidden. False when the slot is empty. */
	closeDock(slot: DockSlot): Promise<boolean>;
	/**
	 * Close parked docks a dead Clio process left behind in this workspace. A
	 * crash skips `shutdown`, and a parked pane is out of sight, so a hidden
	 * cliamp could otherwise keep playing with nothing on screen. Panes a live
	 * process owns, and docks in the layout where the operator can see them, are
	 * never touched. Returns how many were closed.
	 */
	reapParkedOrphans(): Promise<number>;
	notify(request: MuxNotifyRequest): Promise<void>;
	/** Optional compete storage route. Protocol-gated with a native Git fallback at the caller. */
	worktreeCreate(request: MuxWorktreeCreateRequest): Promise<MuxWorktreeCreatedResult | null>;
	/** Remove a herdr worktree workspace. False tells the caller to use native Git cleanup. */
	worktreeRemove(workspaceId: string, options?: { force?: boolean }): Promise<boolean>;
	/**
	 * Called when a pane Clio owns leaves, whether the user closed it or the
	 * program in it exited. Callers record it and do not reopen: a closed pane
	 * is a decision, not a fault.
	 */
	onPaneGone(handler: (record: MuxPaneRecord) => void): () => void;
	/** Panes Clio created, with their purpose. */
	list(): ReadonlyArray<MuxPaneRecord>;
	/**
	 * Report Clio's own state on its hosting pane (SA-3). Returns false when
	 * there is no pane to report on, which is every mode but guest.
	 */
	reportSelf(report: MuxSelfReport): Promise<boolean>;
	shutdown(): Promise<void>;
}

export interface MuxRuntimeOptions {
	detection: MuxDetection;
	client: MuxClient | null;
	log?: MuxLog;
	now?: () => number;
}

/** The contract plus the lifecycle handles the domain extension drives. */
export interface MuxRuntime {
	contract: MuxContract;
	start(): Promise<void>;
	stop(): Promise<void>;
	/** Test seam: the registry the contract reconciles against. */
	registry: MuxPaneRegistry;
}

/** POSIX single-quoting, so an argv element with spaces or quotes survives the shell. */
function shellQuote(argv: ReadonlyArray<string>): string {
	return argv.map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`).join(" ");
}

function token(value: string | undefined | null): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	return value.length > TOKEN_VALUE_MAX ? value.slice(0, TOKEN_VALUE_MAX) : value;
}

/** `kill(pid, 0)` probes without signalling; EPERM means the process exists under another user. */
function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function hasOwnedPaneToken(tokens: Readonly<Record<string, string>>): boolean {
	return tokens[OWNER_TOKEN_KEY] === OWNER_TOKEN_VALUE || tokens[LEGACY_OWNER_TOKEN_KEY] === LEGACY_OWNER_TOKEN_VALUE;
}

export function createMuxRuntime(options: MuxRuntimeOptions): MuxRuntime {
	const { detection, client } = options;
	const log = options.log ?? ((): void => undefined);
	const now = options.now ?? Date.now;
	const registry = createPaneRegistry();
	const anchorPaneId = detection.self.paneId;
	/**
	 * The managed dock tier needs an anchor to split from and the protocol-17
	 * layout methods to converge with. Absent either, dock requests degrade to
	 * plain utility splits and the rest of the tier answers false/empty.
	 */
	const docks: DockController | null =
		client !== null && anchorPaneId !== null && muxSupportsMethod(detection.server, "layout.export")
			? createDockController({
					client,
					anchorPaneId,
					log,
					...(muxSupportsMethod(detection.server, "pane.zoom")
						? {
								leaveZoom: async () => {
									await client.paneZoom(anchorPaneId, "off");
								},
							}
						: {}),
				})
			: null;

	let healthy = client !== null;
	let probeHealthAt = 0;
	let stopped = false;
	let subscription: MuxSubscription | null = null;
	const paneGoneHandlers = new Set<(record: MuxPaneRecord) => void>();

	const degrade = (what: string, error: unknown): void => {
		const message = error instanceof Error ? error.message : String(error);
		const transport = error instanceof MuxError && (error.kind === "transport" || error.kind === "timeout");
		if (transport) {
			healthy = false;
			probeHealthAt = now() + DEGRADE_COOLDOWN_MS;
		}
		log(transport ? "warning" : "debug", `mux ${what} failed: ${message}`);
	};

	const usable = (): boolean => {
		if (stopped || client === null || detection.mode === "none") return false;
		return healthy || now() >= probeHealthAt;
	};

	/**
	 * Runs one mux interaction and swallows everything it can throw. The fallback
	 * is what the caller sees when the pane layer is not there, which is the same
	 * value it sees in `none` mode.
	 */
	const attempt = async <T>(
		what: string,
		run: (live: MuxClient) => Promise<T>,
		fallback: T,
		onError?: (error: unknown) => void,
	): Promise<T> => {
		if (!usable() || client === null) return fallback;
		try {
			const value = await run(client);
			healthy = true;
			return value;
		} catch (error) {
			degrade(what, error);
			onError?.(error);
			return fallback;
		}
	};

	const tagOwner = async (
		live: MuxClient,
		paneId: string,
		tokens: Readonly<Record<string, string | null>>,
		title?: string,
	): Promise<void> => {
		await live.paneReportMetadata({
			paneId,
			source: METADATA_SOURCE,
			...(title === undefined ? {} : { title }),
			tokens: {
				[OWNER_TOKEN_KEY]: OWNER_TOKEN_VALUE,
				...tokens,
			},
		});
	};

	const failureFrom = (error: unknown): MuxPaneOpenFailure =>
		error instanceof MuxError
			? { source: "mux", kind: error.kind, wireCode: error.wireCode, method: error.method, message: error.message }
			: { source: "local", message: error instanceof Error ? error.message : String(error) };

	const reporter =
		(onFailure: ((failure: MuxPaneOpenFailure) => void) | undefined) =>
		(failure: MuxPaneOpenFailure): void => {
			try {
				onFailure?.(failure);
			} catch {
				// Diagnostics must not break the best-effort contract.
			}
		};

	/**
	 * Carries a registry record to the pane's post-move identity. Idempotent: the
	 * `pane.moved` push and the move's own response both land here, in either order.
	 */
	const followMove = (previousPaneId: string, ref: MuxPaneRef): void => {
		const held = registry.forget(previousPaneId) ?? registry.byPaneId(ref.paneId);
		if (held) registry.record({ ...held, ref: { ...ref, workspaceId: ref.workspaceId || held.ref.workspaceId } });
	};

	const onEvent = (event: MuxEvent): void => {
		if (event.kind === "layout.updated") {
			docks?.noteLayoutUpdated(event.geometry);
			return;
		}
		if (event.kind === "pane.moved") {
			// herdr rewrites the pane id on a move; the registry and dock state
			// follow it so ownership is not lost to the user reorganizing.
			const held = registry.forget(event.previousPaneId);
			if (held) {
				registry.record({ ...held, ref: { paneId: event.paneId, tabId: event.tabId, workspaceId: event.workspaceId } });
				docks?.notePaneMoved(event.previousPaneId, event.paneId, event.tabId);
			}
			return;
		}
		docks?.notePaneGone(event.paneId);
		const dropped = registry.forget(event.paneId);
		if (dropped) {
			log("debug", `mux pane ${event.paneId} left on ${event.kind}; dropped from the registry`);
			for (const handler of paneGoneHandlers) {
				try {
					handler(dropped);
				} catch (error) {
					log("debug", `mux pane-gone handler threw: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	};

	const contract: MuxContract = {
		mode: detection.mode,

		available(): boolean {
			return usable();
		},

		detection(): Readonly<MuxDetection> {
			return detection;
		},

		async openUtilityPane(request: MuxOpenUtilityPaneRequest): Promise<MuxPaneRef | null> {
			const report = reporter(request.onFailure);
			// Idempotence for docks: a slot that already has a pane answers with it.
			const dockSlot = request.dock?.slot;
			if (dockSlot && docks) {
				const existing = docks.stateFor(dockSlot);
				const held = existing ? registry.byPaneId(existing.paneId) : null;
				if (held) return held.ref;
			}
			return await attempt(
				"openUtilityPane",
				async (live) => {
					let ref: MuxPaneRef;
					if (request.dock && docks) {
						const placed = await docks.open(request.dock.slot, {
							onRefused: (message) => report({ source: "local", message }),
							...(request.dock.share === undefined ? {} : { share: request.dock.share }),
							...(request.dock.hidden ? { hidden: true } : {}),
							cwd: request.cwd,
							...(request.env ? { env: request.env } : {}),
						});
						// A refusal (anchor too small) is an answer, not a failure.
						if (placed === null) return null;
						ref = placed;
					} else {
						const anchor = anchorPaneId ?? (await live.paneCurrent()).paneId;
						const pane = await live.paneSplit({
							direction: request.direction ?? "right",
							targetPaneId: anchor,
							cwd: request.cwd,
							focus: false,
							...(request.env ? { env: request.env } : {}),
						});
						ref = { paneId: pane.paneId, tabId: pane.tabId, workspaceId: pane.workspaceId };
					}
					const purpose = request.purpose ?? "utility";
					registry.record(
						paneRecord(ref, {
							purpose,
							label: request.label,
							openedAt: now(),
							...(request.dockKey === undefined ? {} : { dockKey: request.dockKey }),
						}),
					);
					const title = request.title;
					const titleSupported = title !== undefined && muxSupportsMethod(detection.server, "pane.rename");
					if (titleSupported) {
						try {
							await live.paneRename(ref.paneId, title);
						} catch {
							// Presentation is optional. A server that advertises the floor but
							// lacks or refuses rename must not strand an otherwise healthy pane.
						}
					}
					// The `role` token is what adoptPane finds again after a restart.
					await tagOwner(
						live,
						ref.paneId,
						{
							role: token(purpose),
							...(request.dockKey === undefined ? {} : { dock_key: token(request.dockKey) }),
							// The pid lets a later session tell a parked orphan from a live session's dock.
							...(request.dock ? { dock: token(request.dock.slot), pid: token(String(process.pid)) } : {}),
						},
						titleSupported ? title : undefined,
					);
					if (request.argv.length > 0) {
						// herdr has no argv parameter on pane.split, so the command goes in
						// through the pane's shell. `exec` replaces the shell so the pane
						// exits with the program and emits pane.exited for reconciliation.
						const redirect = request.stdoutPath ? ` > ${shellQuote([request.stdoutPath])}` : "";
						await live.paneSendText(ref.paneId, `exec ${shellQuote(request.argv)}${redirect}\n`);
					}
					return ref;
				},
				null,
				(error) => report(failureFrom(error)),
			);
		},

		async closePane(paneId: string): Promise<boolean> {
			// The ownership rule, restated for the operator-facing path: `/panes
			// close` addresses panes by id and must refuse anything the registry
			// does not hold.
			if (!registry.owns(paneId)) return false;
			return await attempt(
				"closePane",
				async (live) => {
					await live.paneClose(paneId);
					registry.forget(paneId);
					// Dock state must fall with the registry entry, not ride on the async
					// pane.closed push: if the event subscription failed at start(), no
					// push ever comes, and a slot pointing at a dead pane makes every
					// later dock open return the corpse.
					docks?.notePaneGone(paneId);
					return true;
				},
				false,
			);
		},

		// The methods below are how the model drives a peer it handed off to.
		// They carry the same ownership rule as `closePane`: a pane the registry
		// does not hold is never read from or typed into.
		async paneWidth(paneId: string): Promise<number | null> {
			if (!registry.owns(paneId)) return null;
			return await attempt(
				"paneWidth",
				async (live) => {
					const geometry = await live.paneLayout(paneId);
					return geometry.panes.find((pane) => pane.paneId === paneId)?.rect.width ?? null;
				},
				null,
			);
		},

		async readPane(paneId: string, lines: number): Promise<{ text: string; truncated: boolean } | null> {
			if (!registry.owns(paneId)) return null;
			return await attempt(
				"readPane",
				async (live) => {
					const read = await live.paneRead({ paneId, lines });
					return { text: read.text, truncated: read.truncated };
				},
				null,
			);
		},

		async promptPane(paneId: string, text: string): Promise<MuxPromptOutcome> {
			if (!registry.owns(paneId)) return { status: "refused", why: "not-owned" };
			if (!usable() || client === null) return { status: "failed", reason: "the pane host is not reachable" };
			try {
				await client.agentPrompt(paneId, text);
				healthy = true;
				return { status: "sent" };
			} catch (error) {
				// The host's refusals are answers, not faults, and must not degrade
				// the pane layer the way a dead socket does. None of them is worked
				// around: `agent_not_ready` is what herdr answers for an agent kind it
				// does not support natively, which includes a second Clio (measured
				// on 0.9.3; `agent.start` rejects the kind at 0.7.5 and 0.9.3 alike),
				// and typing the text in by another route would be Clio deciding to
				// admit what the host declined.
				if (error instanceof MuxError && error.kind === "agent_blocked") return { status: "refused", why: "blocked" };
				if (error instanceof MuxError && error.kind === "not_found") return { status: "refused", why: "no-agent" };
				if (error instanceof MuxError && error.wireCode === "agent_not_ready") {
					return { status: "refused", why: "unsupported" };
				}
				degrade("promptPane", error);
				return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
			}
		},

		async interruptPane(paneId: string, key: MuxInterruptKey): Promise<boolean> {
			if (!registry.owns(paneId) || !MUX_INTERRUPT_KEYS.includes(key)) return false;
			return await attempt(
				"interruptPane",
				async (live) => {
					await live.paneSendKeys(paneId, [key]);
					return true;
				},
				false,
			);
		},

		async paneAgent(
			paneId: string,
			options: { timeoutMs?: number; signal?: AbortSignal } = {},
		): Promise<{ agent: string | null; state: MuxAgentState; tokens: Readonly<Record<string, string>> } | null> {
			const ref = registry.list().find((record) => record.ref.paneId === paneId)?.ref;
			if (ref === undefined || !usable() || client === null) return null;
			try {
				const pane = (await client.paneList(ref.workspaceId, options)).find((candidate) => candidate.paneId === paneId);
				healthy = true;
				return pane === undefined ? null : { agent: pane.agent, state: pane.agentState, tokens: pane.tokens };
			} catch (error) {
				// A cancelled request says nothing about the host's health.
				if (!(error instanceof MuxError && error.kind === "aborted")) degrade("paneAgent", error);
				return null;
			}
		},

		async adoptPane(request: { purpose: MuxPanePurpose; label: string; dock?: DockSlot }): Promise<MuxPaneRef | null> {
			const existing = registry.byPurpose(request.purpose);
			if (existing) return existing.ref;
			return await attempt(
				"adoptPane",
				async (live) => {
					const snapshot = await live.snapshot();
					for (const pane of snapshot.panes) {
						if (!hasOwnedPaneToken(pane.tokens)) continue;
						if (pane.tokens.role !== request.purpose) continue;
						if (registry.owns(pane.paneId)) continue;
						// Another workspace's pane belongs to another session's screen;
						// adopting it would retarget a surface the operator cannot see.
						if (detection.self.workspaceId !== null && pane.workspaceId !== detection.self.workspaceId) continue;
						const ref: MuxPaneRef = { paneId: pane.paneId, tabId: pane.tabId, workspaceId: pane.workspaceId };
						registry.record(
							paneRecord(ref, {
								purpose: request.purpose,
								label: request.label,
								openedAt: now(),
								adopted: true,
								...(pane.tokens.dock_key ? { dockKey: pane.tokens.dock_key } : {}),
							}),
						);
						// Crash recovery for a dock: the surviving pane takes the slot back so
						// geometry management resumes instead of a second dock opening.
						if (request.dock && docks) {
							// A survivor outside Clio's own tab was parked by the session that died.
							const parked = detection.self.tabId !== null && ref.tabId !== detection.self.tabId;
							docks.adopt(request.dock, ref, { hidden: parked });
						}
						log("info", `mux adopted a ${request.purpose} pane left open by a previous session`);
						return ref;
					}
					return null;
				},
				null,
			);
		},

		async focusPane(paneId: string): Promise<boolean> {
			// Ownership first: focusing the user's own panes stays off the table
			// even though the wire allows it.
			if (!registry.owns(paneId)) return false;
			if (!muxSupportsMethod(detection.server, "pane.focus")) return false;
			return await attempt(
				"focusPane",
				async (live) => {
					await live.paneFocus(paneId);
					return true;
				},
				false,
			);
		},

		async zoomPane(paneId: string, mode: "on" | "off" | "toggle"): Promise<boolean> {
			if (!registry.owns(paneId)) return false;
			if (!muxSupportsMethod(detection.server, "pane.zoom")) return false;
			return await attempt(
				"zoomPane",
				async (live) => {
					const result = await live.paneZoom(paneId, mode);
					// A toggle always changes state; on/off report false when already there.
					return result.changed;
				},
				false,
			);
		},

		async focusSelf(): Promise<boolean> {
			if (anchorPaneId === null || !muxSupportsMethod(detection.server, "pane.focus")) return false;
			return await attempt(
				"focusSelf",
				async (live) => {
					await live.paneFocus(anchorPaneId);
					return true;
				},
				false,
			);
		},

		async unzoomSelf(): Promise<boolean> {
			if (anchorPaneId === null || !muxSupportsMethod(detection.server, "pane.zoom")) return false;
			return await attempt(
				"unzoomSelf",
				async (live) => {
					const result = await live.paneZoom(anchorPaneId, "off");
					return result.changed;
				},
				false,
			);
		},

		docks(): ReadonlyArray<DockState> {
			return docks?.states() ?? [];
		},

		dockVisibility(slot: DockSlot): "visible" | "hidden" | "closed" {
			const state = docks?.stateFor(slot);
			if (!state) return "closed";
			return state.hidden ? "hidden" : "visible";
		},

		async hideDock(slot: DockSlot, hideOptions = {}): Promise<boolean> {
			const before = docks?.stateFor(slot);
			if (!docks || !before) return false;
			if (before.hidden) return true;
			if (!muxSupportsMethod(detection.server, "pane.move")) return false;
			const report = reporter(hideOptions.onFailure);
			return await attempt(
				"hideDock",
				async () => {
					const hidden = await docks.hide(slot);
					const after = docks.stateFor(slot);
					if (after) followMove(before.paneId, { paneId: after.paneId, tabId: after.tabId, workspaceId: "" });
					if (!hidden) report({ source: "local", message: `the pane host did not move the ${slot} dock out of the layout` });
					return hidden;
				},
				false,
				(error) => report(failureFrom(error)),
			);
		},

		async showDock(slot: DockSlot, showOptions = {}): Promise<MuxPaneRef | null> {
			const before = docks?.stateFor(slot);
			if (!docks || !before) return null;
			if (!before.hidden) return { paneId: before.paneId, tabId: before.tabId, workspaceId: "" };
			if (!muxSupportsMethod(detection.server, "pane.move")) return null;
			const report = reporter(showOptions.onFailure);
			return await attempt(
				"showDock",
				async () => {
					const ref = await docks.show(slot, { onRefused: (message) => report({ source: "local", message }) });
					if (ref !== null) followMove(before.paneId, ref);
					return ref;
				},
				null,
				(error) => report(failureFrom(error)),
			);
		},

		async closeDock(slot: DockSlot): Promise<boolean> {
			const state = docks?.stateFor(slot);
			if (!state) return false;
			return await contract.closePane(state.paneId);
		},

		async reapParkedOrphans(): Promise<number> {
			return await attempt(
				"reapParkedOrphans",
				async (live) => {
					const snapshot = await live.snapshot();
					const parkedTabs = new Set(
						snapshot.tabs
							.filter((tab) => tab.label === PARKING_TAB_LABEL && tab.workspaceId === detection.self.workspaceId)
							.map((tab) => tab.tabId),
					);
					let reaped = 0;
					for (const pane of snapshot.panes) {
						if (!parkedTabs.has(pane.tabId) || !hasOwnedPaneToken(pane.tokens) || registry.owns(pane.paneId)) continue;
						const owner = Number(pane.tokens.pid);
						if (!pane.tokens.dock || !Number.isInteger(owner) || owner <= 0 || processIsAlive(owner)) continue;
						await live.paneClose(pane.paneId).catch(() => undefined);
						reaped += 1;
					}
					if (reaped > 0) log("info", `mux closed ${reaped} parked dock(s) left behind by a Clio process that exited`);
					return reaped;
				},
				0,
			);
		},

		async notify(request: MuxNotifyRequest): Promise<void> {
			if (!muxSupportsMethod(detection.server, "notification.show")) {
				log("debug", `mux notify skipped, server protocol is below the notification.show floor: ${request.title}`);
				return;
			}
			await attempt(
				"notify",
				async (live) => {
					const result = await live.notificationShow({
						title: request.title,
						...(request.body ? { body: request.body } : {}),
						...(request.sound ? { sound: request.sound } : {}),
					});
					// A suppressed toast is the operator's own herdr config talking
					// (disabled, rate limited, no foreground client). Reporting it as a
					// warning would turn their setting into Clio's error.
					if (!result.shown) log("debug", `mux notify not shown (${result.reason}): ${request.title}`);
					return undefined;
				},
				undefined,
			);
		},

		async worktreeCreate(request: MuxWorktreeCreateRequest): Promise<MuxWorktreeCreatedResult | null> {
			if (!muxSupportsMethod(detection.server, "worktree.create")) {
				log("debug", "mux worktree.create skipped, server protocol is below the worktree floor");
				return null;
			}
			return await attempt("worktreeCreate", (live) => live.worktreeCreate(request), null);
		},

		async worktreeRemove(workspaceId: string, removeOptions = {}): Promise<boolean> {
			if (!muxSupportsMethod(detection.server, "worktree.remove")) {
				log("debug", "mux worktree.remove skipped, server protocol is below the worktree floor");
				return false;
			}
			return await attempt(
				"worktreeRemove",
				async (live) => {
					await live.worktreeRemove(workspaceId, removeOptions);
					return true;
				},
				false,
			);
		},

		onPaneGone(handler: (record: MuxPaneRecord) => void): () => void {
			paneGoneHandlers.add(handler);
			return () => {
				paneGoneHandlers.delete(handler);
			};
		},

		list(): ReadonlyArray<MuxPaneRecord> {
			return registry.list();
		},

		async advertiseSelfToken(key: string, value: string | null): Promise<boolean> {
			const paneId = detection.self.paneId;
			if (detection.mode !== "guest" || !paneId) return false;
			if (value !== null && value.length > 80) return false;
			return await attempt(
				"advertiseSelfToken",
				async (live) => {
					await live.paneReportMetadata({ paneId, source: METADATA_SOURCE, tokens: { [key]: value } });
					return true;
				},
				false,
			);
		},

		async reportSelf(report: MuxSelfReport): Promise<boolean> {
			const paneId = detection.self.paneId;
			if (detection.mode !== "guest" || !paneId) return false;
			return await attempt(
				"reportSelf",
				async (live) => {
					await live.paneReportAgent({
						paneId,
						source: SELF_AGENT_SOURCE,
						agent: "clio-coder",
						state: report.state,
						...(report.message ? { message: report.message } : {}),
						// No sequence number, on purpose. herdr keeps a high-water mark
						// per source that survives a release, and once a source has sent
						// one it drops every report that carries none or a lower one
						// (measured on 0.7.5 and 0.9.3). A counter that restarts with the
						// process would therefore lock a restarted Clio out of its own
						// pane. Ordering needs no number here: these reports are sent one
						// at a time on an awaited chain, and a Clio that has exited has no
						// request in flight to arrive late.
					});
					if (report.tokens || report.stateLabels || report.ttlMs !== undefined) {
						await live.paneReportMetadata({
							paneId,
							source: METADATA_SOURCE,
							...(report.tokens ? { tokens: report.tokens } : {}),
							...(report.stateLabels ? { stateLabels: report.stateLabels } : {}),
							...(report.ttlMs !== undefined ? { ttlMs: report.ttlMs } : {}),
						});
					}
					return true;
				},
				false,
			);
		},

		async shutdown(): Promise<void> {
			if (stopped) return;
			stopped = true;
			subscription?.close();
			subscription = null;
			paneGoneHandlers.clear();
			// Docks close with the session: a native application takes its windows
			// with it. A crash never reaches this method, which is exactly what
			// leaves dock panes behind for the next session's adoption path.
			// Unmanaged utility panes are the operator's and stay open.
			if (client && docks) {
				for (const paneId of docks.paneIds()) {
					await client.paneClose(paneId).catch(() => undefined);
					registry.forget(paneId);
				}
				docks.clear();
			}
			if (client) await client.close().catch(() => undefined);
		},
	};

	const start = async (): Promise<void> => {
		if (detection.mode === "none" || client === null) return;
		try {
			const kinds: ("pane.closed" | "pane.exited" | "pane.moved" | "layout.updated")[] = ["pane.closed", "pane.exited"];
			if (docks) kinds.push("pane.moved", "layout.updated");
			subscription = await client.subscribe(kinds, onEvent, {
				onResync: (snapshot) => {
					// A reconnect means events were missed. The snapshot is the authority
					// on which panes still exist, so anything Clio thinks it owns that is
					// absent from it is gone.
					const dropped = registry.reconcile(snapshot.panes.map((pane) => pane.paneId));
					for (const record of dropped) docks?.notePaneGone(record.ref.paneId);
					if (dropped.length > 0) {
						log("info", `mux reconciled ${dropped.length} pane(s) closed while the socket was down`);
					}
				},
			});
		} catch (error) {
			degrade("event subscription", error);
		}
	};

	return { contract, start, stop: contract.shutdown, registry };
}
