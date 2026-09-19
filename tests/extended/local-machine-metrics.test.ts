import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { counterRate, diskCounters, networkCounters } from "../../src/interactive/footer/system-metrics.js";

test("rates use elapsed time and reject counter resets or invalid intervals", () => {
	strictEqual(counterRate(6144, 2048, 2000), 2048);
	strictEqual(counterRate(0, 2048, 2000), null);
	strictEqual(counterRate(2048, 0, 0), null);
	strictEqual(counterRate(Number.NaN, 0, 2000), null);
});
test("network counters exclude loopback and preserve interface-specific receive/transmit totals", () => {
	const text =
		"Inter-| Receive | Transmit\n lo: 99 0 0 0 0 0 0 0 99 0 0 0 0 0 0 0\n eth0: 4096 1 0 0 0 0 0 0 8192 1 0 0 0 0 0 0\n malformed:";
	deepStrictEqual([...networkCounters(text)], [["eth0", { first: 4096, second: 8192 }]]);
});
test("disk sector counters use 512-byte sectors and exclude partitions and RAM disks", () => {
	const text = "8 0 sda 1 0 8 0 1 0 16 0 0 0 0\n8 1 sda1 1 0 8 0 1 0 16 0 0 0 0\n7 0 loop0 1 0 8 0 1 0 16 0 0 0 0";
	deepStrictEqual([...diskCounters(text, new Set(["sda", "loop0"]))], [["sda", { first: 4096, second: 8192 }]]);
});
