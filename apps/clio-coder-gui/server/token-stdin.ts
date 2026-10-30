import type { Readable } from "node:stream";

export const TOKEN_PATTERN = /^[\w-]{32,256}$/;

/**
 * The first line of stdin, which a parent that starts this server over SSH writes as the launch
 * token so it never appears in argv or a process listing. The stream stays open afterwards: its
 * end tells the server that the parent is gone.
 */
export function readStdinToken(input: Readable, limit = 512): Promise<string> {
	return new Promise((resolve, reject) => {
		let buffered = "";
		const cleanup = () => {
			input.removeListener("data", onData);
			input.removeListener("end", onEnd);
			input.removeListener("error", onError);
		};
		const fail = (message: string) => {
			cleanup();
			reject(new Error(message));
		};
		const onData = (chunk: Buffer | string) => {
			buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (buffered.length > limit) {
				fail("--token-stdin expects the token on one short line.");
				return;
			}
			const newline = buffered.indexOf("\n");
			if (newline === -1) return;
			const token = buffered.slice(0, newline).replace(/\r$/u, "");
			cleanup();
			if (!TOKEN_PATTERN.test(token)) {
				reject(new Error("--token-stdin must receive 32–256 URL-safe letters, digits, underscores or hyphens."));
				return;
			}
			resolve(token);
		};
		const onEnd = () => fail("--token-stdin received no token before stdin closed.");
		const onError = (error: Error) => fail(`--token-stdin could not read stdin: ${error.message}`);
		input.on("data", onData);
		input.once("end", onEnd);
		input.once("error", onError);
	});
}
