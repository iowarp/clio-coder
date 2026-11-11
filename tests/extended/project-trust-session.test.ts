import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildProjectTrustCard, type ProjectTrustCardModel } from "../../src/cli/project-trust-card.js";
import { createProjectTrustSession } from "../../src/interactive/project-trust-session.js";
import {
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/session-control/slash-commands.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function fixture(dir: string): string {
	const workspace = join(dir, "workspace");
	mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
	writeFileSync(join(workspace, ".clio-coder", "safety.yaml"), "version: 1\nnoWritePaths:\n  - secrets/\n");
	writeFileSync(
		join(workspace, ".clio-coder", "hooks.yaml"),
		"- id: fmt\n  kind: command\n  on: after_tool\n  argv: [./scripts/fmt.sh, --check]\n",
	);
	return workspace;
}

function session(workspace: string) {
	const cards: Array<{ model: ProjectTrustCardModel; done: (trusted: boolean) => void }> = [];
	const notices: string[] = [];
	let restarts = 0;
	const trust = createProjectTrustSession({
		cwd: () => workspace,
		openCard: (model, done) => {
			cards.push({ model, done });
			return true;
		},
		restart: () => {
			restarts += 1;
		},
		notice: (_level, text) => notices.push(text),
		onChange: () => undefined,
		schedule: (run) => run(),
	});
	return { trust, cards, notices, restarts: () => restarts };
}

test("/trust opens the project trust card, and says so where there is no card to open", () => {
	strictEqual(parseSlashCommand("/trust").kind, "trust");
	let opened = 0;
	const notices: string[] = [];
	const ctx = {
		notice: (_level: string, text: string) => notices.push(text),
		openProjectTrust: () => {
			opened += 1;
		},
	} as unknown as SlashCommandContext;
	dispatchSlashCommand(parseSlashCommand("/trust"), ctx);
	strictEqual(opened, 1);
	dispatchSlashCommand(parseSlashCommand("/trust"), { notice: ctx.notice } as unknown as SlashCommandContext);
	ok(
		notices.some((text) => text.includes("/trust")),
		notices.join("\n"),
	);
});

test("an untrusted project shows the header reminder; Trust all writes the records and restarts", async () => {
	const home = await isolateClioEnv("clio-coder-trust-session-");
	try {
		const workspace = fixture(home.dir);
		const { trust, cards, restarts } = session(workspace);
		strictEqual(trust.reminder(), "Project configuration not active · /trust");

		trust.open();
		strictEqual(cards.length, 1);
		deepStrictEqual(
			cards[0]?.model.surfaces.map((item) => item.surface),
			["safety", "hooks"],
		);
		cards[0]?.done(true);
		strictEqual(buildProjectTrustCard(workspace), null);
		strictEqual(restarts(), 1);
		strictEqual(trust.reminder(), "Project configuration trusted · restart Clio to apply it");
	} finally {
		home.restore();
	}
});

test("/reload raises the card only for configuration that is new or changed since it was declined", async () => {
	const home = await isolateClioEnv("clio-coder-trust-session-");
	try {
		const workspace = fixture(home.dir);
		const { trust, cards, notices } = session(workspace);
		// The launch card was declined: what is untrusted at session start does not re-raise on its own.
		trust.reloaded();
		strictEqual(cards.length, 0);

		writeFileSync(join(workspace, ".clio-coder", "safety.yaml"), "version: 1\n");
		trust.reloaded();
		strictEqual(cards.length, 1);
		cards[0]?.done(false);
		trust.reloaded();
		strictEqual(cards.length, 1, "a card closed without trusting is not raised again for the same files");
		strictEqual(trust.reminder(), "Project configuration not active · /trust");

		// `/trust` still reopens it on request.
		trust.open();
		strictEqual(cards.length, 2);
		cards[1]?.done(true);
		trust.open();
		strictEqual(cards.length, 2);
		ok(
			notices.some((text) => text.includes("No project configuration is waiting")),
			notices.join("\n"),
		);
	} finally {
		home.restore();
	}
});
