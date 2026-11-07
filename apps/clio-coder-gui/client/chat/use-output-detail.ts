import { useSyncExternalStore } from "react";
import { DEFAULT_OUTPUT_DETAIL, type OutputDetail, parseOutputDetail } from "./output-detail-model.js";

const KEY = "clio-coder-gui-output-detail";
const listeners = new Set<() => void>();

function read(): OutputDetail {
	try {
		return parseOutputDetail(localStorage.getItem(KEY));
	} catch {
		return DEFAULT_OUTPUT_DETAIL;
	}
}
let current: OutputDetail | null = null;
const snapshot = () => {
	current ??= read();
	return current;
};
function subscribe(listener: () => void) {
	listeners.add(listener);
	// Another window of this browser chose a tier.
	const storage = (event: StorageEvent) => {
		if (event.key !== KEY) return;
		current = read();
		listener();
	};
	window.addEventListener("storage", storage);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("storage", storage);
	};
}

/** The transcript tier is a per-browser reading preference, kept like the theme and the sidebar. */
export function useOutputDetail(): readonly [OutputDetail, (next: OutputDetail) => void] {
	const value = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_OUTPUT_DETAIL);
	return [value, setOutputDetail];
}

function setOutputDetail(next: OutputDetail) {
	current = next;
	try {
		localStorage.setItem(KEY, next);
	} catch {
		/* The choice holds for this tab. */
	}
	for (const listener of listeners) listener();
}
