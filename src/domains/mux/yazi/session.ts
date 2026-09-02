import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { namingCompatibilityEnvironment } from "../../../core/naming-compat.js";
import { clioCacheDir } from "../../../core/xdg.js";
import { findPinnedTool } from "../../toolchain/registry.js";
import { describeResolution, resolveToolBinary, toolStatus } from "../../toolchain/resolve.js";
import type { MuxContract } from "../contract.js";
import type { MuxPaneRef } from "../types.js";
import {
	createYaziEventStream,
	LEGACY_YAZI_PICK_EVENT,
	YAZI_PICK_EVENT,
	YAZI_STREAM_POLL_MS,
	type YaziEvent,
	type YaziEventStream,
} from "./event-stream.js";
import { ensureYaziProfile, type YaziProfile, yaziProfileDir } from "./profile.js";

export type YaziSessionMode = "companion" | "chooser";
export type YaziProfileMode = "managed" | "user";

export interface YaziResolvedBinaries {
	yaziPath: string | null;
	yaPath: string | null;
	missingYaziDetail: string;
}

export interface YaziChooserResult {
	paths: ReadonlyArray<string>;
	cwd: string;
}

export interface YaziSessionSnapshot {
	mode: YaziSessionMode;
	paneId: string;
	paneCwd: string;
	instanceId: string | null;
	lastLineAt: number | null;
	streamPath: string | null;
	chooserPath: string | null;
}

export interface YaziSession {
	readonly mode: YaziSessionMode;
	readonly pane: Readonly<MuxPaneRef>;
	readonly token: string | null;
	readonly profile: Readonly<YaziProfile> | null;
	snapshot(): Readonly<YaziSessionSnapshot>;
	pushCwd(cwd: string): Promise<boolean>;
	close(): Promise<void>;
}

export type YaziSessionOpenResult =
	| { status: "opened"; session: YaziSession }
	| { status: "missing-binary"; binary: "yazi" | "ya"; detail: string }
	| { status: "profile-error"; reason: string }
	| { status: "unavailable"; reason: string };

export interface YaziSessionOptions {
	mux: MuxContract;
	mode: YaziSessionMode;
	profileMode: YaziProfileMode;
	cwd: string;
	/**
	 * Files-dock share of the height. Set by the interactive bridge from
	 * `interface.panes.files.ratio`; absent it, the dock spec's default governs.
	 */
	dockShare?: number;
	onEvent: (event: YaziEvent) => void;
	onChooser: (result: YaziChooserResult) => void;
	onStopped?: (reason: string) => void;
	log?: (level: "debug" | "warning", message: string) => void;
	cacheDir?: string;
	sessionId?: string;
	pickToken?: string;
	pollMs?: number;
	resolveBinaries?: () => YaziResolvedBinaries;
	ensureProfile?: typeof ensureYaziProfile;
	runYa?: (file: string, args: ReadonlyArray<string>, env: Readonly<NodeJS.ProcessEnv>) => Promise<boolean>;
}

export function resolveYaziBinaries(): YaziResolvedBinaries {
	const entry = findPinnedTool("yazi");
	const status = entry ? toolStatus(entry) : null;
	return {
		yaziPath: status?.resolution.binaryPath ?? null,
		yaPath: resolveToolBinary("ya").binaryPath,
		missingYaziDetail: status ? describeResolution(status) : "yazi is not in the pinned tool registry",
	};
}

function runYa(file: string, args: ReadonlyArray<string>, env: Readonly<NodeJS.ProcessEnv>): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn(file, args, { env: { ...env }, stdio: "ignore" });
		child.once("error", () => resolve(false));
		child.once("exit", (code) => resolve(code === 0));
	});
}

function readOptional(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/** Transport files older than this are leftovers of a process that never reached its cleanup. */
export const YAZI_STALE_TRANSPORT_MS = 24 * 60 * 60 * 1000;

/**
 * Drop transport files no live session can own. A crash, a kill, or a
 * release before cleanup existed leaves `.stream`, `.chooser`, and `.cwd`
 * files behind; a day is long past any pane's life, so anything older goes.
 */
export function sweepStaleTransportFiles(sessionsDir: string, now: number = Date.now()): number {
	let removed = 0;
	let entries: string[];
	try {
		entries = readdirSync(sessionsDir);
	} catch {
		return 0;
	}
	for (const name of entries) {
		if (!/\.(stream|chooser|cwd)$/u.test(name)) continue;
		const path = join(sessionsDir, name);
		try {
			if (now - statSync(path).mtimeMs > YAZI_STALE_TRANSPORT_MS) {
				rmSync(path, { force: true });
				removed += 1;
			}
		} catch {
			// A file that vanished between readdir and stat was someone else's to remove.
		}
	}
	return removed;
}

/** Open one mux-hosted Yazi process and own its DDS or chooser-file transport. */
export async function createYaziSession(options: YaziSessionOptions): Promise<YaziSessionOpenResult> {
	const binaries = (options.resolveBinaries ?? resolveYaziBinaries)();
	if (!binaries.yaziPath) {
		return { status: "missing-binary", binary: "yazi", detail: binaries.missingYaziDetail };
	}
	if (options.profileMode === "managed" && !binaries.yaPath) {
		return {
			status: "missing-binary",
			binary: "ya",
			detail: "the Yazi helper `ya` is not available; install the complete pinned Yazi tool",
		};
	}

	const cacheDir = options.cacheDir ?? clioCacheDir();
	const sessionId = options.sessionId ?? randomUUID();
	const sessionsDir = join(cacheDir, "yazi", "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	sweepStaleTransportFiles(sessionsDir);
	const managedProfile =
		options.profileMode === "managed"
			? (options.ensureProfile ?? ensureYaziProfile)({
					yaPath: binaries.yaPath as string,
					yaziPath: binaries.yaziPath,
					profileDir: yaziProfileDir(cacheDir),
				})
			: null;
	if (options.profileMode === "managed" && !managedProfile) {
		return { status: "profile-error", reason: "Clio could not generate a valid managed Yazi profile" };
	}

	const streamPath = join(sessionsDir, `${sessionId}.stream`);
	const chooserPath = join(sessionsDir, `${sessionId}.chooser`);
	const cwdPath = join(sessionsDir, `${sessionId}.cwd`);
	const token = options.mode === "companion" ? (options.pickToken ?? randomUUID()) : null;
	const env: Record<string, string> = {
		...(managedProfile ? { YAZI_CONFIG_HOME: managedProfile.dir } : {}),
		...(token ? namingCompatibilityEnvironment("CLIO_CODER_YAZI_PICK_TOKEN", "CLIO_YAZI_PICK_TOKEN", token) : {}),
	};
	let argv: ReadonlyArray<string>;
	let stdoutPath: string | undefined;
	if (options.mode === "companion") {
		writeFileSync(streamPath, "");
		argv = [
			binaries.yaziPath,
			"--local-events",
			`cd,${YAZI_PICK_EVENT},${LEGACY_YAZI_PICK_EVENT}`,
			"--remote-events",
			`${YAZI_PICK_EVENT},${LEGACY_YAZI_PICK_EVENT}`,
		];
		stdoutPath = streamPath;
	} else {
		writeFileSync(chooserPath, "");
		writeFileSync(cwdPath, "");
		argv = [binaries.yaziPath, options.cwd, "--chooser-file", chooserPath, "--cwd-file", cwdPath];
	}

	// Transport files are per session and worthless once it ends: a pick has
	// already been consumed by the bridge, and a chooser file has been read.
	// Removing them here is what keeps `<cache>/yazi/sessions` from growing by
	// three files per open for the life of the install.
	const removeTransportFiles = (): void => {
		for (const path of [streamPath, chooserPath, cwdPath]) rmSync(path, { force: true });
	};

	const pane = await options.mux.openUtilityPane({
		argv,
		cwd: options.cwd,
		label: "files",
		title: "files",
		// The files dock: split down from the anchor at the configured share.
		// Degrades to a plain split inside the contract when the layout tier is
		// absent.
		dock: { slot: "files", ...(options.dockShare === undefined ? {} : { share: options.dockShare }) },
		...(Object.keys(env).length > 0 ? { env } : {}),
		...(stdoutPath ? { stdoutPath } : {}),
	});
	if (!pane) {
		removeTransportFiles();
		return { status: "unavailable", reason: "the pane host refused to open the files pane" };
	}

	let paneCwd = options.cwd;
	let instanceId: string | null = null;
	let stream: YaziEventStream | null = null;
	let chooserTimer: NodeJS.Timeout | null = null;
	let stopped = false;
	const alive = (): boolean => options.mux.list().some((record) => record.ref.paneId === pane.paneId);
	const stop = (reason: string): void => {
		if (stopped) return;
		stopped = true;
		if (chooserTimer) clearInterval(chooserTimer);
		chooserTimer = null;
		options.onStopped?.(reason);
		removeTransportFiles();
	};

	if (options.mode === "companion") {
		stream = createYaziEventStream({
			path: streamPath,
			isAlive: alive,
			...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
			...(options.log ? { log: options.log } : {}),
			onEvent: (event) => {
				if (event.kind === "cd") {
					paneCwd = event.cwd;
					instanceId = event.sender;
				}
				options.onEvent(event);
			},
		});
		void stream.done.then((reason) => {
			// A stream that ended on its own means the pane is gone or the file
			// was lost; either way the session is over and says so.
			stop(reason);
		});
	} else {
		const pollChooser = (): void => {
			if (stopped || alive()) return;
			const raw = readOptional(chooserPath);
			const cwd = readOptional(cwdPath).trim() || paneCwd;
			paneCwd = cwd;
			const paths = raw.length === 0 ? [] : raw.split("\n").filter((path) => path.length > 0);
			options.onChooser({ paths, cwd });
			stop("pane-gone");
		};
		chooserTimer = setInterval(pollChooser, options.pollMs ?? YAZI_STREAM_POLL_MS);
		chooserTimer.unref();
	}

	const session: YaziSession = {
		mode: options.mode,
		pane,
		token,
		profile: managedProfile,
		snapshot: () => ({
			mode: options.mode,
			paneId: pane.paneId,
			paneCwd,
			instanceId,
			lastLineAt: stream?.stats().lastLineAt ?? null,
			streamPath: options.mode === "companion" ? streamPath : null,
			chooserPath: options.mode === "chooser" ? chooserPath : null,
		}),
		async pushCwd(cwd: string): Promise<boolean> {
			if (!instanceId || !binaries.yaPath) return false;
			const pushed = await (options.runYa ?? runYa)(binaries.yaPath, ["emit-to", instanceId, "cd", cwd], {
				...process.env,
				...(managedProfile ? { YAZI_CONFIG_HOME: managedProfile.dir } : {}),
			});
			return pushed;
		},
		async close(): Promise<void> {
			stream?.stop();
			stop("stopped");
			await options.mux.closePane(pane.paneId);
		},
	};
	return { status: "opened", session };
}
