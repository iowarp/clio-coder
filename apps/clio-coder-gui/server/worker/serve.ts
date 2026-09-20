import { parentPort } from "node:worker_threads";
import { AppProblem, problemOf } from "../services/problem.js";
import type { Call, Methods, Reply } from "./protocol.js";

export function serveWorker(
	handle: (
		call: Call,
		progress: (message: string) => void,
	) => Promise<Methods[keyof Methods]["result"]> | Methods[keyof Methods]["result"],
) {
	const port = parentPort;
	if (!port) throw new Error("A domain entry must run in a worker.");
	port.on("message", async (call: Call) => {
		const send = (reply: Reply) => port.postMessage(reply);
		try {
			if (Date.now() >= call.deadlineMs) throw new AppProblem("unavailable", "Call expired before execution.");
			const result = await handle(call, (progress) => send({ id: call.id, progress }));
			send({ id: call.id, ok: true, result });
		} catch (error) {
			send({ id: call.id, ok: false, problem: problemOf(error) });
		}
	});
}
