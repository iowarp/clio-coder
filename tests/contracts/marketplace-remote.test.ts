import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	fetchRemoteMarketplace,
	fetchRemoteSkillDetail,
	isSafeSkillName,
	parseSkillMarkdown,
} from "../../src/domains/resources/marketplace-remote.js";

function tempDataDir(): string {
	return mkdtempSync(path.join(tmpdir(), "clio-marketplace-"));
}

function jsonResponse(payload: unknown): Response {
	return new Response(JSON.stringify(payload), { status: 200 });
}

const LISTING_FIXTURE = [
	{
		name: "arxiv-literature",
		type: "dir",
		html_url: "https://github.com/iowarp/clio-coder/tree/main/skills/arxiv-literature",
	},
	{ name: "README.md", type: "file" },
	{ name: "../evil", type: "dir" },
	{ name: "data-pipelines", type: "dir" },
];

describe("contracts/marketplace-remote", () => {
	it("lists remote skill directories, filtering files and unsafe names", async () => {
		const cacheDir = tempDataDir();
		const calls: string[] = [];
		const fetchFn = (async (url: unknown) => {
			calls.push(String(url));
			return jsonResponse(LISTING_FIXTURE);
		}) as typeof fetch;
		const skills = await fetchRemoteMarketplace(cacheDir, { fetchFn, nowFn: () => 1000 });
		deepStrictEqual(
			skills.map((skill) => skill.name),
			["arxiv-literature", "data-pipelines"],
		);
		strictEqual(calls.length, 1);
	});

	it("serves from cache inside the TTL and refetches after it expires", async () => {
		const cacheDir = tempDataDir();
		let calls = 0;
		const fetchFn = (async () => {
			calls += 1;
			return jsonResponse(LISTING_FIXTURE);
		}) as typeof fetch;
		await fetchRemoteMarketplace(cacheDir, { fetchFn, nowFn: () => 0 });
		await fetchRemoteMarketplace(cacheDir, { fetchFn, nowFn: () => 60_000 });
		strictEqual(calls, 1, "second call inside TTL must hit the cache");
		await fetchRemoteMarketplace(cacheDir, { fetchFn, nowFn: () => 25 * 60 * 60 * 1000 });
		strictEqual(calls, 2, "call after TTL must refetch");
	});

	it("falls back to the stale cache when the network fails", async () => {
		const cacheDir = tempDataDir();
		const okFetch = (async () => jsonResponse(LISTING_FIXTURE)) as typeof fetch;
		await fetchRemoteMarketplace(cacheDir, { fetchFn: okFetch, nowFn: () => 0 });
		const failFetch = (async () => {
			throw new Error("offline");
		}) as typeof fetch;
		const skills = await fetchRemoteMarketplace(cacheDir, {
			fetchFn: failFetch,
			nowFn: () => 48 * 60 * 60 * 1000,
		});
		deepStrictEqual(
			skills.map((skill) => skill.name),
			["arxiv-literature", "data-pipelines"],
		);
	});

	it("falls back to the pinned list when offline with no cache", async () => {
		const cacheDir = tempDataDir();
		const failFetch = (async () => {
			throw new Error("offline");
		}) as typeof fetch;
		const skills = await fetchRemoteMarketplace(cacheDir, { fetchFn: failFetch });
		ok(Array.isArray(skills));
	});

	it("treats a corrupt cache file as a miss", async () => {
		const cacheDir = tempDataDir();
		writeFileSync(path.join(cacheDir, "marketplace-cache.json"), "{not json", "utf8");
		const fetchFn = (async () => jsonResponse(LISTING_FIXTURE)) as typeof fetch;
		const skills = await fetchRemoteMarketplace(cacheDir, { fetchFn, nowFn: () => 0 });
		strictEqual(skills.length, 2);
	});

	it("fetches, parses, and caches a SKILL.md detail", async () => {
		const cacheDir = tempDataDir();
		let calls = 0;
		const skillMd = ["---", 'description: "Search arXiv"', "version: 1.2.0", "---", "", "# Usage", "Run it."].join("\n");
		const fetchFn = (async () => {
			calls += 1;
			return new Response(skillMd, { status: 200 });
		}) as typeof fetch;
		const detail = await fetchRemoteSkillDetail(cacheDir, "arxiv-literature", { fetchFn, nowFn: () => 0 });
		strictEqual(detail.description, "Search arXiv");
		strictEqual(detail.version, "1.2.0");
		ok(detail.body.includes("# Usage"));
		strictEqual(detail.source, "remote");
		const again = await fetchRemoteSkillDetail(cacheDir, "arxiv-literature", { fetchFn, nowFn: () => 1 });
		strictEqual(calls, 1, "detail must come from cache inside the TTL");
		strictEqual(again.source, "cache");
		const cacheRaw = readFileSync(path.join(cacheDir, "marketplace-cache.json"), "utf8");
		ok(cacheRaw.includes("Search arXiv"));
	});

	it("threads an abort signal into the listing fetch and falls back when it is already aborted", async () => {
		const cacheDir = tempDataDir();
		const controller = new AbortController();
		controller.abort();
		let sawSignal: AbortSignal | undefined;
		const fetchFn = (async (_url: unknown, init?: RequestInit) => {
			sawSignal = init?.signal ?? undefined;
			if (sawSignal?.aborted) throw new DOMException("aborted", "AbortError");
			return jsonResponse(LISTING_FIXTURE);
		}) as typeof fetch;
		const skills = await fetchRemoteMarketplace(cacheDir, { fetchFn, signal: controller.signal });
		ok(sawSignal instanceof AbortSignal, "a signal must be threaded into fetch");
		ok(sawSignal.aborted, "the caller's aborted signal must propagate through the combined signal");
		ok(Array.isArray(skills), "an aborted listing with no cache falls back to the pinned list");
	});

	it("falls back to the cached listing when an in-flight detail fetch aborts", async () => {
		const cacheDir = tempDataDir();
		const skillMd = "---\ndescription: cached desc\n---\nbody";
		await fetchRemoteSkillDetail(cacheDir, "arxiv-literature", {
			fetchFn: (async () => new Response(skillMd, { status: 200 })) as typeof fetch,
			nowFn: () => 0,
		});
		const controller = new AbortController();
		controller.abort();
		const aborting = (async (_url: unknown, init?: RequestInit) => {
			if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
			return new Response("---\ndescription: fresh\n---\nnew", { status: 200 });
		}) as typeof fetch;
		const detail = await fetchRemoteSkillDetail(cacheDir, "arxiv-literature", {
			fetchFn: aborting,
			signal: controller.signal,
			nowFn: () => 1,
		});
		strictEqual(detail.source, "cache");
		strictEqual(detail.description, "cached desc");
	});

	it("does not let a cold detail fetch publish an empty skills listing", async () => {
		const cacheDir = tempDataDir();
		// Detail fetched before any listing ever succeeded (cold cache).
		await fetchRemoteSkillDetail(cacheDir, "arxiv-literature", {
			fetchFn: (async () => new Response("---\ndescription: hi\n---\nbody", { status: 200 })) as typeof fetch,
			nowFn: () => 5,
		});
		// The listing must still fetch rather than serving the empty skills array
		// the detail write left behind, even well inside the TTL window.
		let listingCalls = 0;
		const listingFetch = (async () => {
			listingCalls += 1;
			return jsonResponse(LISTING_FIXTURE);
		}) as typeof fetch;
		const skills = await fetchRemoteMarketplace(cacheDir, { fetchFn: listingFetch, nowFn: () => 6 });
		strictEqual(listingCalls, 1, "the listing must fetch, not serve the poisoned empty listing");
		deepStrictEqual(
			skills.map((skill) => skill.name),
			["arxiv-literature", "data-pipelines"],
		);
		// The detail written before the listing is still cached and fresh.
		let detailCalls = 0;
		const detail = await fetchRemoteSkillDetail(cacheDir, "arxiv-literature", {
			fetchFn: (async () => {
				detailCalls += 1;
				return new Response("x", { status: 200 });
			}) as typeof fetch,
			nowFn: () => 7,
		});
		strictEqual(detailCalls, 0, "the detail cached before the listing must survive");
		strictEqual(detail.source, "cache");
	});

	it("rejects unsafe skill names before any network call", async () => {
		const cacheDir = tempDataDir();
		let rejected = false;
		try {
			await fetchRemoteSkillDetail(cacheDir, "../escape", {});
		} catch {
			rejected = true;
		}
		strictEqual(rejected, true);
	});

	it("parseSkillMarkdown handles frontmatter, CRLF, and missing terminators", () => {
		deepStrictEqual(parseSkillMarkdown("plain body"), { body: "plain body" });
		const crlf = "---\r\ndescription: hi\r\n---\r\nbody text";
		strictEqual(parseSkillMarkdown(crlf).description, "hi");
		strictEqual(parseSkillMarkdown(crlf).body, "body text");
		const unterminated = "---\ndescription: hi\nbody without end";
		strictEqual(parseSkillMarkdown(unterminated).description, undefined);
		ok(parseSkillMarkdown(unterminated).body.includes("description"));
	});

	it("isSafeSkillName accepts plain names and rejects traversal", () => {
		ok(isSafeSkillName("arxiv-literature"));
		ok(isSafeSkillName("data_pipelines.v2"));
		strictEqual(isSafeSkillName("../evil"), false);
		strictEqual(isSafeSkillName("a/b"), false);
		strictEqual(isSafeSkillName(""), false);
		strictEqual(isSafeSkillName(".hidden"), false);
	});
});
