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
 * metadata token so `clio doctor` can find orphans. The one documented
 * exception is Clio's own hosting pane in guest mode, which `reportSelf`
 * writes to under SA-3 of the v0.4.0 cycle plan.
 *
 * What is deliberately absent: per-run viewer panes. The v0.4.0 phase 3/4
 * integration opened a pane per dispatched run in a hidden Fleet tab, with a
 * focus ladder, run-state reporting, and resume adoption keyed on run ids. All
 * of that projected fleet state the native surfaces already show onto panes
 * nobody had asked for. The one run-viewing surface is now the workers-view
 * watch pane (src/interactive/watch-pane.ts): a single utility pane following
 * a selection file, opened on operator demand and retargeted by file writes
 * that never touch this socket.
 */

import type { DomainContract } from "../../core/domain-loader.js";
import type { MuxDetection } from "./detect.js";
import { createDockController, type DockController, type DockSlot, type DockState } from "./dock-controller.js";
import { createPaneRegistry, type MuxPaneRegistry, paneRecord } from "./pane-registry.js";
import { muxSupportsMethod } from "./protocol.js";
import type {
	MuxClient,
	MuxSubscription,
	MuxWorktreeCreatedResult,
	MuxWorktreeCreateRequest,
} from "./socket-client.js";
import {
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
/** Old-host cleanup bridge; ownership readers retain this indefinitely. */
const LEGACY_OWNER_TOKEN_KEY = "clio_owner";
const LEGACY_OWNER_TOKEN_VALUE = "clio:mux";
/** herdr caps a metadata token value at 80 characters. */
const TOKEN_VALUE_MAX = 80;
/** How long `available()` stays false after a transport failure before probing again. */
const DEGRADE_COOLDOWN_MS = 5_000;

export interface MuxOpenUtilityPaneRequest {
	argv: ReadonlyArray<string>;
	cwd: string;
	label: string;
	/** Operator-facing pane title. Omitted when the caller wants the shell default. */
	title?: string;
	purpose?: MuxPanePurpose;
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
	 */
	dock?: { slot: DockSlot; share?: number };
}

export interface MuxNotifyRequest {
	title: string;
	body?: string;
	sound?: MuxNotificationSound;
}

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
	/** Set a dock's share of its axis. False when the slot has no dock or the tier is absent. */
	resizeDock(slot: DockSlot, share: number): Promise<boolean>;
	/** Live dock geometry states, for `/panes` status. */
	docks(): ReadonlyArray<DockState>;
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
			? createDockController({ client, anchorPaneId, log })
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
	const attempt = async <T>(what: string, run: (live: MuxClient) => Promise<T>, fallback: T): Promise<T> => {
		if (!usable() || client === null) return fallback;
		try {
			const value = await run(client);
			healthy = true;
			return value;
		} catch (error) {
			degrade(what, error);
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
				[LEGACY_OWNER_TOKEN_KEY]: LEGACY_OWNER_TOKEN_VALUE,
				...tokens,
			},
		});
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
							...(request.dock.share === undefined ? {} : { share: request.dock.share }),
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
					registry.record(paneRecord(ref, { purpose, label: request.label, openedAt: now() }));
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
					await tagOwner(live, ref.paneId, { role: token(purpose) }, titleSupported ? title : undefined);
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
							paneRecord(ref, { purpose: request.purpose, label: request.label, openedAt: now(), adopted: true }),
						);
						// Crash recovery for a dock: the surviving pane takes the slot back so
						// geometry management resumes instead of a second dock opening.
						if (request.dock && docks) docks.adopt(request.dock, ref);
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

		async resizeDock(slot: DockSlot, share: number): Promise<boolean> {
			if (!docks) return false;
			return await attempt("resizeDock", () => docks.resize(slot, share), false);
		},

		docks(): ReadonlyArray<DockState> {
			return docks?.states() ?? [];
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
