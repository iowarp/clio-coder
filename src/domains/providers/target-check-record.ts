/**
 * The answered setup check: setup sent one short chat request to a target and
 * the model answered it. The next process reads it so a route setup just
 * proved does not open as "not checked yet". Disposable machine state beside
 * the model snapshots; a record for another identity, or an old one, is
 * ignored. Reading never creates the cache root.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { clioCacheDir, clioCachePath } from "../../core/xdg.js";
import type { TargetDescriptor } from "./types/target-descriptor.js";

const TARGET_CHECK_TTL_MS = 24 * 60 * 60 * 1_000;

export interface TargetCheckRecord {
	version: 1;
	targetId: string;
	runtimeId: string;
	url: string | null;
	model: string;
	answeredAt: string;
	latencyMs: number;
}

type Identity = Pick<TargetDescriptor, "id" | "runtime" | "url">;

function checkPath(targetId: string, cacheDir: string): string {
	return join(
		cacheDir,
		"provider-target-checks",
		`${createHash("sha256").update(targetId).digest("hex").slice(0, 24)}.json`,
	);
}

/** Best effort: a failed write leaves the target unchecked, which is what it was. */
export function recordTargetCheck(
	target: Identity,
	model: string,
	latencyMs: number,
	options: { cacheDir?: string; nowMs?: number } = {},
): boolean {
	const record: TargetCheckRecord = {
		version: 1,
		targetId: target.id,
		runtimeId: target.runtime,
		url: target.url ?? null,
		model,
		answeredAt: new Date(options.nowMs ?? Date.now()).toISOString(),
		latencyMs: Math.max(0, Math.round(latencyMs)),
	};
	try {
		safeResourceWrite(checkPath(target.id, options.cacheDir ?? clioCacheDir()), `${JSON.stringify(record, null, 2)}\n`, {
			encoding: "utf8",
		});
		return true;
	} catch {
		return false;
	}
}

/** A fresh record for exactly this target identity, or null. */
export function readTargetCheck(
	target: Identity,
	options: { cacheDir?: string; nowMs?: number } = {},
): TargetCheckRecord | null {
	const path = checkPath(target.id, options.cacheDir ?? clioCachePath());
	if (!existsSync(path)) return null;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<TargetCheckRecord>;
		if (value.version !== 1 || value.targetId !== target.id || value.runtimeId !== target.runtime) return null;
		if ((value.url ?? null) !== (target.url ?? null)) return null;
		if (typeof value.model !== "string" || typeof value.answeredAt !== "string") return null;
		const at = Date.parse(value.answeredAt);
		const now = options.nowMs ?? Date.now();
		if (!Number.isFinite(at) || at > now || now - at >= TARGET_CHECK_TTL_MS) return null;
		return {
			version: 1,
			targetId: value.targetId,
			runtimeId: value.runtimeId,
			url: value.url ?? null,
			model: value.model,
			answeredAt: value.answeredAt,
			latencyMs: typeof value.latencyMs === "number" ? value.latencyMs : 0,
		};
	} catch {
		return null;
	}
}
