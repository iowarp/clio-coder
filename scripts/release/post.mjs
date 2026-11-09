/**
 * Post-release close-out (design section 11). Each item reads first, writes local state only
 * unless the operator types the item's phrase, and records done, skipped or failed with a
 * one-line note. Every command goes through `io.run`, so a rerun after a crash re-reads state
 * and does only what is left.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ITEMS = ["main", "branch", "next-branch", "acp-registry", "local-install", "issues"];

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/u;
const DEV_FILES = ["package.json", "apps/clio-coder-gui/package.json", "assets/acp-registry/agent.json"];
const REGISTRY_PR = ["pr", "view", "562", "--repo", "agentclientprotocol/registry", "--json", "mergedAt"];

/** Read-only. Ids of items not yet done or skipped; a failed item is pending again. */
export function postPending(context) {
	return ITEMS.filter((id) => !["done", "skipped"].includes(context.post?.[id]?.status));
}

/** Runs each pending item in ITEMS order; one item failing is recorded and the next still runs. */
export async function postRelease(context, io) {
	const results = { ...context.post };
	const ctx = helpers(context, io);
	for (const id of postPending(context)) {
		let outcome;
		try {
			outcome = await STEPS[id](ctx);
		} catch (error) {
			// The release is already public; a close-out failure is reported, never undone.
			const message = error instanceof Error ? error.message : String(error);
			outcome = { status: "failed", note: message.trim().split("\n")[0] };
		}
		results[id] = { ...outcome, at: new Date().toISOString() };
		io.log(`${id}: ${outcome.status}: ${outcome.note}`);
	}
	return results;
}

/** `0.7.1` -> `{ version: "0.7.2-dev", branch: "v072" }`; a prerelease opens no branch. */
export function nextDevelopment(version) {
	const match = STABLE.exec(version);
	if (!match) return null;
	const patch = Number(match[3]) + 1;
	return { version: `${match[1]}.${match[2]}.${patch}-dev`, branch: `v${match[1]}${match[2]}${patch}` };
}

/** Issue numbers GitHub's closing keywords name in commit messages, first-seen order. */
export function closedReferences(messages) {
	const found = new Set();
	for (const match of String(messages).matchAll(/\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+#(\d+)\b/giu))
		found.add(Number(match[1]));
	return [...found];
}

/** Rewrites only the top-level `"version"` value and keeps each file's own formatting. */
export function setJsonVersion(text, version) {
	const match = /^(\t| {2})"version": "[^"]*"/mu.exec(text);
	if (!match) throw new Error("no top-level version field");
	return `${text.slice(0, match.index)}${match[1]}"version": "${version}"${text.slice(match.index + match[0].length)}`;
}

/** The development changelog opens with an empty `## Unreleased` above the newest release. */
export function openUnreleased(text) {
	const first = text.search(/^## /mu);
	if (first < 0) throw new Error("CHANGELOG.md has no release section");
	return text.startsWith("## Unreleased", first) ? text : `${text.slice(0, first)}## Unreleased\n\n${text.slice(first)}`;
}

export const stripSvgComments = (svg) => `${svg.replace(/<!--[\s\S]*?-->\s*/gu, "").trimEnd()}\n`;

const done = (note) => ({ status: "done", note });
const skipped = (note) => ({ status: "skipped", note });
const declined = (command) => skipped(`declined; later run: ${command}`);
const short = (sha) => sha.slice(0, 12);

function helpers(context, io) {
	const git = (...args) => io.run("git", ["-C", context.root, ...args], {}).trim();
	const gitIn = (dir, ...args) => io.run("git", ["-C", dir, ...args], {}).trim();
	const probe = (fn) => {
		try {
			return fn();
		} catch {
			// A failed read here means an absent ref, branch or file; callers treat null as absent.
			return null;
		}
	};
	const ref = (dir, name) => probe(() => gitIn(dir, "rev-parse", "--verify", "--quiet", name)) || null;
	const worktrees = (dir, branch) =>
		gitIn(dir, "worktree", "list", "--porcelain")
			.split("\n\n")
			.filter((entry) => entry.split("\n").includes(`branch refs/heads/${branch}`))
			.map((entry) => entry.split("\n")[0].slice("worktree ".length));
	return { ...context, io, git, gitIn, probe, ref, worktrees };
}

const STEPS = {
	main(ctx) {
		const { git, gitIn, ref, root } = ctx;
		git("fetch", "--prune", "--quiet", "origin");
		const origin = ref(root, "refs/remotes/origin/main");
		const local = ref(root, "refs/heads/main");
		if (!origin) return skipped("origin has no main branch");
		if (local === origin) return done(`main already at origin/main ${short(origin)}`);
		const [tree] = ctx.worktrees(root, "main");
		if (tree && gitIn(tree, "status", "--porcelain"))
			return skipped(`main at ${tree} has uncommitted changes; fast-forward it by hand`);
		if (local && ctx.probe(() => git("merge-base", "--is-ancestor", local, origin)) === null)
			return skipped("local main has commits origin/main lacks; reconcile it by hand");
		if (tree) gitIn(tree, "merge", "--ff-only", "--quiet", "origin/main");
		else git("fetch", "--quiet", "origin", "main:main");
		return done(`main fast-forwarded to ${short(origin)}${tree ? ` in ${tree}` : ""}`);
	},

	branch(ctx) {
		const { git, ref, root, branch } = ctx;
		const tip = ref(root, `refs/heads/${branch}`);
		if (!tip) return done(`${branch} already removed locally`);
		const did = [];
		const remote = ctx.probe(() => git("config", `branch.${branch}.remote`));
		const merge = ctx.probe(() => git("config", `branch.${branch}.merge`));
		if (remote && merge && !ref(root, `refs/remotes/${remote}/${merge.replace(/^refs\/heads\//u, "")}`)) {
			git("branch", "--unset-upstream", branch);
			did.push("gone upstream unset");
		}
		const merged = ctx.probe(() => git("merge-base", "--is-ancestor", tip, "origin/main")) !== null;
		const at = ctx.worktrees(root, branch);
		const keep = !merged
			? "not merged into origin/main"
			: at.length
				? `checked out at ${at.join(", ")}; switch it away, then git branch -d ${branch}`
				: null;
		if (keep) return skipped(`${branch} kept: ${keep}${did.length ? `; ${did.join("; ")}` : ""}`);
		// Ancestry of origin/main is proven above; -d would instead test the operator's unrelated HEAD.
		git("branch", "-D", branch);
		return done(`${branch} deleted (was ${short(tip)})${did.length ? `; ${did.join("; ")}` : ""}`);
	},

	async "next-branch"(ctx) {
		const { git, gitIn, ref, root } = ctx;
		const next = ctx.channel === "latest" ? nextDevelopment(ctx.version) : null;
		if (!next) return skipped(`prerelease; development continues on ${ctx.branch}`);
		const name = next.branch;
		const remote = git("ls-remote", "--heads", "origin", name).split(/\s/u)[0] || null;
		let tip = ref(root, `refs/heads/${name}`);
		if (remote && tip === remote) return done(`${name} is on origin at ${short(remote)}`);
		if (remote) return skipped(`origin already has ${name} and the local branch differs; reconcile it by hand`);
		const version = (rev) => ctx.probe(() => JSON.parse(git("show", `${rev}:package.json`)).version);
		const origin = git("rev-parse", "origin/main");
		const bump = !tip || version(tip) !== next.version;
		if (tip && bump && tip !== origin)
			return skipped(`local ${name} exists without the ${next.version} bump; inspect it by hand`);
		// Commits go into a throwaway worktree of the clone, so no checkout the operator uses is switched.
		const tree = join(git("rev-parse", "--path-format=absolute", "--git-common-dir"), "clio-release", `wt-${name}`);
		if (existsSync(tree)) git("worktree", "remove", "--force", tree);
		git("worktree", "add", "--quiet", ...(tip ? [tree, name] : ["-b", name, tree, origin]));
		const made = [];
		try {
			if (bump) {
				for (const file of DEV_FILES)
					writeFileSync(join(tree, file), setJsonVersion(readFileSync(join(tree, file), "utf8"), next.version));
				const changelog = join(tree, "CHANGELOG.md");
				writeFileSync(changelog, openUnreleased(readFileSync(changelog, "utf8")));
				gitIn(tree, "add", "--", ...DEV_FILES, "CHANGELOG.md");
				gitIn(tree, "commit", "--quiet", "-m", `chore: start ${next.version.replace(/-dev$/u, "")} development`);
				made.push("dev bump");
			}
			ctx.io.run("python3", ["site/sync-docs.py", "--snapshot-ref", ctx.commit], { cwd: tree });
			if (gitIn(tree, "status", "--porcelain")) {
				gitIn(tree, "add", "--all", "--", "site/content");
				gitIn(tree, "commit", "--quiet", "-m", `docs(site): pin the public docs to the ${ctx.version} release commit`);
				made.push("docs snapshot");
			}
		} finally {
			git("worktree", "remove", "--force", tree);
		}
		tip = git("rev-parse", name);
		const local = `${name} at ${short(tip)}${made.length ? ` (${made.join(", ")})` : ""}`;
		const push = `git -C ${root} push --set-upstream origin ${name}`;
		if (!(await ctx.io.confirm(`Push the new development branch ${local}:\n  ${push}`, `push ${name}`)))
			return declined(push);
		git("push", "--quiet", "--set-upstream", "origin", name);
		return done(`${local} pushed to origin`);
	},

	async "acp-registry"(ctx) {
		const { git, gitIn, ref } = ctx;
		if (ctx.channel !== "latest") return skipped("prerelease; the ACP registry carries stable releases only");
		if (JSON.parse(ctx.io.run("gh", REGISTRY_PR, {})).mergedAt)
			return skipped("agentclientprotocol/registry#562 merged; its hourly updater tracks npm");
		const registry = join(ctx.home, "iowarp/acp-registry");
		if (!existsSync(join(registry, ".git"))) return skipped(`no acp-registry checkout at ${registry}`);
		gitIn(registry, "fetch", "--quiet", "origin", "main");
		// A fork without the PR branch yet starts the record from the shipped agent.json below.
		ctx.probe(() => gitIn(registry, "fetch", "--quiet", "fork", "add-clio-coder"));
		const agentAt = (rev) => ctx.probe(() => JSON.parse(gitIn(registry, "show", `${rev}:clio-coder/agent.json`))) ?? null;
		const fork = ref(registry, "refs/remotes/fork/add-clio-coder") ?? "";
		if (fork && agentAt(fork)?.version === ctx.version) return done(`fork add-clio-coder already carries ${ctx.version}`);
		const branch = `prep/clio-coder-${ctx.version}`;
		const tip = ref(registry, `refs/heads/${branch}`);
		const [existing] = ctx.worktrees(registry, branch);
		const tree = existing ?? join(`${registry}-wt`, `prep-${ctx.version.replaceAll(".", "")}`);
		if (tip && agentAt(tip)?.version !== ctx.version)
			return skipped(`local ${branch} does not carry ${ctx.version}; inspect it by hand`);
		if (!tip) {
			// A fresh branch from origin/main in its own worktree; the maintainer's checked-out branch is never touched.
			gitIn(registry, "worktree", "add", "--quiet", "-b", branch, tree, "origin/main");
			const agent =
				agentAt(fork || "refs/remotes/fork/add-clio-coder") ??
				(({ $schema: _schema, ...shipped }) => shipped)(
					JSON.parse(git("show", `${ctx.commit}:assets/acp-registry/agent.json`)),
				);
			agent.version = ctx.version;
			agent.distribution.npx.package = `@iowarp/clio-coder@${ctx.version}`;
			mkdirSync(join(tree, "clio-coder"), { recursive: true });
			writeFileSync(join(tree, "clio-coder/agent.json"), `${JSON.stringify(agent, null, 2)}\n`);
			writeFileSync(
				join(tree, "clio-coder/icon.svg"),
				stripSvgComments(git("show", `${ctx.commit}:assets/acp-registry/icon.svg`)),
			);
			try {
				const build = [".github/workflows/build_registry.py", "--agents", "clio-coder"];
				ctx.io.run("uv", ["run", "--with", "jsonschema", ...build], { cwd: tree });
				ctx.io.run("python3", [".github/workflows/verify_agents.py", "--auth-check", "--agent", "clio-coder"], {
					cwd: tree,
				});
			} finally {
				rmSync(join(tree, ".sandbox"), { recursive: true, force: true });
			}
			gitIn(tree, "add", "--", "clio-coder");
			gitIn(tree, "commit", "--quiet", "-m", "Add Clio Coder");
		}
		const head = short(gitIn(registry, "rev-parse", branch));
		// The PR branch predates the fresh base, so it is replaced under a lease on the fork state just read.
		const args = [
			"push",
			`--force-with-lease=refs/heads/add-clio-coder:${fork}`,
			"fork",
			`${branch}:refs/heads/add-clio-coder`,
		];
		const local = `${branch} at ${head} in ${tree}`;
		const command = `git -C ${registry} ${args.join(" ")}`;
		if (
			!(await ctx.io.confirm(`Update agentclientprotocol/registry#562 from ${local}:\n  ${command}`, "push acp-registry"))
		)
			return declined(command);
		gitIn(registry, ...args);
		return done(`${local} pushed to fork add-clio-coder`);
	},

	async "local-install"(ctx) {
		const launcher = join(ctx.home, ".local/bin/clio-coder");
		const target = ctx.probe(() => ctx.io.run("readlink", ["-f", launcher], {}).trim());
		if (!target?.endsWith("/dist/cli/index.js")) return skipped(`${launcher} does not point into a checkout's dist/`);
		const checkout = dirname(dirname(dirname(target)));
		const name = ctx.probe(() => JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")).name);
		if (name !== "@iowarp/clio-coder") return skipped(`${checkout} is not a Clio Coder checkout`);
		const head = ctx.gitIn(checkout, "rev-parse", "--short=7", "HEAD");
		const built = builtCommit(join(checkout, "dist"));
		if (built === head) return done(`dist/ in ${checkout} already built from ${head}`);
		const status = ctx.probe(() => JSON.parse(ctx.io.run(launcher, ["gui", "background", "status"], { cwd: checkout })));
		const restart = Boolean(status?.running);
		const steps = [`pnpm run build`, ...(restart ? ["clio-coder gui background restart --if-idle"] : [])];
		const description = `Rebuild the local install in ${checkout} (dist/ ${built ?? "absent"} -> ${head}): ${steps.join(", then ")}`;
		if (!(await ctx.io.confirm(description, "rebuild local install")))
			return declined(`cd ${checkout} && ${steps.join(" && ")}`);
		ctx.io.run("pnpm", ["run", "build"], { cwd: checkout });
		const gui = restart
			? ctx.io.run(launcher, ["gui", "background", "restart", "--if-idle"], { cwd: checkout }).trim().split("\n").at(-1)
			: "GUI service not running, left alone";
		return done(`dist/ in ${checkout} rebuilt from ${head}; ${gui}`);
	},

	async issues(ctx) {
		const range = ctx.previousTag ? `${ctx.previousTag}..${ctx.tag}` : ctx.tag;
		const numbers = closedReferences(ctx.git("log", "--format=%B", range));
		if (!numbers.length) return done(`no closing references in ${range}`);
		const open = numbers.filter(
			(number) =>
				JSON.parse(
					ctx.io.run("gh", ["issue", "view", String(number), "--repo", "iowarp/clio-coder", "--json", "state"], {}),
				).state !== "CLOSED",
		);
		if (!open.length) return done(`all ${numbers.length} referenced issues closed (${range})`);
		const list = open.map((number) => `#${number}`).join(" ");
		const comment = `Fixed in ${ctx.tag}.`;
		const description = `Still open after ${ctx.tag} (${range}): ${list}. Close each with the comment "${comment}"?`;
		if (!(await ctx.io.confirm(description, "close issues")))
			return skipped(
				`open: ${list}; declined; later run: gh issue close <n> --repo iowarp/clio-coder --comment "${comment}"`,
			);
		for (const number of open)
			ctx.io.run("gh", ["issue", "close", String(number), "--repo", "iowarp/clio-coder", "--comment", comment], {});
		return done(`closed ${list}`);
	},
};

// tsup inlines the build commit into readBuildProvenance (src/core/build-info.ts); scripts/check-dist.mjs reads it the same way.
const RECORDED = /function readBuildProvenance\(\)\s*\{[^}]*?commit:\s*"([0-9a-f]+)"/u;
function builtCommit(dist) {
	if (!existsSync(dist)) return null;
	for (const name of readdirSync(dist).filter((entry) => entry.endsWith(".js"))) {
		const built = RECORDED.exec(readFileSync(join(dist, name), "utf8"))?.[1];
		if (built !== undefined) return built;
	}
	return null;
}
