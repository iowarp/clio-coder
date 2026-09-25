import assert from "node:assert/strict";
import { test } from "node:test";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { ARTIFACT_MAX_PAGES, ARTIFACT_PAGE_SIZE } from "../client/pages/artifact-pagination.js";
import { Problem } from "../contracts/common.js";
import { EvidencePage } from "../contracts/evidence.js";
import { DispatchRuns, FleetRoots } from "../contracts/fleet.js";
import { ArtifactWindow } from "../server/services/artifact-window.js";
import { harness, json } from "./harness/app.js";
import { seedEvidence } from "./harness/evidence-fixture.js";
import { seedFleet } from "./harness/fleet-fixture.js";

test("the window refuses malformed, unserved and aged-out references before any lookup", () => {
	const artifacts = new ArtifactWindow();
	for (const hostile of [
		"../../etc/passwd",
		"run-alpha/../run-beta",
		"/absolute/run",
		"--force",
		"run alpha",
		"run\0alpha",
		"a".repeat(129),
		"",
		42,
		null,
		undefined,
	])
		assert.throws(() => artifacts.admit("run", hostile), { reason: "malformed" }, `Admitted ${String(hostile)}`);
	// The two operator states a bare 404 would blur together stay apart.
	assert.throws(() => artifacts.admit("evidence", "evidence-000"), { reason: "no-window" });
	artifacts.serve("evidence", ["evidence-000", "evidence-001"]);
	assert.throws(() => artifacts.admit("evidence", "evidence-002"), { reason: "outside-window" });
	assert.equal(artifacts.admit("evidence", "evidence-001"), "evidence-001");
	// Per family: an evidence id is no licence for a run.
	assert.throws(() => artifacts.admit("run", "evidence-001"), { reason: "no-window" });
	// admitAny reports the actionable refusal: refresh beats read-the-record.
	artifacts.serve("dispatch", ["run-a"]);
	assert.equal(artifacts.admitAny(["run", "dispatch"], "run-a"), "run-a");
	assert.throws(() => artifacts.admitAny(["run", "dispatch"], "run-b"), { reason: "outside-window" });
	// A second snapshot narrows; it never widens.
	artifacts.serve("evidence", ["evidence-001", "evidence-002"]);
	assert.equal(artifacts.size("evidence"), 2);
	assert.throws(() => artifacts.admit("evidence", "evidence-000"), { reason: "outside-window" });
	artifacts.extend("evidence", ["evidence-003"]);
	assert.equal(artifacts.size("evidence"), 3);
	artifacts.clear();
	assert.throws(() => artifacts.admit("evidence", "evidence-001"), { reason: "no-window" });
});

test("a projection that over-serves or repeats an id is a server bug, never a widened window", () => {
	const artifacts = new ArtifactWindow();
	assert.throws(
		() =>
			artifacts.serve(
				"run",
				Array.from({ length: 65 }, (_, index) => `run-${index}`),
			),
		/could not record which artifacts/,
	);
	assert.equal(artifacts.size("run"), 0);
	assert.throws(() => artifacts.serve("run", ["run-a", "run-a"]), /could not record which artifacts/);
	// Eviction is oldest-first and only a cursored page may reach it.
	artifacts.serve(
		"run",
		Array.from({ length: 64 }, (_, index) => `run-${index}`),
	);
	artifacts.extend("run", ["run-later"]);
	assert.equal(artifacts.size("run"), 64);
	assert.throws(() => artifacts.admit("run", "run-0"), { reason: "outside-window" });
	assert.equal(artifacts.admit("run", "run-later"), "run-later");
});

test("evidence detail admits only what the listing showed, and a refusal is not a not-found", async (t) => {
	const h = await harness();
	t.after(h.close);
	await seedEvidence(h.home.path, h.home.env);
	const cold = await h.request("/api/evidence/evidence-039");
	assert.equal(cold.status, 403, "A bookmarked detail opened cold names an id this host never served");
	assert.equal((await json(cold, Problem)).code, "unauthorized");
	const page = await json(await h.request("/api/evidence?limit=10"), EvidencePage);
	assert.equal(page.items[0]?.overview.evidenceId, "evidence-039");
	assert.equal((await h.request("/api/evidence/evidence-039")).status, 200);
	// Well-shaped but never served: refused rather than looked up and 404ed.
	const invented = await h.request("/api/evidence/evidence-999");
	assert.equal(invented.status, 403);
	assert.match((await json(invented, Problem)).detail, /not in the record this session is showing/);
	// A refresh replaces the window instead of widening it, so page one's tail ages out.
	assert.equal((await h.request("/api/evidence?limit=3")).status, 200);
	assert.equal((await h.request("/api/evidence/evidence-030")).status, 403);
	assert.equal((await h.request("/api/evidence/evidence-039")).status, 200);
});

test("a run id reaches no child process until a fleet listing has served it", async (t) => {
	const h = await harness();
	t.after(h.close);
	const seeded = await seedEvidence(h.home.path, h.home.env);
	const workspace = await h.workspaces.open(h.home.path);
	for (const path of [
		`/api/workspaces/${workspace.id}/evidence/${seeded.runId}/build`,
		`/api/workspaces/${workspace.id}/receipts/${seeded.runId}/verify`,
	]) {
		const refused = await h.post(path);
		assert.equal(refused.status, 403);
		assert.equal((await json(refused, Problem)).code, "unauthorized");
	}
	assert.equal(h.cli.activeCount, 0, "A refused reference must not start a CLI child");
	assert.equal(h.operations.activeCount, 0, "A refused reference must not create an operation row");
	assert.equal((await h.request(`/api/fleet/receipts/${seeded.runId}`)).status, 403);
	await seedFleet(h.home.path, h.home.env);
	const dispatches = await json(await h.request("/api/fleet/dispatches"), DispatchRuns);
	assert.ok(dispatches.items.length > 0);
	const served = dispatches.items[0]?.id ?? "";
	assert.equal((await h.request(`/api/fleet/receipts/${served}`)).status, 200);
	// The fleet page shows roots and dispatches at once, so their windows are
	// separate: reading one listing must not unlink the other's receipts.
	const roots = await json(await h.request("/api/fleet/runs?limit=5"), FleetRoots);
	assert.ok(roots.items.length > 0);
	assert.equal((await h.request(`/api/fleet/receipts/${served}`)).status, 200);
	assert.equal((await h.request(`/api/fleet/receipts/${roots.items[0]?.id}`)).status, 200);
	// A refresh of one listing still narrows that listing's own window.
	const narrowed = await json(await h.request("/api/fleet/dispatches?limit=1"), DispatchRuns);
	assert.equal(narrowed.items.length, 1);
	if (narrowed.items[0]?.id !== served) assert.equal((await h.request(`/api/fleet/receipts/${served}`)).status, 403);
});

test("every response carries the full security header set", async (t) => {
	const h = await harness();
	t.after(h.close);
	for (const path of ["/api/meta", "/api/evidence/not-served"]) {
		const response = await h.request(path);
		const csp = response.headers.get("Content-Security-Policy") ?? "";
		assert.match(csp, /object-src 'none'/);
		assert.match(csp, /form-action 'self'/);
		assert.match(csp, /frame-ancestors 'none'/);
		assert.equal(response.headers.get("X-Frame-Options"), "DENY");
		assert.equal(response.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
		assert.equal(response.headers.get("Cross-Origin-Resource-Policy"), "same-origin");
		assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
		assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
		assert.match(response.headers.get("Permissions-Policy") ?? "", /camera=\(\)/);
	}
});

test("every evidence link the paginated page still renders stays admitted, even while the next page is in flight", async () => {
	const artifacts = new ArtifactWindow();
	const served = Array.from({ length: 200 }, (_, index) => `evidence-${String(index).padStart(3, "0")}`);
	const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	let loseResponse = false;
	// Mirrors EvidencePage: the same page size and retention, fed by a stand-in
	// for the list route that records what it served exactly as the route does.
	const observer = new InfiniteQueryObserver(queries, {
		queryKey: ["evidence"],
		initialPageParam: undefined as string | undefined,
		queryFn: async ({ pageParam }) => {
			const start = pageParam ? Number(pageParam) : 0;
			const ids = served.slice(start, start + ARTIFACT_PAGE_SIZE);
			artifacts.page("evidence", pageParam, ids);
			for (const id of rendered()) assert.equal(artifacts.admit("evidence", id), id, "Rendered while the next page loads");
			if (loseResponse) throw new Error("response lost after the server recorded the page");
			const next = start + ids.length;
			return { ids, nextCursor: next < served.length ? String(next) : null };
		},
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		maxPages: ARTIFACT_MAX_PAGES,
	});
	const rendered = () => observer.getCurrentResult().data?.pages.flatMap((page) => page.ids) ?? [];
	const unsubscribe = observer.subscribe(() => {});
	try {
		await observer.refetch();
		for (let page = 0; page < 6; page++) {
			const result = await observer.fetchNextPage();
			assert.equal(result.status, "success", String(result.error));
			for (const id of rendered()) assert.equal(artifacts.admit("evidence", id), id);
		}
		// A load-more whose response never reaches the browser leaves the old pages
		// on screen, so the server must not have evicted them either.
		loseResponse = true;
		const before = rendered();
		assert.equal((await observer.fetchNextPage()).status, "error");
		assert.deepEqual(rendered(), before);
		for (const id of before) assert.equal(artifacts.admit("evidence", id), id);
		// Retention stays bounded: the first page aged out on both sides.
		assert.throws(() => artifacts.admit("evidence", "evidence-000"), { reason: "outside-window" });
	} finally {
		unsubscribe();
		queries.clear();
	}
});
