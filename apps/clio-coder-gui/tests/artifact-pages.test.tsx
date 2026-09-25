import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { Client } from "../client/api/client.js";

// Page modules import their stylesheets, which only Vite can load, and tsx
// compiles client files outside this tsconfig with the classic JSX runtime. Stub
// the stylesheets and expose React so the page renders under Node.
(globalThis as { React?: typeof React }).React = React;
register(
	`data:text/javascript,${encodeURIComponent(
		'export async function load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); }',
	)}`,
);
const { CollectedEvidence, EvidencePage } = await import("../client/pages/evidence.js");
const { FleetPage } = await import("../client/pages/fleet.js");

const client = { token: "t", call: () => new Promise(() => {}) } as unknown as Client;

function render(queries: QueryClient, node: ReactNode) {
	return renderToStaticMarkup(
		<QueryClientProvider client={queries}>
			<MemoryRouter>{node}</MemoryRouter>
		</QueryClientProvider>,
	);
}

function listed(staleTime: number) {
	const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime } } });
	queries.setQueryData(["evidence"], {
		pageParams: [undefined],
		pages: [
			{
				nextCursor: "next",
				items: [
					{
						verdict: "grounded",
						overview: {
							evidenceId: "evidence-007",
							generatedAt: "2026-09-24T00:00:00.000Z",
							tasks: [],
							totals: { runs: 1, receipts: 1 },
						},
					},
				],
			},
		],
	});
	return queries;
}

test("the evidence list offers its links only while no refresh can have narrowed the window", () => {
	const settled = render(listed(Number.POSITIVE_INFINITY), <EvidencePage client={client} />);
	assert.match(settled, /href="\/evidence\/evidence-007"/);
	assert.match(settled, /<button type="button">Load more evidence<\/button>/);
	// Stale data refetches on mount, which is a refresh: the id stays readable as
	// text, but nothing links to it and load-more cannot start from the old cursor.
	const refreshing = render(listed(0), <EvidencePage client={client} />);
	assert.match(refreshing, /evidence-007/);
	assert.doesNotMatch(refreshing, /href="\/evidence\/evidence-007"/);
	assert.match(refreshing, /<button type="button" disabled="">Load more evidence<\/button>/);
});

test("newly collected evidence is named, never linked to its unlisted detail", () => {
	const html = render(new QueryClient(), <CollectedEvidence id="evidence-new" />);
	assert.match(html, /<code>evidence-new<\/code>/);
	assert.doesNotMatch(html, /href=/);
});

test("both fleet lists offer links only while settled, and render nothing after a failed refresh", () => {
	const fleet = (staleTime: number) => {
		const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime } } });
		const page = <T,>(item: T) => ({ pageParams: [undefined], pages: [{ nextCursor: "next", items: [item] }] });
		queries.setQueryData(
			["fleet-roots"],
			page({
				id: "root-1",
				fleet: "nightly",
				endedAt: null,
				completedCount: 0,
				stepCount: 1,
				startedAt: "2026-09-24T00:00:00.000Z",
			}),
		);
		queries.setQueryData(
			["fleet-dispatches"],
			page({
				id: "run-1",
				agentId: "worker",
				outcome: null,
				status: "running",
				targetId: "local",
				wireModelId: "m",
				tokenCount: 1,
			}),
		);
		return queries;
	};
	const links = /href="\/fleet\/(root-1|dispatches\/run-1)"/g;
	const settled = render(fleet(Number.POSITIVE_INFINITY), <FleetPage client={client} />);
	assert.equal(settled.match(links)?.length, 2);
	assert.match(settled, /<button type="button">Load more fleet runs<\/button>/);
	assert.match(settled, /<button type="button">Load more dispatch runs<\/button>/);
	// Stale data refetches on mount: a fresh first page may already have replaced
	// each family's window, so the retained ids are text and load-more waits.
	const refreshing = render(fleet(0), <FleetPage client={client} />);
	assert.match(refreshing, /nightly/);
	assert.match(refreshing, /run-1/);
	assert.equal(refreshing.match(links), null);
	assert.match(refreshing, /<button type="button" disabled="">Load more fleet runs<\/button>/);
	assert.match(refreshing, /<button type="button" disabled="">Load more dispatch runs<\/button>/);
	// A refresh that failed after narrowing leaves stale pages cached; none renders.
	const failed = fleet(Number.POSITIVE_INFINITY);
	for (const key of ["fleet-roots", "fleet-dispatches"])
		failed
			.getQueryCache()
			.find({ queryKey: [key] })
			?.setState({ status: "error", error: new Error("refresh failed"), fetchStatus: "idle" });
	const broken = render(failed, <FleetPage client={client} />);
	assert.doesNotMatch(broken, /nightly|run-1|Load more/);
	assert.match(broken, /refresh failed/);
});
