import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { isDevVersion } from "../../core/build-info.js";
import { processAlive, processBirthToken } from "../../core/process-identity.js";
import { withStateFileLock, withStateFileLockSync } from "../../core/state-file-lock.js";
import {
	DEFERRED_RUN_MS,
	DEFERRED_WAIT_MS,
	type DeferredTarget,
	deferredUpdateTarget,
	readDeferredResult,
	spawnDeferredUpdate,
} from "./deferred-update.js";
import type { Installation } from "./install-method.js";
import { installationCommand, installerPackageRoot, readInstallerRecord } from "./install-method.js";
import { NATIVE_UPDATE_TIMEOUT_MS, nativeAutoUpdatePolicy, runNativeBackgroundUpdate } from "./native-update.js";
import { compareReleaseVersions, fetchTagVersion, parseReleaseVersion, releaseChannelTags } from "./release-version.js";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
export const UPDATE_NOTICE_INTERVAL_MS = 7 * UPDATE_CHECK_INTERVAL_MS;
/** The installer's own cap plus a grace minute; a lease never outlives a possible run. */
const INSTALL_LEASE_MS = NATIVE_UPDATE_TIMEOUT_MS + 60_000;

/** Dist-tags a check may consult. Pre-releases are published under `beta`, never `latest`. */
type ReleaseTag = "latest" | "beta" | "dev";

interface UpdateCache {
	checkedAt?: number;
	available?: string | null;
	/** Dist-tag that published `available`; absent means `latest`. */
	availableTag?: ReleaseTag;
	/** Dist-tags the cached check consulted, joined by `+`; absent means `latest`. */
	track?: string;
	notifiedKey?: string;
	notifiedAt?: number;
	/**
	 * Lease of the session running a background install (#436). It only
	 * blocks concurrent starts: it is cleared when the run settles and counts
	 * as expired once its pid is gone from this host or INSTALL_LEASE_MS has
	 * passed, so a quit or killed session never leaves a phantom install.
	 */
	updateAttemptedAt?: number;
	updatePid?: number;
	updateHost?: string;
	updateBirth?: string;
	/** Lease length for this holder; a deferred wrapper may wait for sessions before it runs. */
	updateLeaseMs?: number;
	/** Outcome of the newest background install, read by later sessions and `doctor`. */
	lastUpdate?: LastBackgroundUpdate;
	/** A deferred wrapper gave up waiting; `detail` names what held it (pid@host). Not a failure. */
	deferredWait?: DeferredWait;
}

export interface LastBackgroundUpdate {
	at: number;
	from: string;
	to: string;
	ok: boolean;
	exitCode: number | null;
	detail: string;
	/** Set for a deferred package-manager update: who ran it and where it logged. */
	manager?: string;
	log?: string;
	/** The next launch already showed this result. */
	announced?: boolean;
}

export interface UpdateNotice {
	kind: "available" | "replaced" | "failed" | "updated";
	key: string;
	text: string;
	/** An eligible native install the session should start in the background. */
	install?: boolean;
	/** A package-manager install the session should hand to a wrapper when it quits. */
	defer?: boolean;
}

export interface UpdateCheckOptions {
	installation: Installation;
	runningVersion: string;
	cacheDir: string;
	processStartedAt: number;
	now?: () => number;
	backgroundUpdate?: typeof runNativeBackgroundUpdate;
	fetchVersion?: (channel: string, signal?: AbortSignal) => Promise<string | null>;
	/** Live `interface.autoUpdate`; it disables only the install, never the notice. */
	autoUpdate?: () => boolean;
}

/** The cache file a check keeps per install root; `doctor` reads `lastUpdate` from it. */
export function updateFingerprint(installation: Installation): string {
	return createHash("sha256")
		.update(installation.installer?.root ?? installation.root)
		.digest("hex")
		.slice(0, 16);
}

function updateCachePath(installation: Installation, cacheDir: string): string {
	return join(cacheDir, `update-${updateFingerprint(installation)}.json`);
}

/** Where a deferred wrapper leaves its outcome until the next launch merges it. */
export function deferredResultPath(installation: Installation, cacheDir: string): string {
	return join(cacheDir, `update-${updateFingerprint(installation)}.result.json`);
}

/** The lease holder still runs: same pid and, where the platform tells, the same birth token, so a reused pid does not hold it. */
function leaseHolderAlive(pid: number, birth: string | undefined): boolean {
	if (!processAlive(pid)) return false;
	if (!birth) return true;
	const current = processBirthToken(pid);
	return current === null || current === birth;
}

export interface DeferredWait {
	at: number;
	to: string;
	detail: string;
}

/**
 * The newest give-up of a deferred wrapper, pending or merged, for `doctor`.
 * Gated like the notice: only while it names a version newer than the one
 * running and is under a day old, so a manual upgrade clears the warning.
 */
export function readDeferredWait(
	installation: Installation,
	cacheDir: string,
	runningVersion: string,
	now = Date.now(),
): DeferredWait | null {
	const current = (wait: DeferredWait | null | undefined): DeferredWait | null =>
		wait &&
		typeof wait.at === "number" &&
		typeof wait.to === "string" &&
		parseReleaseVersion(wait.to) &&
		parseReleaseVersion(runningVersion) &&
		compareReleaseVersions(wait.to, runningVersion) === 1 &&
		wait.at <= now &&
		now - wait.at < UPDATE_CHECK_INTERVAL_MS
			? wait
			: null;
	const pending = readDeferredResult(deferredResultPath(installation, cacheDir));
	if (pending?.deferred) return current({ at: pending.at, to: pending.to, detail: pending.detail });
	try {
		const value = JSON.parse(readFileSync(updateCachePath(installation, cacheDir), "utf8")) as UpdateCache;
		return current(value?.deferredWait);
	} catch {
		return null;
	}
}

export function readLastBackgroundUpdate(installation: Installation, cacheDir: string): LastBackgroundUpdate | null {
	try {
		const value = JSON.parse(readFileSync(updateCachePath(installation, cacheDir), "utf8")) as UpdateCache;
		const last = value?.lastUpdate;
		return last && typeof last.at === "number" && typeof last.ok === "boolean" ? last : null;
	} catch {
		return null;
	}
}

/** No work at construction. The interactive owner starts probes after its first committed frame. */
export function createUpdateCheck(options: UpdateCheckOptions) {
	const { installation, runningVersion } = options;
	const now = options.now ?? Date.now;
	const cachePath = updateCachePath(installation, options.cacheDir);
	const installPolicy = () => nativeAutoUpdatePolicy(installation, options.autoUpdate?.() ?? true);
	const recent = (at: unknown, interval: number) => typeof at === "number" && at <= now() && now() - at < interval;
	const resultPath = deferredResultPath(installation, options.cacheDir);
	// Detection write-tests two directories; once per version is enough for a session.
	const targets = new Map<string, DeferredTarget | null>();
	const targetFor = (version: string): DeferredTarget | null => {
		if (!targets.has(version)) targets.set(version, deferredUpdateTarget(installation, version));
		return targets.get(version) ?? null;
	};
	const autoUpdateOn = () => (options.autoUpdate?.() ?? true) && process.env.CLIO_CODER_AUTO_UPDATE !== "0";
	const leaseLive = (cache: UpdateCache) =>
		recent(cache.updateAttemptedAt, cache.updateLeaseMs ?? INSTALL_LEASE_MS) &&
		(cache.updateHost !== hostname() ||
			typeof cache.updatePid !== "number" ||
			leaseHolderAlive(cache.updatePid, cache.updateBirth));
	// The day-long back-off applies only once a run for this exact version has
	// settled; an interrupted run leaves no record and is retried (#436).
	const settledToday = (cache: UpdateCache, version: string) =>
		cache.lastUpdate?.to === version && recent(cache.lastUpdate.at, UPDATE_CHECK_INTERVAL_MS);
	async function readCache(): Promise<UpdateCache> {
		try {
			if ((await stat(cachePath)).size > 16_384) return {};
			const value = JSON.parse(await readFile(cachePath, "utf8"));
			return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
		} catch {
			return {};
		}
	}
	async function writeCache(value: UpdateCache, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const temporary = `${cachePath}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, signal });
			signal?.throwIfAborted();
			await rename(temporary, cachePath);
		} finally {
			await rm(temporary, { force: true });
		}
	}
	function readCacheSync(): UpdateCache {
		try {
			const value = JSON.parse(readFileSync(cachePath, "utf8"));
			return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
		} catch {
			return {};
		}
	}
	function writeCacheSync(value: UpdateCache): void {
		const temporary = `${cachePath}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
			renameSync(temporary, cachePath);
		} finally {
			rmSync(temporary, { force: true });
		}
	}
	/**
	 * Folds a deferred wrapper's result into the shared record. A wrapper that
	 * gave up waiting for sessions only releases the lease, so the next quit
	 * tries again; a finished run becomes `lastUpdate`, which also starts the
	 * day-long back-off for that version (#436).
	 */
	async function mergeDeferredResult(signal: AbortSignal): Promise<void> {
		const result = readDeferredResult(resultPath);
		if (result === null) return;
		await withStateFileLock(
			cachePath,
			async () => {
				const cache = await readCache();
				const {
					updateAttemptedAt: _at,
					updatePid: _pid,
					updateHost: _host,
					updateBirth: _birth,
					updateLeaseMs: _ms,
					...rest
				} = cache;
				const lastUpdate: LastBackgroundUpdate = {
					at: result.at,
					from: result.from,
					to: result.to,
					ok: result.ok,
					exitCode: result.exitCode,
					detail: result.detail,
					manager: result.manager,
					log: result.log,
				};
				const { deferredWait: _wait, ...settled } = rest;
				await writeCache(
					result.deferred
						? { ...rest, deferredWait: { at: result.at, to: result.to, detail: result.detail } }
						: { ...settled, lastUpdate },
					signal,
				);
				await rm(resultPath, { force: true });
			},
			{ timeoutMs: 50, signal },
		);
	}
	async function probe(signal: AbortSignal): Promise<UpdateNotice | null> {
		signal.throwIfAborted();
		if (!installation.installer) {
			await mergeDeferredResult(signal).catch(() => {});
			const last = (await readCache()).lastUpdate;
			if (last?.manager && last.ok && !last.announced && compareReleaseVersions(last.to, runningVersion) === 0)
				return {
					kind: "updated",
					key: `updated-after:${last.at}`,
					text: `Updated to v${last.to} · installed by ${last.manager} after your last session`,
				};
		}
		// Read the installed files afresh; the running version is deliberately captured before hydration.
		try {
			const active = installation.installer ? readInstallerRecord(installation.installer.root) : null;
			const activeRoot = active ? installerPackageRoot(active.current) : installation.root;
			const disk = JSON.parse(await readFile(join(activeRoot, "package.json"), { encoding: "utf8", signal }));
			const entry = await stat(join(activeRoot, "dist", "cli", "index.js"));
			if (disk.name === "@iowarp/clio-coder" && parseReleaseVersion(disk.version)) {
				const replaced =
					compareReleaseVersions(disk.version, runningVersion) !== 0 || entry.mtimeMs > options.processStartedAt;
				if (replaced) {
					// A background install this or a sibling session ran names the
					// version and the rollback; any other replacement stays generic.
					const last = (await readCache()).lastUpdate;
					if (last?.ok && last.to === disk.version)
						return {
							kind: "replaced",
							key: `updated:${runningVersion}:${disk.version}`,
							text: `Updated to v${disk.version} · restart clio-coder to use it; this session keeps v${runningVersion}; upgrade --rollback undoes`,
						};
					return {
						kind: "replaced",
						key: `replaced:${runningVersion}:${disk.version}:${entry.mtimeMs}`,
						text: "Installation changed · /quit, restart clio-coder, then /resume",
					};
				}
			}
		} catch {
			// An install being replaced, an unreadable disk, or a removed checkout is not a prompt to reinstall.
		}
		signal.throwIfAborted();
		// Development trees, local/npx copies and unknown layouts never generate registry traffic;
		// a source checkout at a release tag does.
		// A `-dev` version has no published artifact: the `beta` track would call it an rc, and
		// `latest` is always an older stable, so neither answer is one the developer should see.
		const running = parseReleaseVersion(runningVersion);
		if (
			!["npm", "pnpm", "bun", "installer", "homebrew", "winget", "source"].includes(installation.kind) ||
			running === null ||
			(isDevVersion(runningVersion) && !installation.installer)
		)
			return null;
		// A winget install also carries an installer record, but its pin is the version winget
		// installed and winget owns its updates, so only a native record pins or picks a channel.
		const native =
			installation.kind === "installer" && installation.installer
				? readInstallerRecord(installation.installer.root)
				: null;
		if (native?.versionPin) return null;
		// A pre-release install also reads `beta`, so an rc learns about the next rc
		// as well as the final release. Stable installs never see pre-releases.
		const tags: ReleaseTag[] =
			native && ["latest", "beta", "dev"].includes(native.channel)
				? (releaseChannelTags(native.channel) as ReleaseTag[])
				: running.pre.length > 0
					? runningVersion.includes("-snapshot.")
						? ["latest", "beta", "dev"]
						: ["latest", "beta"]
					: ["latest"];
		const track = tags.join("+");
		// A cache written for another track is stale: an rc that became stable must
		// not keep announcing a beta, and an rc must not trust a latest-only answer.
		const fresh = (value: UpdateCache) =>
			recent(value.checkedAt, UPDATE_CHECK_INTERVAL_MS) && (value.track ?? "latest") === track;
		let cache = await readCache();
		if (!fresh(cache)) {
			cache = await withStateFileLock(
				cachePath,
				async () => {
					const current = await readCache();
					if (fresh(current)) return current;
					const fetchVersion = options.fetchVersion ?? fetchTagVersion;
					const found = await Promise.all(tags.map(async (tag) => ({ tag, version: await fetchVersion(tag, signal) })));
					signal.throwIfAborted();
					// Newest by SemVer precedence; `latest` is listed first and wins a tie.
					let best: { tag: ReleaseTag; version: string } | null = null;
					for (const { tag, version } of found)
						if (
							typeof version === "string" &&
							parseReleaseVersion(version) &&
							(best === null || compareReleaseVersions(version, best.version) === 1)
						)
							best = { tag, version };
					// Failed attempts also back off for a day; offline sessions stay quiet.
					const next: UpdateCache = {
						...current,
						checkedAt: now(),
						track,
						available: best?.version ?? null,
						availableTag: best?.tag ?? "latest",
					};
					await writeCache(next, signal);
					return next;
				},
				{ timeoutMs: 50, signal },
			);
		}
		if (typeof cache.available !== "string" || compareReleaseVersions(cache.available, runningVersion) !== 1) return null;
		// Name the selected prerelease channel when offering its newest version,
		// including a stable fallback, so the next upgrade keeps following it.
		const available = cache.available;
		const channel = native?.channel ?? (runningVersion.includes("-snapshot.") ? "dev" : cache.availableTag);
		const key = `available:${runningVersion}:${available}`;
		// Homebrew and winget replace their own installs; the notice names their upgrade command (#436).
		if (installation.kind === "homebrew" || installation.kind === "winget")
			return { kind: "available", key, text: `v${available} available · ${installationCommand(installation, "upgrade")}` };
		// A release checkout moves by git; its several-line steps do not fit a footer, and upgrade prints them (#436).
		if (installation.kind === "source")
			return { kind: "available", key, text: `v${available} available · clio-coder upgrade prints the git steps` };
		// Package-manager installs never update while Clio runs: a user-writable
		// prefix is handed to a wrapper when the session quits; any other gets
		// the exact command (#436).
		if (!installation.installer) {
			const command = installationCommand(installation, "upgrade", channel ?? "latest");
			const target = autoUpdateOn() ? targetFor(available) : null;
			if (target === null) return { kind: "available", key, text: `v${available} available · ${command}` };
			const last = cache.lastUpdate;
			if (last && !last.ok && settledToday(cache, available))
				return {
					kind: "failed",
					key: `failed:${runningVersion}:${available}:${last.at}`,
					text: `background update to v${available} failed (${last.detail}); log: ${last.log ?? "none"}; run ${command}`,
				};
			if (last?.ok && settledToday(cache, available))
				return { kind: "available", key, text: `v${available} available · ${command}` };
			const wait = cache.deferredWait;
			const waited =
				wait && wait.to === available && recent(wait.at, UPDATE_CHECK_INTERVAL_MS)
					? `; the last attempt waited for ${wait.detail}`
					: "";
			return {
				kind: "available",
				key,
				text: `v${available} available · installs after you quit${waited}`,
				defer: !leaseLive(cache),
			};
		}
		if (!installPolicy()?.enabled) {
			const channelFlag = channel && channel !== "latest" ? ` --channel=${channel}` : "";
			return { kind: "available", key, text: `v${available} available · clio-coder upgrade${channelFlag} to install` };
		}
		const installing = {
			kind: "available" as const,
			key,
			text: `v${available} available · installing in the background`,
		};
		if (leaseLive(cache)) return installing;
		const last = cache.lastUpdate;
		if (last && settledToday(cache, available)) {
			if (!last.ok)
				return {
					kind: "failed",
					key: `failed:${runningVersion}:${available}:${last.at}`,
					text: `v${available} available · background update failed: ${last.detail}; run clio-coder upgrade`,
				};
			// Installed today and then rolled back or replaced: leave it to the operator.
			return { kind: "available", key, text: `v${available} available · clio-coder upgrade to install` };
		}
		return { ...installing, install: true };
	}
	/**
	 * Runs the native installer outside the cache lock and outside the idle
	 * gate (#436). The lock is held only to take the lease and to record the
	 * outcome, so sibling sessions keep probing while it runs and a session
	 * started together with this one sees the live lease and skips;
	 * install.sh's `.install-lock` is the second guard.
	 */
	async function maybeInstall(signal: AbortSignal): Promise<boolean> {
		if (!installPolicy()?.enabled) return false;
		const version = await withStateFileLock(
			cachePath,
			async () => {
				const cache = await readCache();
				if (
					typeof cache.available !== "string" ||
					compareReleaseVersions(cache.available, runningVersion) !== 1 ||
					leaseLive(cache) ||
					settledToday(cache, cache.available)
				)
					return null;
				await writeCache(
					{
						...cache,
						updateAttemptedAt: now(),
						updatePid: process.pid,
						updateHost: hostname(),
						...(processBirthToken() ? { updateBirth: processBirthToken() as string } : {}),
					},
					signal,
				);
				return cache.available;
			},
			{ timeoutMs: 50, signal },
		);
		if (version === null) return false;
		const result = await (options.backgroundUpdate ?? runNativeBackgroundUpdate)(
			installation,
			version,
			signal,
			options.autoUpdate?.() ?? true,
		);
		// Our own shutdown killed the run, or install.sh found its lock held
		// (exit 75: another run in progress or a recent crash). Neither is a
		// failure of the update: no record is written, the lease is released,
		// and a later probe retries.
		const interrupted = signal.aborted || result.exitCode === 75;
		await withStateFileLock(
			cachePath,
			async () => {
				const cache = await readCache();
				const {
					updateAttemptedAt: _at,
					updatePid: _pid,
					updateHost: _host,
					updateBirth: _birth,
					updateLeaseMs: _ms,
					...rest
				} = cache;
				if (cache.updatePid !== process.pid || cache.updateHost !== hostname()) return;
				const lastUpdate: LastBackgroundUpdate = {
					at: now(),
					from: runningVersion,
					to: version,
					ok: result.ok,
					exitCode: result.exitCode,
					detail: result.detail,
				};
				await writeCache(interrupted ? rest : { ...rest, lastUpdate });
			},
			{ timeoutMs: 5000 },
		).catch(() => {
			// The record is advisory: a lock timeout here leaves the lease to expire
			// on its own (pid gone or INSTALL_LEASE_MS), and the next probe retries.
		});
		return result.ok && !interrupted;
	}
	/** True while a background install or deferred wrapper of this install holds the shared lease. */
	function updatePending(): boolean {
		return leaseLive(readCacheSync());
	}
	/**
	 * Called from a persist shutdown hook, so it is synchronous: the process
	 * exits right after. Re-checks policy (the setting may have changed since
	 * the notice), takes the shared lease for the wrapper's pid and starts it.
	 * An explicit `version` comes from /upgrade: the operator's consent stands
	 * in for `autoUpdate`, the monitor's cached answer and the day-long back-off.
	 */
	function spawnDeferred(version?: string): boolean {
		if (installation.installer || (version === undefined && !autoUpdateOn())) return false;
		try {
			return withStateFileLockSync(
				cachePath,
				() => {
					const cache = readCacheSync();
					const to = version ?? cache.available;
					if (
						typeof to !== "string" ||
						compareReleaseVersions(to, runningVersion) !== 1 ||
						leaseLive(cache) ||
						(version === undefined && settledToday(cache, to))
					)
						return false;
					const target = targetFor(to);
					if (target === null) return false;
					const {
						updateAttemptedAt: _at,
						updatePid: _pid,
						updateHost: _host,
						updateBirth: _birth,
						updateLeaseMs: _ms,
						...rest
					} = cache;
					const lease = {
						updateAttemptedAt: now(),
						updateHost: hostname(),
						updateLeaseMs: DEFERRED_WAIT_MS + DEFERRED_RUN_MS + 60_000,
					};
					// The lease is down before the wrapper exists, so a failed write
					// never leaves a wrapper unrecorded for the next quit to double.
					// Until the pid is added it holds for its whole length.
					writeCacheSync({ ...rest, ...lease });
					const started = spawnDeferredUpdate(target, {
						cacheDir: options.cacheDir,
						fingerprint: updateFingerprint(installation),
						resultPath,
						from: runningVersion,
						to,
					});
					if (started === null) {
						writeCacheSync(rest);
						return false;
					}
					try {
						const birth = processBirthToken(started.pid);
						writeCacheSync({ ...rest, ...lease, updatePid: started.pid, ...(birth ? { updateBirth: birth } : {}) });
					} catch {
						// The pid-less lease already holds until it ages out.
					}
					return true;
				},
				{ timeoutMs: 200 },
			);
		} catch {
			return false;
		}
	}
	/** Display bookkeeping only: the idle gate and the reminder throttles. */
	async function claim(notice: UpdateNotice, isIdle: () => boolean, signal: AbortSignal): Promise<boolean> {
		return withStateFileLock(
			cachePath,
			async () => {
				const cache = await readCache();
				// A replacement concerns every session still running the old prefix,
				// so it is not throttled across processes; each monitor shows it once
				// (#436). Availability and failure reminders stay shared.
				if (
					!isIdle() ||
					(notice.kind === "available" && recent(cache.notifiedAt, UPDATE_CHECK_INTERVAL_MS)) ||
					(notice.kind !== "replaced" &&
						cache.notifiedKey === notice.key &&
						recent(cache.notifiedAt, UPDATE_NOTICE_INTERVAL_MS))
				)
					return false;
				// A deferred update's result is announced once, on the first idle launch after it.
				const lastUpdate =
					notice.kind === "updated" && cache.lastUpdate ? { ...cache.lastUpdate, announced: true } : cache.lastUpdate;
				await writeCache(
					{ ...cache, ...(lastUpdate ? { lastUpdate } : {}), notifiedKey: notice.key, notifiedAt: now() },
					signal,
				);
				return isIdle() && !signal.aborted;
			},
			{ timeoutMs: 50, signal },
		);
	}
	return { probe, claim, maybeInstall, spawnDeferred, updatePending };
}
