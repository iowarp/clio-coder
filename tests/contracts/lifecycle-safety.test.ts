import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { assertClioDirLayout, type ClioDirs, clioDirLayoutProblems } from "../../src/core/xdg.js";
import type { Installation } from "../../src/domains/lifecycle/install-method.js";
import {
	planSelfUpgrade,
	runApprovedSelfUpgrade,
	type SelfUpgradePlan,
} from "../../src/domains/lifecycle/self-upgrade.js";
import { createInteractiveUpgradeFlow } from "../../src/interactive/interactive-upgrade.js";
import type { AskUserHandler } from "../../src/tools/ask-user.js";

function npmInstallation(root: string): Installation {
	return {
		kind: "npm",
		root,
		entry: join(root, "dist", "cli", "index.js"),
		prefix: join(root, "prefix"),
	};
}

async function eventually(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition was not reached");
}

test("lifecycle roots must be distinct and non-nesting through symlink aliases", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "clio-layout-contract-"));
	t.after(async () => {
		await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
	});
	const actual = join(root, "actual");
	const alias = join(root, "alias");
	await mkdir(actual);
	await symlink(actual, alias, "dir");
	const aliased: ClioDirs = {
		config: join(actual, "config"),
		data: join(alias, "config"),
		state: join(root, "state"),
		cache: join(root, "cache"),
	};
	match(clioDirLayoutProblems(aliased).join("\n"), /config and data roots resolve to the same path/u);
	throws(() => assertClioDirLayout(aliased), /Unsafe Clio directory layout/u);

	const nested: ClioDirs = {
		config: join(root, "config"),
		data: join(root, "config", "data"),
		state: join(root, "state"),
		cache: join(root, "cache"),
	};
	match(clioDirLayoutProblems(nested).join("\n"), /config root contains data root/u);
});

test("self-upgrade plans automatic replacement only for a newer npm release", async () => {
	const root = "/opt/clio/node_modules/@iowarp/clio-coder";
	const installation = npmInstallation(root);
	deepStrictEqual(await planSelfUpgrade({ installation, runningVersion: "0.5.7", fetchVersion: async () => "0.5.8" }), {
		status: "available",
		current: "0.5.7",
		available: "0.5.8",
		installation,
	});
	strictEqual(
		(await planSelfUpgrade({ installation, runningVersion: "0.5.7", fetchVersion: async () => "0.5.7" })).status,
		"current",
	);
	strictEqual(
		(
			await planSelfUpgrade({
				installation: { ...installation, kind: "pnpm" },
				runningVersion: "0.5.7",
				fetchVersion: async () => {
					throw new Error("manual installations must not touch the registry");
				},
			})
		).status,
		"manual",
	);
});

test("approved self-upgrade trusts success only after the installed package is verified", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "clio-self-upgrade-"));
	t.after(async () => {
		await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
	});
	await mkdir(join(root, "dist", "cli"), { recursive: true });
	await writeFile(
		join(root, "dist", "cli", "index.js"),
		`if (process.argv.slice(2).join(" ") !== "upgrade --json --channel=latest") process.exit(19);\nconsole.log(JSON.stringify({status:"success",errors:[]}));\n`,
	);
	await writeFile(join(root, "package.json"), '{"name":"@iowarp/clio-coder","version":"0.5.8"}\n');
	const plan: Extract<SelfUpgradePlan, { status: "available" }> = {
		status: "available",
		current: "0.5.7",
		available: "0.5.8",
		installation: npmInstallation(root),
	};
	deepStrictEqual(await runApprovedSelfUpgrade({ plan }), { from: "0.5.7", to: "0.5.8" });
	await writeFile(join(root, "package.json"), '{"name":"@iowarp/clio-coder","version":"0.5.7"}\n');
	await rejects(() => runApprovedSelfUpgrade({ plan }), /installed version is 0\.5\.7/u);
	ok((await readFile(join(root, "package.json"), "utf8")).includes("0.5.7"));
});

test("interactive upgrade runs only after approval and asks for restart after success", async () => {
	const events: string[] = [];
	let asks = 0;
	const ask: AskUserHandler = async (questions) => {
		asks += 1;
		events.push(`ask:${questions[0]?.header}`);
		if (asks === 1) {
			return { answers: [{ question: questions[0]?.question ?? "", answer: "Upgrade now" }] };
		}
		return { answers: [{ question: questions[0]?.question ?? "", answer: "Later" }] };
	};
	const plan: Extract<SelfUpgradePlan, { status: "available" }> = {
		status: "available",
		current: "0.5.7",
		available: "0.5.8",
		installation: npmInstallation("/tmp/clio-package"),
	};
	const notices: string[] = [];
	let dismissed = 0;
	const flow = createInteractiveUpgradeFlow({
		runningVersion: "0.5.7",
		openAskUser: ask,
		notify: (_level, text) => notices.push(text),
		isIdle: () => true,
		dismissUpdateHint: () => dismissed++,
		shutdown: () => events.push("shutdown"),
		signal: new AbortController().signal,
		plan: async () => {
			events.push("plan");
			return plan;
		},
		run: async () => {
			events.push("run");
			return { from: "0.5.7", to: "0.5.8" };
		},
	});
	flow.start();
	await eventually(() => !flow.isRunning());
	deepStrictEqual(events, ["plan", "ask:Upgrade", "run", "ask:Restart"]);
	strictEqual(dismissed, 1);
	ok(notices.some((text) => text.includes("Restart before the next turn")));
});

test("interactive upgrade stops if work starts while the release check is in flight", async () => {
	let idleChecks = 0;
	let asks = 0;
	let runs = 0;
	const notices: string[] = [];
	const flow = createInteractiveUpgradeFlow({
		runningVersion: "0.5.7",
		openAskUser: async () => {
			asks += 1;
			return { answers: [] };
		},
		notify: (_level, text) => notices.push(text),
		isIdle: () => ++idleChecks === 1,
		dismissUpdateHint: () => {},
		shutdown: () => {},
		signal: new AbortController().signal,
		plan: async () => ({
			status: "available",
			current: "0.5.7",
			available: "0.5.8",
			installation: npmInstallation("/tmp/clio-package"),
		}),
		run: async () => {
			runs += 1;
			return { from: "0.5.7", to: "0.5.8" };
		},
	});
	flow.start();
	await eventually(() => !flow.isRunning());
	strictEqual(asks, 0);
	strictEqual(runs, 0);
	ok(notices.some((text) => text.includes("became busy")));
});

test("interactive upgrade keeps package replacement behind an affirmative answer", async () => {
	let runs = 0;
	const flow = createInteractiveUpgradeFlow({
		runningVersion: "0.5.7",
		openAskUser: async (questions) => ({
			answers: [{ question: questions[0]?.question ?? "", answer: "Not now" }],
		}),
		notify: () => {},
		isIdle: () => true,
		dismissUpdateHint: () => {},
		shutdown: () => {},
		signal: new AbortController().signal,
		plan: async () => ({
			status: "available",
			current: "0.5.7",
			available: "0.5.8",
			installation: npmInstallation("/tmp/clio-package"),
		}),
		run: async () => {
			runs += 1;
			return { from: "0.5.7", to: "0.5.8" };
		},
	});
	flow.start();
	await eventually(() => !flow.isRunning());
	strictEqual(runs, 0);
});
