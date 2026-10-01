import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDevVersion } from "../../core/build-info.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import type { Installation } from "./install-method.js";
import { compareReleaseVersions, fetchReleaseVersion, parseReleaseVersion } from "./release-version.js";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
export const UPDATE_NOTICE_INTERVAL_MS = 7 * UPDATE_CHECK_INTERVAL_MS;

/** Dist-tags a check may consult. Pre-releases are published under `beta`, never `latest`. */
type ReleaseTag = "latest" | "beta";

interface UpdateCache {
	checkedAt?: number;
	available?: string | null;
	/** Dist-tag that published `available`; absent means `latest`. */
	availableTag?: ReleaseTag;
	/** Dist-tags the cached check consulted, joined by `+`; absent means `latest`. */
	track?: string;
	notifiedKey?: string;
	notifiedAt?: number;
}

export interface UpdateNotice {
	kind: "available" | "replaced";
	key: string;
	text: string;
}

export interface UpdateCheckOptions {
	installation: Installation;
	runningVersion: string;
	cacheDir: string;
	processStartedAt: number;
	now?: () => number;
	fetchVersion?: (channel: string, signal?: AbortSignal) => Promise<string | null>;
}

/** No work at construction. The interactive owner starts probes after its first committed frame. */
export function createUpdateCheck(options: UpdateCheckOptions) {
	const { installation, runningVersion } = options;
	const now = options.now ?? Date.now;
	const fingerprint = createHash("sha256").update(installation.root).digest("hex").slice(0, 16);
	const cachePath = join(options.cacheDir, `update-${fingerprint}.json`);
	const recent = (at: unknown, interval: number) => typeof at === "number" && at <= now() && now() - at < interval;
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
			const disk = JSON.parse(await readFile(join(installation.root, "package.json"), { encoding: "utf8", signal }));
			const entry = await stat(installation.entry);
			if (disk.name === "@iowarp/clio-coder" && parseReleaseVersion(disk.version)) {
				const replaced =
					compareReleaseVersions(disk.version, runningVersion) !== 0 || entry.mtimeMs > options.processStartedAt;
				if (replaced)
					return {
						kind: "replaced",
						key: `replaced:${runningVersion}:${disk.version}:${entry.mtimeMs}`,
						text: "Installation changed · /quit, restart clio-coder, then /resume",
					};
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
			isDevVersion(runningVersion)
		)
			return null;
		// A pre-release install also reads `beta`, so an rc learns about the next rc
		// as well as the final release. Stable installs never see pre-releases.
		const tags: ReleaseTag[] = running.pre.length > 0 ? ["latest", "beta"] : ["latest"];
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
					const fetchVersion = options.fetchVersion ?? fetchReleaseVersion;
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
		// `/upgrade` and a bare `clio-coder upgrade` install `latest`; a newer beta
		// needs the channel named, or the command would not install what was announced.
		const beta = cache.availableTag === "beta";
		const action =
			installation.kind === "npm" || installation.kind === "installer"
				? beta
					? "clio-coder upgrade --channel=beta to install"
					: "/upgrade to review"
				: `clio-coder upgrade${beta ? " --channel=beta" : ""} for update steps`;
		return {
			kind: "available",
			key: `available:${runningVersion}:${cache.available}`,
			text: `v${cache.available} available · ${action}`,
		};
	}
	async function claim(notice: UpdateNotice, isIdle: () => boolean, signal: AbortSignal): Promise<boolean> {
		return withStateFileLock(
			cachePath,
			async () => {
				const cache = await readCache();
				if (
					!isIdle() ||
					(notice.kind === "available" && recent(cache.notifiedAt, UPDATE_CHECK_INTERVAL_MS)) ||
					(cache.notifiedKey === notice.key && recent(cache.notifiedAt, UPDATE_NOTICE_INTERVAL_MS))
				)
					return false;
				await writeCache({ ...cache, notifiedKey: notice.key, notifiedAt: now() }, signal);
				return isIdle() && !signal.aborted;
			},
			{ timeoutMs: 50, signal },
		);
	}
	return { probe, claim };
}
