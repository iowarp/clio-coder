import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** A private, append-only lifecycle log. Request bodies and auth URLs never enter it. */
export async function lifecycleLog(path: string | undefined) {
	const file = path
		? await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
		: undefined;
	if (file) {
		const stat = await file.stat();
		if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) {
			await file.close();
			throw new Error("--log-file must be a regular file owned by the current user with a single link.");
		}
		await file.chmod(0o600);
	}
	let pending = Promise.resolve();
	return {
		write(message: string) {
			pending = pending.then(async () => {
				await file?.appendFile(`${new Date().toISOString()} [clio-coder:web] ${message}\n`);
			});
			return pending;
		},
		async close() {
			try {
				await pending;
			} finally {
				await file?.close();
			}
		},
	};
}
