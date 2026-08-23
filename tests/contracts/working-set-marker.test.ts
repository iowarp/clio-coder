import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarker } from "../../src/domains/context/working-set/marker.js";

const BODY = "line one\nline two";

test("marker: fixed field order and byte-stable output", () => {
	const marker = renderMarker({
		ref: { entry: "01J8" },
		reason: "age_horizon",
		toolName: "read",
		text: BODY,
	});
	assert.equal(
		marker,
		'[evicted ref=01J8 reason=age_horizon tool=read size=2 lines/17B recall=context(scope="recall", ref="01J8") preview="line one line two"]',
	);
	// Same input, same bytes: the marker is persisted and replayed on every
	// request, so a marker that drifted would cold-start the prompt cache.
	assert.equal(marker, renderMarker({ ref: { entry: "01J8" }, reason: "age_horizon", toolName: "read", text: BODY }));
});

test("marker: one line, no timestamp, no counter", () => {
	const marker = renderMarker({
		ref: { entry: "01J8" },
		reason: "age_horizon",
		toolName: "bash",
		text: `${"output line\n".repeat(400)}tail`,
	});
	assert.equal(marker.split("\n").length, 1);
	assert.match(marker, /^\[evicted .*\]$/);
	assert.doesNotMatch(marker, /\d{4}-\d{2}-\d{2}T/);
	assert.equal(marker.includes("size=401 lines/4.7KB"), true, marker);
});

test("marker: optional fields render in order and are omitted when absent", () => {
	assert.equal(
		renderMarker({
			ref: { entry: "01J8" },
			reason: "superseded_read",
			by: "01JC",
			toolName: "read",
			text: BODY,
			path: "src/a.ts",
		}),
		'[evicted ref=01J8 reason=superseded_read by=01JC tool=read path=src/a.ts size=2 lines/17B recall=context(scope="recall", ref="01J8") preview="line one line two"]',
	);
	// `by` and `path` gone, everything else identical.
	assert.equal(
		renderMarker({ ref: { entry: "01J8" }, reason: "superseded_read", toolName: "read", text: BODY }),
		'[evicted ref=01J8 reason=superseded_read tool=read size=2 lines/17B recall=context(scope="recall", ref="01J8") preview="line one line two"]',
	);
});

test("marker: an offloaded body carries the pointer instead of a preview", () => {
	const marker = renderMarker({
		ref: { entry: "01J8" },
		reason: "age_horizon",
		toolName: "bash",
		text: BODY,
		offloadPath: "/state/scratch/session-1/call-1.txt",
	});
	assert.equal(
		marker,
		'[evicted ref=01J8 reason=age_horizon tool=bash size=2 lines/17B offload=/state/scratch/session-1/call-1.txt recall=context(scope="recall", ref="01J8")]',
	);
	assert.equal(marker.includes("preview="), false);
	// #203 changes only the transcript projection. The persisted marker keeps
	// the original pointer bytes even if the retention sweep later removes it.
	assert.equal(marker.includes("offload=/state/scratch/session-1/call-1.txt"), true);
});

test("marker: preview collapses whitespace, escapes quotes, and stops at 120 chars", () => {
	const marker = renderMarker({
		ref: { entry: "01J8" },
		reason: "age_horizon",
		toolName: "grep",
		text: '  he said\t"hi"\n\n  then left  ',
	});
	assert.equal(marker.includes('preview="he said \\"hi\\" then left"'), true, marker);

	const long = renderMarker({
		ref: { entry: "01J8" },
		reason: "age_horizon",
		toolName: "grep",
		text: "x".repeat(500),
	});
	assert.equal(long.includes(`preview="${"x".repeat(120)}"`), true);

	// Nothing to preview leaves the field out rather than rendering `preview=""`.
	assert.equal(
		renderMarker({ ref: { entry: "01J8" }, reason: "age_horizon", toolName: "grep", text: "   " }).includes("preview="),
		false,
	);
});

test("marker: a resolved failure keeps its first line instead of a preview", () => {
	const marker = renderMarker({
		ref: { entry: "01J8" },
		reason: "failure_resolved",
		by: "01JC",
		toolName: "bash",
		text: "\n\nmake: *** No rule to make target\n  at build.mk:12\n  at Makefile:3\n",
	});
	assert.equal(
		marker,
		'[evicted ref=01J8 reason=failure_resolved by=01JC tool=bash size=6 lines/68B recall=context(scope="recall", ref="01J8") first_line="make: *** No rule to make target"]',
	);
	assert.equal(marker.includes("preview="), false);
	// Same slot, same bounds, same escaping as a preview.
	const long = renderMarker({
		ref: { entry: "01J8" },
		reason: "failure_resolved",
		toolName: "bash",
		text: `he said "no": ${"x".repeat(500)}\nrest`,
	});
	assert.equal(long.includes(`first_line="he said \\"no\\": ${"x".repeat(106)}"`), true, long);
});
