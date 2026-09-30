import type { BootstrapProgressSink } from "./bootstrap.js";
import type { CodewikiBuildProgress } from "./codewiki/build-worker-protocol.js";

const LABELS: Record<CodewikiBuildProgress["stage"], string> = {
	queue: "waiting for the index writer lease",
	enumerate: "enumerating repository files",
	hash: "checking source content",
	grammar: "loading source parsers",
	parse: "indexing source files",
	edges: "resolving dependency edges",
};

export function indexProgressSink(sink?: BootstrapProgressSink): (progress: CodewikiBuildProgress) => void {
	return (event) =>
		sink?.({
			phase: "codewiki",
			status: "running",
			message: LABELS[event.stage],
			...(event.current !== undefined ? { current: event.current } : {}),
			...(event.total !== undefined ? { total: event.total } : {}),
			...(event.path ? { detail: event.path } : {}),
		});
}
