import { extname } from "node:path";
import { runCommandVector } from "../../core/safe-exec.js";
import type { SampledMediaPiece } from "./ingestion.js";

export class FrameDecoderUnavailable extends Error {}

/** Decode only the already admitted source bytes. No playlist, URL, or secondary file can be opened. */
export async function sampleMediaFrames(
	path: string,
	bytes: Buffer,
	options: { maxSeconds: number; maxPieces: number; maxBytes: number; signal?: AbortSignal },
): Promise<SampledMediaPiece[]> {
	const format = { ".gif": "gif", ".mp4": "mov", ".mov": "mov", ".webm": "matroska" }[extname(path).toLowerCase()];
	if (!format) throw new FrameDecoderUnavailable("No bounded frame decoder for this container");
	const count = Math.min(options.maxPieces, 64);
	const chunks: Buffer[] = [];
	let outputBytes = 0;
	let diagnostics = "";
	const result = await runCommandVector(
		"ffmpeg",
		[
			"-hide_banner",
			"-nostdin",
			"-loglevel",
			"info",
			"-threads",
			"1",
			"-protocol_whitelist",
			"pipe",
			"-f",
			format,
			"-t",
			String(options.maxSeconds),
			"-i",
			"pipe:0",
			"-map",
			"0:v:0",
			"-an",
			"-sn",
			"-dn",
			"-vf",
			"select='isnan(prev_selected_t)+gte(t-prev_selected_t,1)',scale=w=512:h=512:force_original_aspect_ratio=decrease,showinfo",
			"-fps_mode",
			"vfr",
			"-frames:v",
			String(count),
			"-threads",
			"1",
			"-f",
			"image2pipe",
			"-c:v",
			"png",
			"pipe:1",
		],
		{
			input: bytes,
			timeoutMs: 20_000,
			...(options.signal ? { signal: options.signal } : {}),
			output: {
				onStdout(chunk) {
					outputBytes += chunk.length;
					if (outputBytes > options.maxBytes) throw new Error("Decoded frame byte budget exceeded");
					chunks.push(chunk);
				},
				onStderr(chunk) {
					if (Buffer.byteLength(diagnostics) + chunk.length > 256_000) throw new Error("Frame diagnostic budget exceeded");
					diagnostics += chunk.toString("utf8");
				},
			},
		},
	);
	options.signal?.throwIfAborted();
	if (result.exitCode !== 0 || result.timedOut || result.aborted || result.sinkError) {
		if (/spawn.*ENOENT/i.test(result.stderr)) throw new FrameDecoderUnavailable("Frame sampling requires ffmpeg on PATH");
		throw new Error(`Frame decoding failed or exceeded its budget${result.sinkError ? `: ${result.sinkError}` : ""}`);
	}
	const times = [...diagnostics.matchAll(/\bn:\s*\d+\s+pts:\s*\S+\s+pts_time:([\d.eE+-]+)/g)].map((match) =>
		Number(match[1]),
	);
	const data = Buffer.concat(chunks);
	const frames: Buffer[] = [];
	let offset = 0;
	while (offset < data.length) {
		const start = offset;
		if (!data.subarray(offset, offset + 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
			throw new Error("Invalid decoded PNG");
		offset += 8;
		let ended = false;
		while (offset + 12 <= data.length) {
			const length = data.readUInt32BE(offset);
			const tag = data.toString("ascii", offset + 4, offset + 8);
			offset += length + 12;
			if (offset > data.length) throw new Error("Truncated decoded PNG");
			if (tag === "IEND") {
				ended = true;
				break;
			}
		}
		if (!ended) throw new Error("Incomplete decoded PNG");
		frames.push(data.subarray(start, offset));
		if (frames.length > count) throw new Error("Frame count budget exceeded");
	}
	if (!frames.length || times.length < frames.length) throw new Error("No timestamped video frames decoded");
	return frames.map((frame, index) => {
		const time = times[index];
		if (
			time === undefined ||
			!Number.isFinite(time) ||
			time < 0 ||
			time >= options.maxSeconds ||
			(index > 0 && time <= (times[index - 1] ?? -1))
		)
			throw new Error("Invalid decoded frame timestamp");
		return {
			input: { kind: "image", path, mimeType: "image/png", dataBase64: frame.toString("base64") },
			location: { frame: index, startSeconds: time, endSeconds: time },
			text: `Sampled frame ${index} at ${time}s`,
		};
	});
}
