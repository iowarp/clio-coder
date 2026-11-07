import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { processBirthToken, processIdentityAlive } from "../../../core/process-identity.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { clioCacheDir } from "../../../core/xdg.js";
import { findPinnedTool } from "../../toolchain/registry.js";
import { describeResolution, resolveToolBinary, toolStatus } from "../../toolchain/resolve.js";
import type { MuxContract } from "../contract.js";
import type { MuxPaneRef } from "../types.js";
import { isClioHostSocket } from "../workspace/platform.js";
import { posixHostRuntimeDir } from "../workspace/platform-posix.js";
import {
	createYaziEventStream,
	YAZI_DOCK_EVENT,
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
	/** Where the pane is: in the layout, parked in the hidden tab, or gone. */
	visibility(): "visible" | "hidden" | "closed";
	/** Park the pane out of sight; Yazi keeps running in its directory. Null on success, else why not. */
	hide(): Promise<string | null>;
	/** Put a parked pane back in its slot without focusing it. Null on success, else why not. */
	show(): Promise<string | null>;
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
	/** Start parked in the hidden tab so the layout never changes until the pane is shown. */
	hidden?: boolean;
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

/** Only old ownership records are candidates for crash recovery. Age alone never proves death. */
export const YAZI_STALE_TRANSPORT_MS = 24 * 60 * 60 * 1000;

/** Drop only transport sets whose recorded local owner is demonstrably dead. */
export function sweepStaleTransportFiles(sessionsDir: string, now: number = Date.now()): number {
	let removed = 0;
	let entries: string[];
	try {
		entries = readdirSync(sessionsDir);
	} catch {
		return 0;
	}
	for (const name of entries) {
		if (!name.endsWith(".owner.json")) continue;
		const ownerPath = join(sessionsDir, name);
		try {
			if (now - statSync(ownerPath).mtimeMs <= YAZI_STALE_TRANSPORT_MS) continue;
			const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown> | null;
			if (
				!owner ||
				owner.version !== 1 ||
				typeof owner.host !== "string" ||
				typeof owner.pid !== "number" ||
				!Number.isSafeInteger(owner.pid) ||
				owner.pid <= 0 ||
				!(owner.birthToken === null || typeof owner.birthToken === "string")
			)
				continue;
			if (processIdentityAlive({ host: owner.host, pid: owner.pid, birthToken: owner.birthToken }) !== false) continue;
			const stem = join(sessionsDir, name.slice(0, -".owner.json".length));
			for (const suffix of [".stream", ".chooser", ".cwd"]) {
				if (!existsSync(`${stem}${suffix}`)) continue;
				rmSync(`${stem}${suffix}`, { force: true });
				removed += 1;
			}
			rmSync(ownerPath, { force: true });
		} catch {
			// Unknown owners and files still held open are not ours to reclaim.
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
	const ownerPath = join(sessionsDir, `${sessionId}.owner.json`);
	const token = options.mode === "companion" ? (options.pickToken ?? randomUUID()) : null;
	const socketPath = options.mux.detection().socketPath;
	const runtimeDir =
		process.platform !== "win32" && socketPath && isClioHostSocket(socketPath) ? posixHostRuntimeDir(socketPath) : null;
	const env: Record<string, string> = {
		...(runtimeDir
			? {
					XDG_RUNTIME_DIR: runtimeDir,
					XDG_STATE_HOME: runtimeDir,
					CLIO_CODER_PANE_XDG_STATE_HOME: runtimeDir,
					TMPDIR: runtimeDir,
				}
			: {}),
		...(managedProfile ? { YAZI_CONFIG_HOME: managedProfile.dir } : {}),
		...(token ? { CLIO_CODER_YAZI_PICK_TOKEN: token } : {}),
	};
	let argv: ReadonlyArray<string>;
	let stdoutPath: string | undefined;
	if (options.mode === "companion") {
		writeFileSync(streamPath, "");
		argv = [
			binaries.yaziPath,
			"--local-events",
			`cd,${YAZI_PICK_EVENT},${YAZI_DOCK_EVENT}`,
			"--remote-events",
			`${YAZI_PICK_EVENT},${YAZI_DOCK_EVENT}`,
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
		let removed = true;
		for (const path of [streamPath, chooserPath, cwdPath]) {
			try {
				rmSync(path, { force: true });
			} catch {
				removed = false;
				// Windows refuses while the pane's Yazi still writes the stream; close()
				// tries again once the pane is gone, and the stale sweep after that.
			}
		}
		if (removed) {
			try {
				rmSync(ownerPath, { force: true });
			} catch {
				// A leftover receipt is reclaimed after this owner exits.
			}
		}
	};

	let pane: MuxPaneRef | null;
	try {
		safeResourceWrite(
			ownerPath,
			JSON.stringify({
				version: 1,
				host: hostname(),
				pid: process.pid,
				birthToken: processBirthToken(),
			}),
			{ mode: 0o600 },
		);
		pane = await options.mux.openUtilityPane({
			argv,
			cwd: options.cwd,
			label: "files",
			title: "files",
			// The files dock: split down from the anchor at the configured share.
			// Degrades to a plain split inside the contract when the layout tier is
			// absent.
			dock: {
				slot: "files",
				...(options.dockShare === undefined ? {} : { share: options.dockShare }),
				...(options.hidden ? { hidden: true } : {}),
			},
			...(Object.keys(env).length > 0 ? { env } : {}),
			...(stdoutPath ? { stdoutPath } : {}),
		});
	} catch (error) {
		removeTransportFiles();
		throw error;
	}
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
				...env,
			});
			return pushed;
		},
		visibility: () => options.mux.dockVisibility("files"),
		async hide(): Promise<string | null> {
			let reason: string | null = null;
			const hidden = await options.mux.hideDock("files", {
				onFailure: (failure) => {
					reason = failure.message;
				},
			});
			return hidden ? null : `the files pane did not hide: ${reason ?? "the pane host refused"}`;
		},
		async show(): Promise<string | null> {
			let reason: string | null = null;
			const ref = await options.mux.showDock("files", {
				onFailure: (failure) => {
					reason = failure.message;
				},
			});
			return ref === null ? `the files pane stayed hidden: ${reason ?? "the pane host refused"}` : null;
		},
		async close(): Promise<void> {
			stream?.stop();
			stop("stopped");
			await options.mux.closePane(pane.paneId);
			removeTransportFiles();
		},
	};
	return { status: "opened", session };
}
