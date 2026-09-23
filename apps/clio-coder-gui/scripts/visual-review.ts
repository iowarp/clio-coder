// Visual review against the ACP fixture: photographs the conversation, the project pages, an
// approval, a held worker and Docs at the three review viewports, or keeps a fixture API up on 4317
// for `pnpm dev:client`. Evidence for a visual change comes from these images, looked at before and
// after; the smoke remains the gate.
//
//   npx vite build --outDir <scratch>/client-build --emptyOutDir
//   pnpm run visual --client <scratch>/client-build/ --out <scratch>/shots/before
//   pnpm run visual --client <scratch>/client-build/ --out <scratch>/shots/after --only conv,fleet,steer --route
//   pnpm run visual --serve    # then `pnpm dev:client` and open http://127.0.0.1:4318/#token=test-token
//
// `--route` makes the fixture advertise safe settings and a healthy target, so the composer shows a
// reported model. Prompts containing [approval], [fleet] and [stream] reach those fixture turns.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { chromium } from "playwright-core";
import { harness } from "../tests/harness/app.js";
import { seedHistory } from "../tests/harness/history-fixture.js";

const SHOTS = ["workspaces", "history", "delete", "empty", "conv", "docs", "approval", "fleet", "steer", "tools"];
const { values } = parseArgs({
	options: {
		client: { type: "string" },
		out: { type: "string", default: "visual-review" },
		only: { type: "string", default: "" },
		views: { type: "string", default: "2000x1040:dark,1440x900:light,390x844:light" },
		doc: { type: "string", default: "guide/troubleshooting.md" },
		route: { type: "boolean", default: false },
		serve: { type: "boolean", default: false },
		// Vite's dev proxy expects the API on 4317; another port only helps a direct check.
		port: { type: "string", default: "4317" },
		chrome: { type: "string", default: "/usr/bin/google-chrome" },
	},
});
const only = new Set(values.only.split(",").filter(Boolean));
for (const name of only)
	if (!SHOTS.includes(name)) throw new Error(`Unknown shot ${name}; choose from ${SHOTS.join(", ")}.`);
const want = (name: string) => only.size === 0 || only.has(name);

// The workspace is opened through the app before the listening origin is known, so the origin starts
// as the one its in-process requests carry.
let origin = `http://127.0.0.1:${values.serve ? values.port : "4317"}`;
const h = await harness(
	{},
	{
		scenario: "markdown",
		origin: () => origin,
		...(values.client ? { clientDir: values.client } : {}),
		...(values.route || values.serve ? { env: { CLIO_CODER_WEB_FIXTURE_ROUTE: "1" } } : {}),
	},
);
const project = join(h.home.path, "field-notes");
await mkdir(project, { recursive: true });
await seedHistory(h.home.path, project);
const workspace = (await (await h.post("/api/workspaces", { path: project })).json()) as { id?: string };
if (!workspace.id) throw new Error(`The fixture workspace did not open: ${JSON.stringify(workspace)}`);

const server = serve({ fetch: h.app.fetch, hostname: "127.0.0.1", port: values.serve ? Number(values.port) : 0 });
await new Promise<void>((resolve) => server.on("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("The review server has no address.");
const stop = async () => {
	if ("closeAllConnections" in server) server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await h.close();
};

if (values.serve) {
	// Vite's proxy presents the API origin, so the origin stays the served one.
	console.log(
		`[visual] Fixture API on ${origin}. Run pnpm dev:client, then open http://127.0.0.1:4318/#token=test-token`,
	);
	console.log(`[visual] Scratch home ${h.home.path}; project ${project}. Ctrl+C stops it.`);
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.on(signal, () => {
			void stop().then(() => process.exit(0));
		});
} else {
	if (!values.client) throw new Error("--client <private build> is required to photograph.");
	origin = `http://127.0.0.1:${address.port}`;
	await mkdir(values.out, { recursive: true });
	const browser = await chromium.launch({ executablePath: values.chrome, headless: true });
	const errors: string[] = [];
	try {
		for (const view of values.views.split(",")) {
			const [size = "", theme = "light"] = view.split(":");
			const [width = 1440, height = 900] = size.split("x").map(Number);
			const tag = `${width}-${theme}`;
			const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
			await context.addInitScript(
				`try { localStorage.setItem("clio-coder-gui-theme", ${JSON.stringify(theme)}) } catch {}`,
			);
			const page = await context.newPage();
			page.setDefaultTimeout(20_000);
			page.on("pageerror", (error) => errors.push(`${tag}: ${error.message}`));
			const shot = async (name: string, fullPage = false) => {
				await page.evaluate(() => document.fonts.ready);
				await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
				await page.screenshot({ path: join(values.out, `${name}-${tag}.png`), fullPage });
			};
			const transcriptTo = (edge: "top" | "end") =>
				page.locator(".chat-transcript").evaluate((element, where) => {
					element.scrollTop = where === "top" ? 0 : element.scrollHeight;
				}, edge);
			await page.goto(`${origin}/#token=test-token`);
			await page.getByRole("heading", { level: 1 }).waitFor();
			if (want("workspaces")) {
				await page.goto(`${origin}/sessions`);
				await page.getByRole("heading", { name: "Recent projects" }).waitFor();
				await shot("workspaces", true);
			}
			if (want("history") || want("delete")) {
				await page.goto(`${origin}/workspaces/${workspace.id}/sessions`);
				await page.getByText("Survey the sensor calibration notes").waitFor();
				if (want("history")) await shot("history", true);
				if (want("delete")) {
					await page.getByRole("button", { name: "Delete Survey the sensor calibration notes", exact: true }).click();
					await page.getByRole("button", { name: "Keep", exact: true }).waitFor();
					await shot("delete");
					await page.getByRole("button", { name: "Keep", exact: true }).click();
				}
			}
			if (want("docs")) {
				await page.goto(`${origin}/docs/${values.doc}`);
				await page.locator(".docs-page .markdown").waitFor();
				const block = page.locator(".docs-page :is(.code-block, .diagram)").first();
				if (await block.count()) await block.evaluate((element) => element.scrollIntoView({ block: "start" }));
				await shot("docs");
			}
			if (["empty", "conv", "approval", "fleet", "steer", "tools"].some(want)) {
				await page.goto(`${origin}/workspaces/${workspace.id}/sessions`);
				await page.getByRole("button", { name: "New conversation", exact: true }).click();
				const field = page.getByLabel("Message Clio Coder", { exact: true });
				await field.waitFor();
				if (want("empty")) await shot("empty");
				const send = async (text: string) => {
					await field.fill(text);
					await page.locator(".composer__submit").click();
				};
				if (want("conv")) {
					await send("Show the fixture findings with code and a diagram.");
					await page.locator(".diagram.is-rendered svg").waitFor();
					await page.locator(".code-block pre").first().scrollIntoViewIfNeeded();
					await page.locator(".token.keyword").first().waitFor();
					await transcriptTo("top");
					await shot("conv-top");
					await page
						.locator(".diagram")
						.first()
						.evaluate((element) => element.scrollIntoView({ block: "center" }));
					await shot("conv-diagram");
					await transcriptTo("end");
					await shot("conv-end");
				}
				if (want("approval")) {
					await send("[approval] Write the fixture file.");
					await page.getByRole("button", { name: "Allow once", exact: true }).first().waitFor();
					await shot("approval");
					await page.getByRole("button", { name: "Allow once", exact: true }).first().click();
					await page.getByText("Tool executed.", { exact: true }).waitFor();
				}
				if (want("fleet") || want("steer")) {
					await send("[fleet] Survey the fixture.");
					await page.getByRole("button", { name: "Guide scout", exact: true }).waitFor();
					await transcriptTo("end");
					if (want("fleet")) await shot("fleet");
					if (want("steer")) {
						await page.getByRole("button", { name: "Guide scout", exact: true }).click();
						await page.getByLabel("Guidance for scout", { exact: true }).fill("Only read the README.");
						await shot("fleet-guide");
						await page.getByRole("button", { name: "Send guidance", exact: true }).click();
						await page.getByText("Guidance queued. The worker reads it at its next step.", { exact: true }).waitFor();
						await shot("fleet-guided");
						await page.getByRole("button", { name: "Stop scout", exact: true }).click();
						await shot("fleet-stop");
						await page.getByRole("button", { name: "Keep running", exact: true }).click();
					}
					await page.getByRole("button", { name: "Stop turn", exact: true }).click();
					await page.getByRole("button", { name: "Guide scout", exact: true }).waitFor({ state: "detached" });
					if (want("fleet")) await shot("fleet-settled");
				}
				if (want("tools")) {
					await page.locator(".conversation__tools > summary").click();
					await page.locator(".conversation__tools-body").waitFor();
					await shot("tools");
					await page.keyboard.press("Escape");
				}
			}
			await context.close();
		}
	} finally {
		console.log(JSON.stringify({ out: values.out, errors }, null, 2));
		await browser.close();
		await stop();
	}
}
