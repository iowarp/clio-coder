/**
 * w2-08 orphan-channel tripwire: every member of BusChannels must have at
 * least one emit site and at least one subscribe site in src/, or an explicit
 * allowlist entry below with a one-line justification.
 *
 * Scan limits, on purpose: this is a static text scan that matches only
 * direct `.emit(BusChannels.X` / `.on(BusChannels.X` references (which covers
 * `bus.emit`, `context.bus.emit`, `deps.bus?.emit`, and friends, because they
 * all end in `.emit(`). Channels routed through a variable (the config
 * dispatch() ternary, the bus-trace TRACED_CHANNELS loop) are invisible to it
 * and live in the allowlists instead. A second check asserts each allowlist
 * entry is still needed, so entries cannot rot into cover for real orphans.
 */

import { deepStrictEqual } from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";

const SRC_ROOT = new URL("../../src", import.meta.url).pathname;

/** Channels with no direct emit site, and why that is correct today. */
const EMIT_ALLOWLIST: Record<string, string> = {
	[BusChannels.ConfigHotReload]:
		"emitted through the channel-selecting ternary in src/domains/config/extension.ts dispatch()",
	[BusChannels.ConfigNextTurn]:
		"emitted through the channel-selecting ternary in src/domains/config/extension.ts dispatch()",
	[BusChannels.ConfigRestartRequired]:
		"emitted through the channel-selecting ternary in src/domains/config/extension.ts dispatch()",
};

/** Channels with no direct subscribe site, and why that is correct today. */
const SUBSCRIBE_ALLOWLIST: Record<string, string> = {
	[BusChannels.ShutdownRequested]:
		"subscribed through the TRACED_CHANNELS loop in src/core/bus-trace.ts (CLIO_BUS_TRACE=1)",
	[BusChannels.ShutdownDrained]:
		"subscribed through the TRACED_CHANNELS loop in src/core/bus-trace.ts (CLIO_BUS_TRACE=1)",
	[BusChannels.ShutdownTerminated]:
		"subscribed through the TRACED_CHANNELS loop in src/core/bus-trace.ts (CLIO_BUS_TRACE=1)",
	[BusChannels.ShutdownPersisted]:
		"subscribed through the TRACED_CHANNELS loop in src/core/bus-trace.ts (CLIO_BUS_TRACE=1)",
	[BusChannels.SessionEnd]: "subscribed through the TRACED_CHANNELS loop in src/core/bus-trace.ts (CLIO_BUS_TRACE=1)",
	[BusChannels.DomainLoaded]: "subscribed through the TRACED_CHANNELS loop in src/core/bus-trace.ts (CLIO_BUS_TRACE=1)",
	[BusChannels.DomainFailed]: "subscribed through the TRACED_CHANNELS loop in src/core/bus-trace.ts (CLIO_BUS_TRACE=1)",
	[BusChannels.SafetyAllowed]:
		"audit-only emit kept subscriber-less by design: allows are operator-visible as normal tool execution and persist in the safety audit log (w2-05 Task 3 / w2-07 fix 3 scope)",
};

function walk(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walk(full));
		else if (entry.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx") || full.endsWith(".mts"))) {
			files.push(full);
		}
	}
	return files;
}

const ALL_SOURCE = walk(SRC_ROOT)
	.map((file) => readFileSync(file, "utf8"))
	.join("\n");

const channelEntries = Object.entries(BusChannels) as Array<[string, string]>;

function hasEmitSite(key: string): boolean {
	return new RegExp(`\\.emit\\(\\s*BusChannels\\.${key}\\b`).test(ALL_SOURCE);
}

function hasSubscribeSite(key: string): boolean {
	return new RegExp(`\\.on\\(\\s*BusChannels\\.${key}\\b`).test(ALL_SOURCE);
}

describe("bus wiring tripwire", () => {
	it("every BusChannels member has an emit site or an allowlist justification", () => {
		const orphans = channelEntries
			.filter(([key, channel]) => !hasEmitSite(key) && EMIT_ALLOWLIST[channel] === undefined)
			.map(
				([key, channel]) =>
					`${channel} (BusChannels.${key}) has no emit site: nothing publishes this channel. ` +
					`Emit it somewhere, remove the channel, or allowlist it in ${import.meta.url} with a justification.`,
			);
		deepStrictEqual(orphans, []);
	});

	it("every BusChannels member has a subscribe site or an allowlist justification", () => {
		const orphans = channelEntries
			.filter(([key, channel]) => !hasSubscribeSite(key) && SUBSCRIBE_ALLOWLIST[channel] === undefined)
			.map(
				([key, channel]) =>
					`${channel} (BusChannels.${key}) has no subscribe site: events on it die on the bus. ` +
					`Wire a subscriber, remove the channel, or allowlist it in ${import.meta.url} with a justification.`,
			);
		deepStrictEqual(orphans, []);
	});

	it("allowlist entries are still needed (no direct site has appeared)", () => {
		const byChannel = new Map(channelEntries.map(([key, channel]) => [channel, key]));
		const stale: string[] = [];
		for (const channel of Object.keys(EMIT_ALLOWLIST)) {
			const key = byChannel.get(channel);
			if (key === undefined) stale.push(`${channel}: allowlisted but no longer a BusChannels member`);
			else if (hasEmitSite(key)) stale.push(`${channel}: direct emit site exists; remove the EMIT_ALLOWLIST entry`);
		}
		for (const channel of Object.keys(SUBSCRIBE_ALLOWLIST)) {
			const key = byChannel.get(channel);
			if (key === undefined) stale.push(`${channel}: allowlisted but no longer a BusChannels member`);
			else if (hasSubscribeSite(key))
				stale.push(`${channel}: direct subscribe site exists; remove the SUBSCRIBE_ALLOWLIST entry`);
		}
		deepStrictEqual(stale, []);
	});
});
