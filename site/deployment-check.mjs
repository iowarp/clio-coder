#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const product = await read("product.json");
const manifest = await read("content/docs-manifest.json");
const { source } = manifest;
if (!["release", "repository"].includes(source.mode) || !/^[a-f0-9]{40}$/.test(source.commit))
	throw new Error(
		"Production deployment requires an immutable documentation snapshot; working-tree drafts are local only.",
	);
if (source.version !== product.version) throw new Error("Website metadata and documentation source versions differ.");
if (source.mode === "release" && source.ref !== `v${product.version}`)
	throw new Error("Release documentation must point to its matching version tag.");
if (source.mode === "repository" && source.ref !== source.commit)
	throw new Error("Repository documentation must point directly to its immutable source commit.");
const cwd = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
if (git("rev-parse", `${source.ref}^{commit}`).toString().trim() !== source.commit)
	throw new Error("Documentation source identity does not match its Git reference.");
for (const file of manifest.files) {
	const hash = createHash("sha256")
		.update(git("show", `${source.commit}:${file.source}`))
		.digest("hex");
	if (hash !== file.sourceSha256) throw new Error(`Documentation input differs from the pinned commit: ${file.source}`);
}
const packageVersion = JSON.parse(git("show", `${source.commit}:package.json`).toString()).version;
if (
	packageVersion !== product.version &&
	!(source.mode === "repository" && packageVersion === `${product.version}-dev`)
)
	throw new Error("Website version differs from the pinned product source.");
console.log(`Website v${product.version}: ${source.mode} documentation pinned to ${source.commit}.`);
console.log(
	`Recorded npm release: v${product.publishedVersion}. Website deployment does not publish a package or create a release tag.`,
);
