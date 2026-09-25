import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
	createNotificationCenter,
	type Notification,
	topNotification,
} from "../../src/interactive/footer/notifications.js";

const notice = (id: string, level: Notification["level"], addedAt: number, expiresAt: number | null = null) => ({
	id,
	level,
	text: id,
	key: null,
	addedAt,
	expiresAt,
});

test("the compact footer's one notice slot follows the notice center's severity order", () => {
	const olderError = notice("older error", "error", 1_000);
	const newerInfo = notice("newer info", "info", 5_000, 20_000);
	// A fresh info update must not hide an unresolved error.
	strictEqual(topNotification([olderError, newerInfo], 6_000)?.id, "older error");
	// An expired error yields the slot.
	strictEqual(topNotification([notice("expired error", "error", 1_000, 2_000), newerInfo], 6_000)?.id, "newer info");
	// Within one level, the newest wins.
	strictEqual(
		topNotification([notice("first warning", "warning", 1_000), notice("second warning", "warning", 2_000)], 3_000)?.id,
		"second warning",
	);
	strictEqual(topNotification([], 0), undefined);
});

test("the slot agrees with the head of the notice panel's list", () => {
	let clock = 0;
	const center = createNotificationCenter({ now: () => clock });
	center.add({ level: "warning", text: "stale index" });
	clock = 10;
	center.add({ level: "info", text: "saved" });
	clock = 20;
	center.add({ level: "error", text: "provider down" });
	clock = 30;
	center.add({ level: "success", text: "done" });
	strictEqual(topNotification(center.list(clock), clock)?.text, center.list(clock)[0]?.text);
	strictEqual(topNotification(center.list(clock), clock)?.text, "provider down");
});
