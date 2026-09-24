/**
 * What the operator has learned about Clio herself, across every project.
 *
 * Guidance tips read it to stay relevant: a feature the operator already uses
 * needs no tip, a tip already shown twice is retired, and the topics the
 * operator asks Clio about show where the harness confused them. It is runtime
 * state kept in the state dir (harness-profile.json), never configuration and
 * never model context. Writes are best-effort and merge with what other
 * sessions wrote since the last read, like recent-models.json.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "./safe-resource-write.js";
import { clioStateDir, stateRootRemoved } from "./xdg.js";

export interface HarnessProfileLesson {
	shown: number;
	lastShownAt: string;
}

export interface HarnessProfile {
	version: 1;
	/** Guidance lessons by id: how often each was shown and when last. */
	lessons: Record<string, HarnessProfileLesson>;
	/** Features the operator used themselves, such as "/view", "!" or "@". */
	features: Record<string, number>;
	/** Harness topics the operator asked Clio about, such as "settings" or "keys". */
	topics: Record<string, number>;
}

/** Bounds keep a long-lived profile small whatever feeds it. */
const MAX_KEYS = 200;
const MAX_KEY_LENGTH = 64;

export function emptyHarnessProfile(): HarnessProfile {
	return { version: 1, lessons: {}, features: {}, topics: {} };
}

export function harnessProfilePath(): string {
	return join(clioStateDir(), "harness-profile.json");
}

function counts(value: unknown): Record<string, number> {
	const out: Record<string, number> = {};
	if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
	for (const [key, count] of Object.entries(value).slice(0, MAX_KEYS)) {
		if (key.length > 0 && key.length <= MAX_KEY_LENGTH && Number.isSafeInteger(count) && (count as number) > 0)
			out[key] = count as number;
	}
	return out;
}

function parseProfile(raw: string): HarnessProfile {
	const parsed: unknown = JSON.parse(raw);
	const profile = emptyHarnessProfile();
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return profile;
	const record = parsed as Record<string, unknown>;
	const lessons = record.lessons;
	if (lessons !== null && typeof lessons === "object" && !Array.isArray(lessons)) {
		for (const [id, entry] of Object.entries(lessons).slice(0, MAX_KEYS)) {
			if (entry === null || typeof entry !== "object") continue;
			const { shown, lastShownAt } = entry as Record<string, unknown>;
			if (id.length > MAX_KEY_LENGTH || !Number.isSafeInteger(shown) || typeof lastShownAt !== "string") continue;
			profile.lessons[id] = { shown: shown as number, lastShownAt };
		}
	}
	profile.features = counts(record.features);
	profile.topics = counts(record.topics);
	return profile;
}

let cache: HarnessProfile | null = null;
let cachePath: string | null = null;

function readFromDisk(path: string): HarnessProfile {
	if (!existsSync(path)) return emptyHarnessProfile();
	try {
		return parseProfile(readFileSync(path, "utf8"));
	} catch {
		// An unreadable profile starts over; it only tunes which tips appear.
		return emptyHarnessProfile();
	}
}

/** The current profile. Reads the file once per path and serves the cache after. */
export function readHarnessProfile(): HarnessProfile {
	const path = harnessProfilePath();
	if (cache === null || cachePath !== path) {
		cache = readFromDisk(path);
		cachePath = path;
	}
	return cache;
}

function update(mutate: (profile: HarnessProfile) => void): HarnessProfile {
	const path = harnessProfilePath();
	// Re-read so what other sessions recorded since the last load merges in.
	const next = readFromDisk(path);
	mutate(next);
	cache = next;
	cachePath = path;
	if (stateRootRemoved()) return next;
	try {
		safeResourceWrite(path, `${JSON.stringify(next, null, "\t")}\n`, { encoding: "utf8" });
	} catch {
		// Best-effort: the in-memory profile still steers this session.
	}
	return next;
}

function bump(record: Record<string, number>, key: string): void {
	const trimmed = key.trim().slice(0, MAX_KEY_LENGTH);
	if (trimmed.length === 0) return;
	if (record[trimmed] === undefined && Object.keys(record).length >= MAX_KEYS) return;
	record[trimmed] = (record[trimmed] ?? 0) + 1;
}

/** The operator used `feature` themselves, so tips about it are no longer needed. */
export function recordHarnessFeature(feature: string): void {
	update((profile) => bump(profile.features, feature));
}

/** The operator asked Clio about `topic`. */
export function recordHarnessTopic(topic: string): void {
	update((profile) => bump(profile.topics, topic));
}

/** A guidance lesson reached the operator. */
export function recordLessonShown(id: string, now = new Date()): void {
	update((profile) => {
		const key = id.slice(0, MAX_KEY_LENGTH);
		if (profile.lessons[key] === undefined && Object.keys(profile.lessons).length >= MAX_KEYS) return;
		profile.lessons[key] = { shown: (profile.lessons[key]?.shown ?? 0) + 1, lastShownAt: now.toISOString() };
	});
}
