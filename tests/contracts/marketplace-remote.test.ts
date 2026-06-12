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
		const dataDir = tempDataDir();
		const calls: string[] = [];
		const fetchFn = (async (url: unknown) => {
			calls.push(String(url));
			return jsonResponse(LISTING_FIXTURE);
		}) as typeof fetch;
		const skills = await fetchRemoteMarketplace(dataDir, { fetchFn, nowFn: () => 1000 });
		deepStrictEqual(
			skills.map((skill) => skill.name),
			["arxiv-literature", "data-pipelines"],
		);
		strictEqual(calls.length, 1);
	});

	it("serves from cache inside the TTL and refetches after it expires", async () => {
		const dataDir = tempDataDir();
		let calls = 0;
		const fetchFn = (async () => {
			calls += 1;
			return jsonResponse(LISTING_FIXTURE);
		}) as typeof fetch;
		await fetchRemoteMarketplace(dataDir, { fetchFn, nowFn: () => 0 });
		await fetchRemoteMarketplace(dataDir, { fetchFn, nowFn: () => 60_000 });
		strictEqual(calls, 1, "second call inside TTL must hit the cache");
		await fetchRemoteMarketplace(dataDir, { fetchFn, nowFn: () => 25 * 60 * 60 * 1000 });
		strictEqual(calls, 2, "call after TTL must refetch");
	});

	it("falls back to the stale cache when the network fails", async () => {
		const dataDir = tempDataDir();
		const okFetch = (async () => jsonResponse(LISTING_FIXTURE)) as typeof fetch;
		await fetchRemoteMarketplace(dataDir, { fetchFn: okFetch, nowFn: () => 0 });
		const failFetch = (async () => {
			throw new Error("offline");
		}) as typeof fetch;
		const skills = await fetchRemoteMarketplace(dataDir, {
			fetchFn: failFetch,
			nowFn: () => 48 * 60 * 60 * 1000,
		});
		deepStrictEqual(
			skills.map((skill) => skill.name),
			["arxiv-literature", "data-pipelines"],
		);
	});

	it("falls back to the pinned list when offline with no cache", async () => {
		const dataDir = tempDataDir();
		const failFetch = (async () => {
			throw new Error("offline");
		}) as typeof fetch;
		const skills = await fetchRemoteMarketplace(dataDir, { fetchFn: failFetch });
		ok(Array.isArray(skills));
	});

	it("treats a corrupt cache file as a miss", async () => {
		const dataDir = tempDataDir();
		writeFileSync(path.join(dataDir, "marketplace-cache.json"), "{not json", "utf8");
		const fetchFn = (async () => jsonResponse(LISTING_FIXTURE)) as typeof fetch;
		const skills = await fetchRemoteMarketplace(dataDir, { fetchFn, nowFn: () => 0 });
		strictEqual(skills.length, 2);
	});

	it("fetches, parses, and caches a SKILL.md detail", async () => {
		const dataDir = tempDataDir();
		let calls = 0;
		const skillMd = ["---", 'description: "Search arXiv"', "version: 1.2.0", "---", "", "# Usage", "Run it."].join("\n");
		const fetchFn = (async () => {
			calls += 1;
			return new Response(skillMd, { status: 200 });
		}) as typeof fetch;
		const detail = await fetchRemoteSkillDetail(dataDir, "arxiv-literature", { fetchFn, nowFn: () => 0 });
		strictEqual(detail.description, "Search arXiv");
		strictEqual(detail.version, "1.2.0");
		ok(detail.body.includes("# Usage"));
		strictEqual(detail.source, "remote");
		const again = await fetchRemoteSkillDetail(dataDir, "arxiv-literature", { fetchFn, nowFn: () => 1 });
		strictEqual(calls, 1, "detail must come from cache inside the TTL");
		strictEqual(again.source, "cache");
		const cacheRaw = readFileSync(path.join(dataDir, "marketplace-cache.json"), "utf8");
		ok(cacheRaw.includes("Search arXiv"));
	});

	it("rejects unsafe skill names before any network call", async () => {
		const dataDir = tempDataDir();
		let rejected = false;
		try {
			await fetchRemoteSkillDetail(dataDir, "../escape", {});
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
