import type { MusicIntegrationSettings } from "../../../core/defaults.js";
import { packageManagerInstallHints } from "../../toolchain/registry.js";
import { describeResolution, installRemedy, resolveToolBinary, toolStatus } from "../../toolchain/resolve.js";
import type { MuxContract } from "../contract.js";
import type { MusicDockVisibility, MusicOperations, MusicResult, MusicState } from "../music-operations.js";
import { watchTapFile } from "../tap-file.js";
import {
	CLIAMP_PLAYLIST,
	type CliampControlResult,
	cliampControl,
	cliampEnv,
	cliampHome,
	cliampPaneArgv,
	cliampStatus,
	cliampTapPath,
	trustCliampDockPlugin,
	writeCliampDockPlugin,
	writeCliampPlaylist,
	writeCliampProfile,
} from "./profile.js";
import { type MusicStation, resolveStation, type StationFetch, stationPlaylist } from "./stations.js";

export interface MusicSessionOptions {
	mux: MuxContract;
	getSettings: () => Readonly<MusicIntegrationSettings>;
	getCwd: () => string;
	/** Injection seams for tests; production uses the toolchain ladder and the state root. */
	resolveCliamp?: () => { path: string | null; detail: string };
	home?: string;
	fetch?: StationFetch;
}

const PANE_LABEL = "music";

/** The resolution sentence plus every install command this platform has, never run by Clio. */
function resolveCliampDefault(): { path: string | null; detail: string } {
	const resolution = resolveToolBinary("cliamp");
	if (resolution.binaryPath !== null) return { path: resolution.binaryPath, detail: "" };
	const entry = resolution.entry;
	const found = entry ? describeResolution(toolStatus(entry)) : "cliamp is not in the pinned tool registry";
	const alternatives = packageManagerInstallHints("cliamp").map((hint) => `\`${hint}\``);
	const install = [`\`${installRemedy("cliamp")}\``, ...alternatives].join(", or ");
	return { path: null, detail: `cliamp ${found}; install it yourself with ${install}` };
}

/**
 * The music pane: cliamp in Clio's bottom dock, playing focus radio.
 *
 * Usable only when `integrations.music.enabled` is on, the pane host answers,
 * and cliamp resolves; `unavailableReason` names whichever of those is missing
 * so `/music` and the tool can say it in one line. The pane is a dock: it can
 * be hidden into the parking tab with the player still running, it is ended
 * only by `off` (or a double tap of its key), and it closes with the session.
 * Playback control goes over cliamp's IPC socket in Clio's private cliamp
 * home, never through keystrokes into the pane.
 */
export function createMusicSession(options: MusicSessionOptions): MusicOperations {
	const resolveCliamp = options.resolveCliamp ?? resolveCliampDefault;
	const home = options.home ?? cliampHome();
	// `/music station` lasts for the session, so off and on again resumes it.
	let sessionStation: MusicStation | null = null;
	const dockKeyHandlers = new Set<() => void>();
	let watchingTaps = false;

	const paneId = (): string | null => options.mux.docks().find((dock) => dock.slot === "music")?.paneId ?? null;
	const visibility = (): MusicDockVisibility => options.mux.dockVisibility("music");

	const unavailableReason = (): string | null => {
		const missing: string[] = [];
		if (!options.getSettings().enabled) missing.push("integrations.music.enabled is false in settings.yaml");
		if (!options.mux.available()) {
			missing.push(`herdr panes are not available (${options.mux.detection().reason})`);
		}
		const cliamp = resolveCliamp();
		if (cliamp.path === null) missing.push(cliamp.detail);
		return missing.length === 0 ? null : `music is unavailable: ${missing.join("; ")}`;
	};

	const ready = (): { binary: string } | { result: MusicResult } => {
		const reason = unavailableReason();
		if (reason !== null) return { result: { status: "unavailable", reason } };
		const path = resolveCliamp().path;
		return path === null ? { result: { status: "unavailable", reason: "cliamp did not resolve" } } : { binary: path };
	};

	const playingNow = async (binary: string, opened: boolean): Promise<MusicResult> => {
		const status = await cliampStatus(binary, home);
		return { status: "playing", title: status?.title ?? null, opened };
	};

	/** What the player is doing, as reported, for `status` and the show/hide notices. */
	const actualPlayback = async (binary: string): Promise<{ playing: boolean; title: string | null } | null> => {
		const status = await cliampStatus(binary, home);
		return status === null ? null : { playing: status.state === "playing", title: status.title };
	};

	/**
	 * Start playback from whatever state the player is in. cliamp's IPC `play`
	 * only resumes a paused track; a player that is stopped (a pane prepared
	 * silent at boot, or stopped from inside the pane) starts with `toggle`.
	 */
	const resume = async (binary: string): Promise<CliampControlResult> => {
		const status = await cliampStatus(binary, home);
		if (status === null) {
			return { ok: false, stdout: "", error: "cliamp is not answering yet; the pane may still be starting" };
		}
		if (status.state === "playing") return { ok: true, stdout: "", error: "" };
		return cliampControl(binary, [status.state === "stopped" ? "toggle" : "play"], home);
	};

	const open = async (
		binary: string,
		station: MusicStation,
		mode: { hidden: boolean; play: boolean },
	): Promise<MusicResult> => {
		try {
			writeCliampProfile(stationPlaylist(station), home);
		} catch (err) {
			return {
				status: "failed",
				reason: `could not write the cliamp profile: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		// Alt+A inside the player: a plugin cliamp must be told to trust, and a file
		// Clio watches. Neither is worth failing the pane for; without them the key
		// is simply not bound inside cliamp.
		try {
			if (writeCliampDockPlugin(home)) await trustCliampDockPlugin(binary, home);
			if (!watchingTaps) {
				// Lives as long as the session: it holds no event-loop reference and a
				// reopened pane appends to the same file.
				watchTapFile(cliampTapPath(home), () => {
					for (const handler of dockKeyHandlers) handler();
				});
				watchingTaps = true;
			}
		} catch {
			// The pane works without its in-player key.
		}
		let refusal: string | null = null;
		const ref = await options.mux.openUtilityPane({
			argv: cliampPaneArgv(binary, mode.play),
			cwd: options.getCwd(),
			label: PANE_LABEL,
			title: PANE_LABEL,
			env: cliampEnv(home),
			dock: { slot: "music", ...(mode.hidden ? { hidden: true } : {}) },
			onFailure: (failure) => {
				refusal = failure.message;
			},
		});
		if (ref === null)
			return { status: "failed", reason: `the music pane did not open: ${refusal ?? "the pane host refused"}` };
		return mode.play
			? { status: "playing", title: station.title, opened: true }
			: { status: "paused", title: station.title };
	};

	/** Brings a parked pane back. Null on success or when nothing was parked, else why it stayed hidden. */
	const reveal = async (): Promise<string | null> => {
		if (visibility() !== "hidden") return null;
		let reason: string | null = null;
		const ref = await options.mux.showDock("music", {
			onFailure: (failure) => {
				reason = failure.message;
			},
		});
		return ref === null ? `the music pane stayed hidden: ${reason ?? "the pane host refused"}` : null;
	};

	const pickStation = async (input?: string): Promise<MusicStation | { error: string }> => {
		if (input !== undefined) return resolveStation(input, options.fetch);
		if (sessionStation !== null) return sessionStation;
		return resolveStation(options.getSettings().station, options.fetch);
	};

	const on = async (): Promise<MusicResult> => {
		const gate = ready();
		if ("result" in gate) return gate.result;
		if (visibility() === "closed") {
			const station = await pickStation();
			if ("error" in station) return { status: "failed", reason: station.error };
			return open(gate.binary, station, { hidden: false, play: true });
		}
		const stayed = await reveal();
		if (stayed !== null) return { status: "failed", reason: stayed };
		const resumed = await resume(gate.binary);
		if (!resumed.ok) return { status: "failed", reason: `cliamp could not resume: ${resumed.error}` };
		return playingNow(gate.binary, false);
	};

	const off = async (): Promise<MusicResult> => {
		const id = paneId();
		if (id === null) return { status: "stopped" };
		const binary = resolveCliamp().path;
		// Stop first so the stream ends even if the pane host is slow to close.
		if (binary !== null) await cliampControl(binary, ["stop"], home);
		const closed = await options.mux.closePane(id);
		return closed ? { status: "stopped" } : { status: "failed", reason: `the music pane ${id} did not close` };
	};

	return {
		unavailableReason,
		isOpen: () => paneId() !== null,
		visibility,
		on,
		off,
		async toggle(): Promise<MusicResult> {
			const gate = ready();
			if ("result" in gate) return gate.result;
			const where = visibility();
			if (where === "closed") return on();
			if (where === "hidden") {
				// Revealing is only a change of place; whatever was playing keeps playing.
				const stayed = await reveal();
				if (stayed !== null) return { status: "failed", reason: stayed };
			} else {
				let refusal: string | null = null;
				const hidden = await options.mux.hideDock("music", {
					onFailure: (failure) => {
						refusal = failure.message;
					},
				});
				if (!hidden) {
					return { status: "failed", reason: `the music pane did not hide: ${refusal ?? "the pane host refused"}` };
				}
			}
			const playback = await actualPlayback(gate.binary);
			return {
				status: where === "hidden" ? "shown" : "hidden",
				playing: playback?.playing ?? false,
				title: playback?.title ?? null,
			};
		},
		async pause(): Promise<MusicResult> {
			const gate = ready();
			if ("result" in gate) return gate.result;
			if (paneId() === null) return { status: "stopped" };
			const playback = await actualPlayback(gate.binary);
			if (playback === null)
				return { status: "failed", reason: "cliamp is not answering; the pane may still be starting" };
			if (playback.playing) {
				const result = await cliampControl(gate.binary, ["pause"], home);
				if (!result.ok) return { status: "failed", reason: `cliamp pause failed: ${result.error}` };
			}
			return { status: "paused", title: playback.title };
		},
		async next(): Promise<MusicResult> {
			const gate = ready();
			if ("result" in gate) return gate.result;
			if (paneId() === null) return on();
			const result = await cliampControl(gate.binary, ["next"], home);
			if (!result.ok) return { status: "failed", reason: `cliamp next failed: ${result.error}` };
			return playingNow(gate.binary, false);
		},
		async station(nameOrUrl: string): Promise<MusicResult> {
			const gate = ready();
			if ("result" in gate) return gate.result;
			const station = await pickStation(nameOrUrl);
			if ("error" in station) return { status: "failed", reason: station.error };
			sessionStation = station;
			if (paneId() === null) return open(gate.binary, station, { hidden: false, play: true });
			// `load` swaps the running player's playlist and starts its first entry,
			// so the pane keeps its place on screen, or off it when hidden.
			writeCliampPlaylist(stationPlaylist(station), home);
			const result = await cliampControl(gate.binary, ["load", CLIAMP_PLAYLIST], home);
			if (!result.ok) return { status: "failed", reason: `cliamp load failed: ${result.error}` };
			return { status: "playing", title: station.title, opened: false };
		},
		async status(): Promise<MusicResult> {
			const gate = ready();
			if ("result" in gate) return gate.result;
			if (paneId() === null) return { status: "stopped" };
			const playback = await actualPlayback(gate.binary);
			if (playback === null)
				return { status: "failed", reason: "cliamp is not answering; the pane may still be starting" };
			return playback.playing
				? { status: "playing", title: playback.title, opened: false }
				: { status: "paused", title: playback.title };
		},
		async prepare(): Promise<void> {
			if (visibility() !== "closed") return;
			const gate = ready();
			if ("result" in gate) return;
			const station = await pickStation();
			if ("error" in station) return;
			await open(gate.binary, station, { hidden: true, play: false });
		},
		onDockKey(handler: () => void): () => void {
			dockKeyHandlers.add(handler);
			return () => {
				dockKeyHandlers.delete(handler);
			};
		},
		async state(): Promise<MusicState> {
			const dock = visibility();
			if (dock === "closed") return { dock, playback: null, title: null };
			const binary = resolveCliamp().path;
			const playback = binary === null ? null : await actualPlayback(binary);
			return { dock, playback: playback?.playing ? "playing" : "paused", title: playback?.title ?? null };
		},
	};
}
