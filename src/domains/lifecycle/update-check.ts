import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withStateFileLock } from "../../core/state-file-lock.js";
import type { Installation } from "./install-method.js";
import { compareReleaseVersions, fetchReleaseVersion, parseReleaseVersion } from "./release-version.js";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
export const UPDATE_NOTICE_INTERVAL_MS = 7 * UPDATE_CHECK_INTERVAL_MS;

interface UpdateCache {
	checkedAt?: number;
	available?: string | null;
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
						text: `Installation changed · /quit, then clio-coder --continue`,
					};
			}
		} catch {
			// An install being replaced, an unreadable disk, or a removed checkout is not a prompt to reinstall.
		}
		signal.throwIfAborted();
		// Development trees, local/npx copies and unknown layouts never generate registry traffic.
		if (!["npm", "pnpm", "bun"].includes(installation.kind) || parseReleaseVersion(runningVersion)?.pre.length !== 0)
			return null;
		let cache = await readCache();
		if (!recent(cache.checkedAt, UPDATE_CHECK_INTERVAL_MS)) {
			cache = await withStateFileLock(
				cachePath,
				async () => {
					const current = await readCache();
					if (recent(current.checkedAt, UPDATE_CHECK_INTERVAL_MS)) return current;
					const available = await (options.fetchVersion ?? fetchReleaseVersion)("latest", signal);
					signal.throwIfAborted();
					// Failed attempts also back off for a day; offline sessions stay quiet.
					const next = { ...current, checkedAt: now(), available: parseReleaseVersion(available) ? available : null };
					await writeCache(next, signal);
					return next;
				},
				{ timeoutMs: 50, signal },
			);
		}
		if (typeof cache.available !== "string" || compareReleaseVersions(cache.available, runningVersion) !== 1) return null;
		return {
			kind: "available",
			key: `available:${runningVersion}:${cache.available}`,
			text:
				installation.kind === "npm"
					? `v${cache.available} available · /quit, then clio-coder upgrade --restart`
					: `v${cache.available} available · clio-coder upgrade for update steps`,
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
