import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionMeta } from "../../src/domains/session/index.js";
import { buildSessionItems, formatRelativeTime } from "../../src/interactive/overlays/session-selector.js";
import { filterSessions } from "../../src/interactive/overlays/session-selector-search.js";

function meta(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
	return {
		id,
		cwd: "/repo",
		cwdHash: "hash",
		createdAt: "2026-04-23T01:02:03.000Z",
		endedAt: null,
		model: "model-a",
		endpoint: "target-a",
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.1.0-test",
		piMonoVersion: "0.0.0",
		platform: "linux",
		nodeVersion: "v20.0.0",
		...overrides,
	};
}

describe("session selector metadata", () => {
	it("searches timestamps, names, labels, and first-message previews", () => {
		const sessions = [
			meta("s1", { name: "release replay", labels: ["checkpointed branch"] }),
			meta("s2", {
				createdAt: "2026-04-22T00:00:00.000Z",
				name: "other",
				firstMessagePreview: "fix the credentials probe regression",
			}),
		];

		strictEqual(filterSessions(sessions, "2026-04-23")[0]?.id, "s1");
		strictEqual(filterSessions(sessions, "release replay")[0]?.id, "s1");
		strictEqual(filterSessions(sessions, "checkpointed")[0]?.id, "s1");
		strictEqual(filterSessions(sessions, "credentials probe")[0]?.id, "s2");
	});

	it("renders a meta strip and a conversation preview", () => {
		const now = Date.parse("2026-04-25T12:00:00.000Z");
		const items = buildSessionItems(
			[
				meta("session-abcdef", {
					name: "named session",
					labels: ["fork point"],
					firstMessagePreview: "Investigate the credentials regression and propose a fix.",
					messageCount: 7,
					lastActivityAt: "2026-04-25T11:55:00.000Z",
					endpoint: "openai-codex",
					model: "gpt-5.4-mini",
					endedAt: "2026-04-25T11:58:00.000Z",
				}),
			],
			now,
		);
		const first = items[0];
		ok(first, "expected a row");
		ok(first.label.includes("5m ago"), `expected relative time, got: ${first.label}`);
		ok(first.label.includes("7 msgs"), `expected msg count, got: ${first.label}`);
		ok(first.label.includes("openai-codex/gpt-5.4-mini"), `expected target, got: ${first.label}`);
		ok(first.label.startsWith("✓"), `expected closed glyph, got: ${first.label}`);
		ok(
			(first.description ?? "").includes("Investigate the credentials regression"),
			`expected preview in description, got: ${first.description}`,
		);
		ok((first.description ?? "").includes("fork point"), first.description);
	});

	it("falls back gracefully when preview, count, and target are missing", () => {
		const now = Date.parse("2026-04-25T12:00:00.000Z");
		const items = buildSessionItems(
			[
				meta("naked-session", {
					endpoint: null,
					model: null,
					createdAt: "2026-04-25T11:50:00.000Z",
				}),
			],
			now,
		);
		const first = items[0];
		ok(first);
		ok(first.label.includes("0 msgs"), `expected zero count, got: ${first.label}`);
		ok(first.label.includes("no target"), `expected no-target placeholder, got: ${first.label}`);
		ok((first.description ?? "").includes("(no preview"), `expected no-preview placeholder, got: ${first.description}`);
	});

	it("singularizes the message count for one-message sessions", () => {
		const items = buildSessionItems([meta("solo", { messageCount: 1 })], Date.parse("2026-04-25T12:00:00.000Z"));
		ok(items[0]?.label.includes("1 msg"), items[0]?.label);
		ok(!items[0]?.label.includes("1 msgs"), items[0]?.label);
	});
});

describe("formatRelativeTime", () => {
	const NOW = Date.parse("2026-04-25T12:00:00.000Z");

	it("collapses sub-five-second deltas to 'just now'", () => {
		strictEqual(formatRelativeTime("2026-04-25T11:59:58.000Z", NOW), "just now");
	});

	it("uses seconds, minutes, hours, then yesterday/d/w/date", () => {
		strictEqual(formatRelativeTime("2026-04-25T11:59:30.000Z", NOW), "30s ago");
		strictEqual(formatRelativeTime("2026-04-25T11:59:00.000Z", NOW), "1m ago");
		strictEqual(formatRelativeTime("2026-04-25T11:30:00.000Z", NOW), "30m ago");
		strictEqual(formatRelativeTime("2026-04-25T09:00:00.000Z", NOW), "3h ago");
		strictEqual(formatRelativeTime("2026-04-24T11:00:00.000Z", NOW), "yesterday");
		strictEqual(formatRelativeTime("2026-04-22T12:00:00.000Z", NOW), "3d ago");
		strictEqual(formatRelativeTime("2026-04-15T12:00:00.000Z", NOW), "1w ago");
		strictEqual(formatRelativeTime("2026-03-01T12:00:00.000Z", NOW), "2026-03-01");
	});

	it("returns an em-placeholder for missing or invalid input", () => {
		strictEqual(formatRelativeTime(null, NOW), "—");
		strictEqual(formatRelativeTime(undefined, NOW), "—");
		strictEqual(formatRelativeTime("not-a-date", NOW), "—");
	});

	it("returns 'just now' for future timestamps to avoid negative deltas", () => {
		strictEqual(formatRelativeTime("2026-04-25T12:01:00.000Z", NOW), "just now");
	});
});
