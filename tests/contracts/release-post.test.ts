import { deepEqual, equal, match, ok } from "node:assert/strict";
import { test } from "node:test";

type Run = (command: string, args: string[]) => string;
interface PostModule {
	ITEMS: string[];
	postPending(context: object): string[];
	postRelease(context: object, io: object): Promise<Record<string, { status: string; note: string; at: string }>>;
	nextDevelopment(version: string): { version: string; branch: string } | null;
	openUnreleased(text: string): string;
}
const load = async (): Promise<PostModule> => {
	const module = "../../scripts/release/post.mjs";
	return (await import(module)) as PostModule;
};

const root = "/clone";
const context = (post: object) => ({
	version: "0.7.1",
	tag: "v0.7.1",
	previousTag: "v0.7.0",
	channel: "latest",
	commit: "c".repeat(40),
	branch: "v071",
	root,
	post,
	home: "/home/op",
});

/** Fake io: answers argv by the first matching rule, records every call, and refuses every confirm. */
function fakeIo(rules: Array<[RegExp, string | Error]>) {
	const calls: string[] = [];
	const asked: string[] = [];
	const run: Run = (command, args) => {
		const line = [command, ...args].join(" ");
		calls.push(line);
		const rule = rules.find(([pattern]) => pattern.test(line));
		if (!rule) throw new Error(`unexpected command: ${line}`);
		if (rule[1] instanceof Error) throw rule[1];
		return rule[1];
	};
	const confirm = async (_description: string, phrase: string) => {
		asked.push(phrase);
		return false;
	};
	return { io: { run, confirm, log() {} }, calls, asked };
}
const absent = new Error("absent");
const mainSha = "a".repeat(40);
const branchSha = "b".repeat(40);

test("post-release reruns only items that are not done or skipped", async () => {
	const { ITEMS, postPending, postRelease } = await load();
	const earlier = Object.fromEntries(ITEMS.map((id) => [id, { status: "done", note: "", at: "" }]));
	const post = { ...earlier, main: { status: "failed", note: "network", at: "" }, issues: undefined };
	deepEqual(postPending(context(post)), ["main", "issues"]);
	const { io, calls } = fakeIo([
		[/fetch --prune/u, ""],
		[/rev-parse --verify --quiet refs\/(remotes\/origin|heads)\/main/u, mainSha],
		[/log --format=%B v0\.7\.0\.\.v0\.7\.1/u, ""],
	]);
	const results = await postRelease(context(post), io);
	equal(results.main?.status, "done");
	equal(results.branch?.status, "done");
	ok(!calls.some((line) => line.includes("v071")), "a done item is not touched again");
});

test("a dirty main worktree and a checked-out version branch are kept, with notes", async () => {
	const { ITEMS, postRelease } = await load();
	const only = (ids: string[]) =>
		Object.fromEntries(ITEMS.filter((id) => !ids.includes(id)).map((id) => [id, { status: "done" }]));
	const { io, calls } = fakeIo([
		[/fetch --prune/u, ""],
		[/rev-parse --verify --quiet refs\/remotes\/origin\/main/u, mainSha],
		[/rev-parse --verify --quiet refs\/heads\/main/u, "d".repeat(40)],
		[/rev-parse --verify --quiet refs\/heads\/v071/u, branchSha],
		[/rev-parse --verify --quiet refs\/remotes\/origin\/v071/u, absent],
		[
			/worktree list --porcelain/u,
			`worktree ${root}\nHEAD ${branchSha}\nbranch refs/heads/v071\n\nworktree /wt/main\nHEAD ${"d".repeat(40)}\nbranch refs/heads/main`,
		],
		[/-C \/wt\/main status --porcelain/u, " M README.md"],
		[/config branch\.v071\.remote/u, "origin"],
		[/config branch\.v071\.merge/u, "refs/heads/v071"],
		[/branch --unset-upstream v071/u, ""],
		[/merge-base --is-ancestor/u, ""],
	]);
	const results = await postRelease(context(only(["main", "branch"])), io);
	equal(results.main?.status, "skipped");
	match(results.main?.note ?? "", /\/wt\/main has uncommitted changes/u);
	equal(results.branch?.status, "skipped");
	match(results.branch?.note ?? "", /checked out at \/clone.*gone upstream unset/u);
	ok(!calls.some((line) => /merge --ff-only|main:main|branch -D/u.test(line)));
});

test("remote writes wait for the typed phrase, and a merged registry PR skips the registry", async () => {
	const { ITEMS, postRelease } = await load();
	const only = (ids: string[]) =>
		Object.fromEntries(ITEMS.filter((id) => !ids.includes(id)).map((id) => [id, { status: "done" }]));
	const { io, calls, asked } = fakeIo([
		[/^gh pr view 562/u, JSON.stringify({ mergedAt: "2026-11-10T00:00:00Z" })],
		[/log --format=%B/u, "fix(x): a\n\nfixes #12\n\nfix(y): b\n\ncloses #13\n"],
		[/^gh issue view 12 /u, JSON.stringify({ state: "CLOSED" })],
		[/^gh issue view 13 /u, JSON.stringify({ state: "OPEN" })],
	]);
	const results = await postRelease(context(only(["acp-registry", "issues"])), io);
	match(results["acp-registry"]?.note ?? "", /#562 merged/u);
	ok(!calls.some((line) => line.includes("acp-registry")), "a merged PR leaves the registry checkout alone");
	equal(results.issues?.status, "skipped");
	match(results.issues?.note ?? "", /open: #13; declined/u);
	deepEqual(asked, ["close issues"]);
	ok(!calls.some((line) => line.startsWith("gh issue close")));
});

test("a prerelease opens no next branch and leaves the registry alone", async () => {
	const { ITEMS, nextDevelopment, openUnreleased, postRelease } = await load();
	deepEqual(nextDevelopment("0.7.1"), { version: "0.7.2-dev", branch: "v072" });
	equal(nextDevelopment("0.7.1-rc.1"), null);
	const post = Object.fromEntries(
		ITEMS.filter((id) => !["next-branch", "acp-registry"].includes(id)).map((id) => [id, { status: "done" }]),
	);
	const { io, calls } = fakeIo([]);
	const results = await postRelease({ ...context(post), version: "0.7.1-rc.1", channel: "beta" }, io);
	equal(results["next-branch"]?.status, "skipped");
	equal(results["acp-registry"]?.status, "skipped");
	deepEqual(calls, []);
	const changelog = "# Changelog\n\nIntro.\n\n## 0.7.1 - 2026-11-09\n";
	const opened = openUnreleased(changelog);
	equal(opened, "# Changelog\n\nIntro.\n\n## Unreleased\n\n## 0.7.1 - 2026-11-09\n");
	equal(openUnreleased(opened), opened);
});
