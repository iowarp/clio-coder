// The command palette and Shortcuts & help open on a key, and the first keys after that chord belong
// to them. Their bodies are lazy chunks, so the dialog frame and its search field are eager: the
// frame mounts, traps focus and collects typing on the same frame as the chord, and the real body
// swaps in with that text once its chunk lands. A lazy component under `<Suspense>` rendered nothing
// meanwhile and left focus in the message box, where the typed text and an Enter would go (R2-1).
// Both chunks also warm on the first idle moment after start, so the shell is rarely seen.

import { type ReactNode, type RefObject, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { Command } from "./CommandPalette.js";
import { Dialog } from "./Dialog.js";

type Loaded<T> = { readonly module: T } | { readonly failed: true } | null;

function deferredModule<T>(load: () => Promise<T>) {
	let state: Loaded<T> = null;
	let pending = false;
	const listeners = new Set<() => void>();
	const set = (next: Loaded<T>) => {
		state = next;
		for (const listener of listeners) listener();
	};
	return {
		start(): void {
			if (pending || (state !== null && "module" in state)) return;
			// A failed load (a stale build, a dropped connection) retries on the next open.
			pending = true;
			load().then(
				(module) => {
					pending = false;
					set({ module });
				},
				() => {
					pending = false;
					set({ failed: true });
				},
			);
		},
		get: (): Loaded<T> => state,
		loaded: (): boolean => state !== null && "module" in state,
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

const palette = deferredModule(() => import("./CommandPalette.js"));
const help = deferredModule(() => import("./HelpDialog.js"));

function useDeferred<T>(deferred: ReturnType<typeof deferredModule<T>>): Loaded<T> {
	const state = useSyncExternalStore(deferred.subscribe, deferred.get, deferred.get);
	useEffect(() => deferred.start(), [deferred]);
	return state;
}

/** Warm both chunks once the app is idle, so a chord's first frame is usually the real dialog. */
export function preloadDialogs(): () => void {
	const warm = () => {
		palette.start();
		help.start();
	};
	if (typeof requestIdleCallback === "function") {
		const handle = requestIdleCallback(warm, { timeout: 3000 });
		return () => cancelIdleCallback(handle);
	}
	const handle = setTimeout(warm, 1500);
	return () => clearTimeout(handle);
}

/**
 * The search field the frame shows until the body arrives: same name and placeholder, so the swap is
 * invisible to a screen reader. Enter does nothing yet; it must not fall through to the page.
 */
function LoadingField({
	inputRef,
	label,
	placeholder,
	value,
	onChange,
	failed,
	what,
	search,
}: {
	inputRef: RefObject<HTMLInputElement | null>;
	label: string;
	placeholder: string;
	value: string;
	onChange: (value: string) => void;
	failed: boolean;
	what: string;
	search: ReactNode;
}) {
	const id = useId();
	return (
		<div className="dialog-loading">
			<div className="filter__field">
				{search}
				<label className="sr-only" htmlFor={id}>
					{label}
				</label>
				<input
					ref={inputRef}
					id={id}
					type="text"
					placeholder={placeholder}
					autoComplete="off"
					value={value}
					onChange={(event) => onChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") event.preventDefault();
					}}
				/>
			</div>
			<small role="status">{failed ? `Could not load ${what}. Reload the app to try again.` : `Loading ${what}…`}</small>
		</div>
	);
}

export function PaletteFrame({
	commands,
	onClose,
	returnFocus,
}: {
	commands: readonly Command[];
	onClose: () => void;
	returnFocus: HTMLElement | null;
}) {
	const state = useDeferred(palette);
	const input = useRef<HTMLInputElement>(null);
	const [seed, setSeed] = useState("");
	// Only a body that replaces the shell takes focus; one present at open lets the trap place it.
	const [missingAtOpen] = useState(() => !palette.loaded());
	const Body = state && "module" in state ? state.module.CommandPaletteBody : null;
	return (
		<Dialog
			title="Run a command"
			eyebrow="COMMAND PALETTE"
			onClose={onClose}
			initialFocus={input}
			returnFocus={returnFocus}
			className="dialog--palette"
		>
			{Body ? (
				<Body commands={commands} onClose={onClose} inputRef={input} initialQuery={seed} claimFocus={missingAtOpen} />
			) : (
				<LoadingField
					inputRef={input}
					label="Run a command"
					placeholder="A view, a session, or an action"
					value={seed}
					onChange={setSeed}
					failed={state !== null && "failed" in state}
					what="commands"
					search={<span aria-hidden="true">⌕</span>}
				/>
			)}
		</Dialog>
	);
}

export function HelpFrame({
	onClose,
	bundledDocsPath,
	onReport,
	returnFocus,
}: {
	onClose: () => void;
	bundledDocsPath?: string | undefined;
	/** "Report a problem": the report dialog (R-24), opened on top of Help. */
	onReport?: (() => void) | undefined;
	returnFocus: HTMLElement | null;
}) {
	const state = useDeferred(help);
	const input = useRef<HTMLInputElement>(null);
	const [seed, setSeed] = useState("");
	const [missingAtOpen] = useState(() => !help.loaded());
	const Body = state && "module" in state ? state.module.HelpReferenceBody : null;
	return (
		<Dialog
			title="Shortcuts & help"
			eyebrow="CLIO CODER"
			size="wide"
			className="help-dialog"
			initialFocus={input}
			returnFocus={returnFocus}
			onClose={onClose}
			actions={
				onReport ? (
					<button type="button" onClick={onReport}>
						Report a problem
					</button>
				) : null
			}
		>
			{Body ? (
				<Body bundledDocsPath={bundledDocsPath} searchRef={input} initialQuery={seed} claimFocus={missingAtOpen} />
			) : (
				<LoadingField
					inputRef={input}
					label="Search shortcuts and help"
					placeholder="Search actions, keys or help…"
					value={seed}
					onChange={setSeed}
					failed={state !== null && "failed" in state}
					what="help"
					search={null}
				/>
			)}
		</Dialog>
	);
}
