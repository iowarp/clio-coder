import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { isDevVersion } from "../../core/build-info.js";
import { processAlive, processBirthToken } from "../../core/process-identity.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
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
	/** Outcome of the newest background install, read by later sessions and `doctor`. */
	lastUpdate?: LastBackgroundUpdate;
}

export interface LastBackgroundUpdate {
	at: number;
	from: string;
	to: string;
	ok: boolean;
	exitCode: number | null;
	detail: string;
}

export interface UpdateNotice {
	kind: "available" | "replaced" | "failed";
	key: string;
	text: string;
	/** An eligible native install the session should start in the background. */
	install?: boolean;
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
function updateCachePath(installation: Installation, cacheDir: string): string {
	const fingerprint = createHash("sha256")
		.update(installation.installer?.root ?? installation.root)
		.digest("hex")
		.slice(0, 16);
	return join(cacheDir, `update-${fingerprint}.json`);
}

/** The lease holder still runs: same pid and, where the platform tells, the same birth token, so a reused pid does not hold it. */
function leaseHolderAlive(pid: number, birth: string | undefined): boolean {
	if (!processAlive(pid)) return false;
	if (!birth) return true;
	const current = processBirthToken(pid);
	return current === null || current === birth;
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
	const leaseLive = (cache: UpdateCache) =>
		recent(cache.updateAttemptedAt, INSTALL_LEASE_MS) &&
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
	async function probe(signal: AbortSignal): Promise<UpdateNotice | null> {
		signal.throwIfAborted();
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
		// Development trees, local/npx copies and unknown layouts never generate registry traffic.
		// A `-dev` version has no published artifact: the `beta` track would call it an rc, and
		// `latest` is always an older stable, so neither answer is one the developer should see.
		const running = parseReleaseVersion(runningVersion);
		if (
			!["npm", "pnpm", "bun", "installer"].includes(installation.kind) ||
			running === null ||
			(isDevVersion(runningVersion) && !installation.installer)
		)
			return null;
		// A pre-release install also reads `beta`, so an rc learns about the next rc
		// as well as the final release. Stable installs never see pre-releases.
		const native = installation.installer ? readInstallerRecord(installation.installer.root) : null;
		if (native?.versionPin) return null;
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
		// Package-manager installs get the exact command; the session never runs it (#436).
		if (!installation.installer)
			return {
				kind: "available",
				key,
				text: `v${available} available · ${installationCommand(installation, "upgrade", channel ?? "latest")}`,
			};
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
				const { updateAttemptedAt: _at, updatePid: _pid, updateHost: _host, updateBirth: _birth, ...rest } = cache;
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
				await writeCache({ ...cache, notifiedKey: notice.key, notifiedAt: now() }, signal);
				return isIdle() && !signal.aborted;
			},
			{ timeoutMs: 50, signal },
		);
	}
	return { probe, claim, maybeInstall };
}
