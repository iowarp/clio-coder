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
const { EvidencePage } = await import("../client/pages/evidence.js");

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
