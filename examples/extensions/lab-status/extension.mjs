import { open } from "node:fs/promises";
import path from "node:path";

let lastStatus = { text: "Synthetic fixture available; invoke dashboard", tone: "neutral" };
async function readRecord(file) {
	const handle = await open(file, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > 32768) throw new Error("Expected a regular local JSON record, at most 32 KiB");
		const buffer = Buffer.alloc(32769);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > 32768) throw new Error("Experiment record exceeds 32 KiB");
		const data = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
		if (
			typeof data.experiment !== "string" ||
			data.experiment.length > 120 ||
			!Array.isArray(data.jobs) ||
			data.jobs.length > 100
		)
			throw new Error("Invalid experiment record");
		for (const job of data.jobs) {
			if (
				typeof job.id !== "string" ||
				job.id.length > 80 ||
				!["queued", "running", "completed", "failed"].includes(job.state) ||
				!Number.isInteger(job.ranks) ||
				job.ranks < 1 ||
				!Number.isFinite(job.elapsedSeconds) ||
				job.elapsedSeconds < 0
			)
				throw new Error("Invalid job record");
		}
		return data;
	} finally {
		await handle.close();
	}
}
/** @param {import('@iowarp/clio-coder/extensions').ExtensionApi} api */
export default function extension(api) {
	api.handle("dashboard", async (args, context) => {
		const file = args.trim()
			? path.resolve(context.snapshot.workspace, args.trim())
			: new URL("./jobs.synthetic.json", import.meta.url);
		const data = await readRecord(file);
		context.signal.throwIfAborted();
		const label = data.synthetic === true ? "SYNTHETIC FIXTURE" : "LOCAL RECORD (reported, not independently verified)";
		const completed = data.jobs.filter((job) => job.state === "completed").length;
		lastStatus = { text: `${label}: ${completed}/${data.jobs.length} completed`, tone: "neutral" };
		const rows = data.jobs.map((job) => [job.id, String(job.ranks), job.state, String(job.elapsedSeconds)]);
		return {
			text: `${label}\n${data.experiment}\n${completed}/${data.jobs.length} completed\n${rows.map((row) => row.join(" | ")).join("\n")}\nSource: ${file}`,
			status: lastStatus,
			panel: {
				title: data.experiment,
				sections: [
					{
						kind: "text",
						text: `${label}\nSource: ${file}\nThis extension reads records only. It never submits or queries cluster jobs.`,
					},
					{ kind: "metrics", items: [{ label: "Completed", value: `${completed}/${data.jobs.length}` }] },
					{ kind: "table", columns: ["Job", "MPI ranks", "State", "Elapsed s"], rows },
				],
			},
		};
	});
	api.on("session_open", () => ({ text: "", status: lastStatus }));
	api.on("turn_end", () => ({ text: "", status: lastStatus }));
}
