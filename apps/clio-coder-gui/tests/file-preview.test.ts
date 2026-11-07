import assert, { deepEqual, equal } from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { previewView } from "../client/chat/file-preview-model.js";
import { routes } from "../contracts/routes.js";
import { PREVIEW_MAX_BYTES, readFilePreview, withheldPath } from "../server/services/file-preview.js";
import { harness, json } from "./harness/app.js";

async function workspace() {
	const base = await mkdtemp(join(tmpdir(), "file-preview-"));
	const root = join(base, "root");
	await mkdir(join(root, "src", ".terraform"), { recursive: true });
	await writeFile(join(root, "src", "a.ts"), "one\ntwo\n");
	await writeFile(join(root, ".env"), "TOKEN=x\n");
	await writeFile(join(root, "src", "server.pem"), "key\n");
	await writeFile(join(root, "src", ".terraform", "state"), "s\n");
	await writeFile(join(root, "blob.bin"), Buffer.from([1, 0, 2]));
	await writeFile(join(base, "outside.txt"), "private\n");
	await symlink(join(base, "outside.txt"), join(root, "escape.txt"));
	await symlink(join(root, ".env"), join(root, "innocent.txt"));
	return { base, root, close: () => rm(base, { recursive: true, force: true }) };
}

test("a preview reads workspace text and refuses traversal, secrets, links out and binaries", async (t) => {
	const w = await workspace();
	t.after(w.close);
	assert.deepEqual(await readFilePreview(w.root, "src/a.ts"), {
		status: "text",
		path: "src/a.ts",
		text: "one\ntwo\n",
		size: 8,
		truncated: false,
	});
	assert.equal((await readFilePreview(w.root, "./src//a.ts")).status, "text");
	assert.equal((await readFilePreview(w.root, join(w.root, "src", "a.ts"))).status, "text");
	for (const input of ["../outside.txt", "src/../../outside.txt", "~/x", "/etc/passwd", join(w.base, "outside.txt")])
		assert.equal((await readFilePreview(w.root, input)).status, "outside", input);
	assert.equal((await readFilePreview(w.root, "escape.txt")).status, "outside");
	for (const input of [".env", "src/server.pem", "src/.terraform/state", "innocent.txt", ".git/config"])
		assert.equal((await readFilePreview(w.root, input)).status, "withheld", input);
	assert.equal((await readFilePreview(w.root, "blob.bin")).status, "binary");
	assert.equal((await readFilePreview(w.root, "src")).status, "not-a-file");
	assert.equal((await readFilePreview(w.root, "nope.ts")).status, "missing");
	const refused = await readFilePreview(w.root, ".env");
	assert.ok(!("text" in refused));
});

test("a long file previews its start up to the last whole line", async (t) => {
	const w = await workspace();
	t.after(w.close);
	const line = `${"x".repeat(99)}\n`;
	await writeFile(join(w.root, "long.txt"), line.repeat(Math.ceil(PREVIEW_MAX_BYTES / line.length) + 10));
	const preview = await readFilePreview(w.root, "long.txt");
	assert.equal(preview.status, "text");
	if (preview.status !== "text") return;
	assert.equal(preview.truncated, true);
	assert.ok(preview.text.length <= PREVIEW_MAX_BYTES);
	assert.ok(preview.text.endsWith("\n"));
	assert.ok(preview.size > preview.text.length);
});

test("withheld names match the secret list at any depth", () => {
	assert.equal(withheldPath("a/b/.env.production"), true);
	assert.equal(withheldPath("deploy/prod-credentials.json"), true);
	assert.equal(withheldPath(".vercel/project.json"), true);
	assert.equal(withheldPath("src/env.ts"), false);
	assert.equal(withheldPath("docs/keys.md"), false);
});

test("the workspace file route answers a preview over HTTP", { timeout: 20000 }, async (t) => {
	const h = await harness();
	t.after(h.close);
	await writeFile(join(h.home.path, "notes.md"), "# hi\n");
	await writeFile(join(h.home.path, ".env"), "SECRET=1\n");
	const opened = await json(await h.post("/api/workspaces", { path: h.home.path }), routes.openWorkspace.response);
	const read = (path: string) =>
		h.request(`/api/workspaces/${opened.id}/file?path=${encodeURIComponent(path)}`).then((response) => {
			assert.equal(response.status, 200);
			return json(response, routes.workspaceFile.response);
		});
	assert.deepEqual(await read("notes.md"), {
		status: "text",
		path: "notes.md",
		text: "# hi\n",
		size: 5,
		truncated: false,
	});
	assert.equal((await read(".env")).status, "withheld");
	assert.equal((await read("../x")).status, "outside");
});

test("a preview view centres a long file on the named line and says what it leaves out", () => {
	const text = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");
	const preview = { status: "text", path: "a.ts", text: `${text}\n`, size: 400, truncated: false } as const;
	const whole = previewView(preview, 7);
	equal(whole.lines.length, 50);
	equal(whole.focus, 7);
	deepEqual(
		whole.lines.filter((line) => line.focus).map((line) => line.text),
		["line 7"],
	);
	deepEqual(whole.notes, []);
	const windowed = previewView(preview, 40, 12);
	deepEqual([windowed.lines[0]?.number, windowed.lines.at(-1)?.number], [36, 47]);
	deepEqual(windowed.notes, ["Showing lines 36 to 47 of 50."]);
	deepEqual(previewView(preview, 49, 12).lines.at(-1)?.number, 50);
	deepEqual(previewView(preview, 80).notes, ["The file has 50 lines, so line 80 is not in it now."]);
	deepEqual(previewView({ ...preview, truncated: true, size: 9_000 }, 80).notes, [
		"Line 80 is past the first 50 lines this preview reads.",
		"The file is 9,000 bytes; the preview stops at the first 50 lines.",
	]);
});
