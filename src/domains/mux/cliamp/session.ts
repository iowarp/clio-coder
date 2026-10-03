import type { MusicIntegrationSettings } from "../../../core/defaults.js";
import { packageManagerInstallHints } from "../../toolchain/registry.js";
import { describeResolution, installRemedy, resolveToolBinary, toolStatus } from "../../toolchain/resolve.js";
import type { MuxContract } from "../contract.js";
import type { MusicOperations, MusicResult } from "../music-operations.js";
import {
	CLIAMP_PLAYLIST,
	cliampControl,
	cliampEnv,
	cliampHome,
	cliampPaneArgv,
	cliampStatus,
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
 * so `/music` and the tool can say it in one line. The pane is a dock, so it
 * closes with the session. Playback control goes over cliamp's IPC socket in
 * Clio's private cliamp home, never through keystrokes into the pane.
 */
export function createMusicSession(options: MusicSessionOptions): MusicOperations {
	const resolveCliamp = options.resolveCliamp ?? resolveCliampDefault;
	const home = options.home ?? cliampHome();
	// `/music station` lasts for the session, so off and on again resumes it.
	let sessionStation: MusicStation | null = null;

	const paneId = (): string | null => options.mux.docks().find((dock) => dock.slot === "music")?.paneId ?? null;

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

	const open = async (binary: string, station: MusicStation): Promise<MusicResult> => {
		try {
			writeCliampProfile(stationPlaylist(station), home);
		} catch (err) {
			return {
				status: "failed",
				reason: `could not write the cliamp profile: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		let refusal: string | null = null;
		const ref = await options.mux.openUtilityPane({
			argv: cliampPaneArgv(binary),
			cwd: options.getCwd(),
			label: PANE_LABEL,
			title: PANE_LABEL,
			env: cliampEnv(home),
			dock: { slot: "music" },
			onFailure: (failure) => {
				refusal = failure.message;
			},
		});
		if (ref === null)
			return { status: "failed", reason: `the music pane did not open: ${refusal ?? "the pane host refused"}` };
		return { status: "playing", title: station.title, opened: true };
	};

	const pickStation = async (input?: string): Promise<MusicStation | { error: string }> => {
		if (input !== undefined) return resolveStation(input, options.fetch);
		if (sessionStation !== null) return sessionStation;
		return resolveStation(options.getSettings().station, options.fetch);
	};

	const on = async (): Promise<MusicResult> => {
		const gate = ready();
		if ("result" in gate) return gate.result;
		if (paneId() !== null) {
			// Already open: resume if paused, then say what is on.
			await cliampControl(gate.binary, ["play"], home);
			return playingNow(gate.binary, false);
		}
		const station = await pickStation();
		if ("error" in station) return { status: "failed", reason: station.error };
		return open(gate.binary, station);
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
		on,
		off,
		async toggle(): Promise<MusicResult> {
			return paneId() === null ? on() : off();
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
			if (paneId() === null) return open(gate.binary, station);
			// `load` swaps the running player's playlist and starts its first entry,
			// so the pane keeps its place on screen.
			writeCliampPlaylist(stationPlaylist(station), home);
			const result = await cliampControl(gate.binary, ["load", CLIAMP_PLAYLIST], home);
			if (!result.ok) return { status: "failed", reason: `cliamp load failed: ${result.error}` };
			return { status: "playing", title: station.title, opened: false };
		},
		async status(): Promise<MusicResult> {
			const gate = ready();
			if ("result" in gate) return gate.result;
			if (paneId() === null) return { status: "stopped" };
			return playingNow(gate.binary, false);
		},
	};
}
