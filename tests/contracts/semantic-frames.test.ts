import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runCommandVector } from "../../src/core/safe-exec.js";
import { FrameDecoderUnavailable, sampleMediaFrames } from "../../src/domains/semantic/frames.js";
import { extractInbox, SemanticIndex, sourceHash } from "../../src/domains/semantic/index.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("GIF/video frames carry source provenance through bounded ingestion, embedding and reload", async (t) => {
	const available = await runCommandVector("ffmpeg", ["-version"], { timeoutMs: 5000 });
	if (/spawn.*ENOENT/i.test(available.stderr)) {
		t.skip("ffmpeg is not installed");
		return;
	}
	const isolated = await isolateClioEnv("semantic-frames-");
	try {
		const root = join(isolated.dir, "inbox");
		mkdirSync(root);
		for (const extension of ["gif", "mp4", "webm", "mov"]) {
			const generated = await runCommandVector(
				"ffmpeg",
				[
					"-hide_banner",
					"-loglevel",
					"error",
					"-f",
					"lavfi",
					"-i",
					"testsrc=size=32x32:rate=4:duration=3",
					"-threads",
					"1",
					"-y",
					join(root, `clip.${extension}`),
				],
				{ timeoutMs: 10_000 },
			);
			assert.equal(generated.exitCode, 0, generated.stderr);
		}
		const registration = {
			id: "frames",
			root,
			projectId: "project",
			scope: "project" as const,
			runId: "run-frames",
			experimentId: "exp-frames",
		};
		const unavailable = await extractInbox(registration);
		assert.equal(unavailable.records.length, 0);
		assert(
			unavailable.sources.every((source) => source.state === "unsupported" && source.reason?.includes("qualified image")),
		);
		const options = { modalities: ["image"] as const, limits: { maxMediaSeconds: 2 } };
		const extracted = await extractInbox(registration, {
			...options,
			// The application already supplies an audio-only sampler. Empty output must fall through to frames.
			mediaSampler: async () => [],
		});
		assert.equal(extracted.records.length, 8, JSON.stringify(extracted.sources));
		assert(extracted.sources.every((source) => source.state === "ready"));
		for (const extension of ["gif", "mp4", "webm", "mov"]) {
			const frames = extracted.records.filter((record) => record.path.endsWith(`.${extension}`));
			assert.deepEqual(
				frames.map((record) => record.location.startSeconds),
				[0, 1],
			);
			assert.deepEqual(
				frames.map((record) => record.location.frame),
				[0, 1],
			);
			assert(frames.every((record) => record.runId === "run-frames" && record.experimentId === "exp-frames"));
			assert(
				frames.every(
					(record) =>
						record.mediaType ===
						(extension === "gif" ? "image/gif" : extension === "mov" ? "video/quicktime" : `video/${extension}`),
				),
			);
			for (const record of frames) {
				assert.equal(record.input.kind, "image");
				assert.equal(record.input.path, record.path);
				assert.equal(record.input.mimeType, "image/png");
				assert.equal(
					Buffer.from(record.input.dataBase64 ?? "", "base64")
						.subarray(0, 8)
						.toString("hex"),
					"89504e470d0a1a0a",
				);
			}
		}
		let calls = 0;
		const indexOptions = {
			projectId: "project",
			cacheDir: join(isolated.dir, "index"),
			profile: {
				id: "frame-fixture",
				dimensions: 2,
				profileIdentity: sourceHash("frame-fixture"),
				identity: { recipe: "fixture" },
			},
			embed: async (inputs: readonly unknown[]) => {
				calls += inputs.length;
				return { profileKey: index.profileKey, vectors: inputs.map(() => [1, 0]) };
			},
		};
		const index = new SemanticIndex(indexOptions);
		await index.refreshExtracted(extracted);
		assert.equal(calls, 8);
		const reopened = new SemanticIndex(indexOptions);
		await reopened.refreshExtracted(extracted);
		assert.equal(calls, 8, "unchanged retained frames must reload without embedding");
		const bounded = await extractInbox(registration, { ...options, limits: { maxPieces: 1, maxMediaSeconds: 1 } });
		assert.equal(bounded.records.length, 1);
		const denied = await extractInbox(registration, { ...options, allowPath: () => false });
		assert.equal(denied.records.length, 0);
		symlinkSync(join(root, "clip.mp4"), join(root, "alias.mp4"));
		writeFileSync(join(root, "bad.mp4"), "not a video");
		const bad = await extractInbox(registration, { ...options, limits: { maxTotalBytes: 1000 } });
		assert(!bad.records.some((record) => record.path.endsWith("alias.mp4")));
		assert.equal(bad.sources.find((source) => source.path.endsWith("bad.mp4"))?.state, "failed");
		const clip = join(root, "clip.gif");
		const bytes = readFileSync(clip);
		await assert.rejects(sampleMediaFrames(clip, bytes, { maxSeconds: 2, maxPieces: 2, maxBytes: 1 }), /byte budget/);
		const savedPath = process.env.PATH;
		try {
			process.env.PATH = isolated.dir;
			await assert.rejects(
				sampleMediaFrames(clip, bytes, { maxSeconds: 2, maxPieces: 2, maxBytes: 100_000 }),
				FrameDecoderUnavailable,
			);
		} finally {
			if (savedPath === undefined) delete process.env.PATH;
			else process.env.PATH = savedPath;
		}
		await assert.rejects(extractInbox(registration, { ...options, signal: AbortSignal.abort() }), /abort/i);
	} finally {
		isolated.restore();
	}
});
