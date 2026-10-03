/**
 * The composer. Every decision it makes lives in `composer-model.ts`; this file is
 * the wiring and the markup.
 *
 * Two properties are load-bearing and easy to lose in a refactor:
 *
 * 1. It reads the draft from a store outside React, and its props are scalars
 *    or memoized facts behind `memo`, so a streamed timeline delta does not
 *    re-render the textarea. Passing the whole `SessionSnapshot` in would undo
 *    that, and so would a `route` object rebuilt on every render.
 * 2. The textarea is never disabled while a turn runs. Only the submit changes
 *    meaning, and a draft typed mid-turn survives the turn.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { CommandRequest } from "../../contracts/steering.js";
import type { Client } from "../api/client.js";
import { Icon } from "../design/icons.js";
import { StatusMark } from "../design/status.js";
import { useDetailsDismiss } from "../interaction/use-details-dismiss.js";
import { useLayersActive } from "../interaction/use-shortcut.js";
import { countRender } from "../render/render-probe.js";
import { ClioPulse, PULSE_SIZE } from "../shell/ClioMark.js";
import { AutonomyPill } from "./AutonomyPill.js";
import { persistAttachments, savedAttachments } from "./attachment-drafts.js";
import { readAttachment } from "./attachment-image.js";
import {
	type Attachment,
	admitAttachment,
	attachmentRefusal,
	attachmentSummary,
	decodeTextFile,
	type FileAttachment,
	type ImageAttachment,
} from "./attachments-model.js";
import { fitComposerField, initialEnterSends, rememberEnterSends } from "./composer-field.js";
import {
	capabilityRefusal,
	composerKeyAction,
	draftStore,
	noticeForError,
	noticeForRefusal,
	projectQueue,
	queueSummary,
	restoredDraft,
	type SubmitIntent,
	slashNotice,
	steeringAffordances,
	steerModeOffers,
	submitIntent,
	submitLabel,
} from "./composer-model.js";
import { usePaneActions } from "./pane-context.js";
import { LARGE_PASTE_CHARACTERS, planPaste } from "./paste-model.js";
import { RoutePicker } from "./RoutePicker.js";
import type { RouteFacts } from "./route.js";
import { SlashActionDialog, SlashPalette, slashOptionId } from "./SlashPalette.js";
import {
	completedDraft,
	exactEntry,
	filterSlashEntries,
	parseSlashLine,
	type SlashAction,
	type SlashEntry,
	slashEntries,
	slashQuery,
} from "./slash-model.js";
import "./composer-box.css";
import "./composer.css";

/** Focus handlers keyed by session, so a retry elsewhere in the turn can fill and focus this field. */
const focusHandlers = new Map<string, () => void>();
/** Up to four letters of a file's extension, for the tile beside its name. */
function fileBadge(name: string): string {
	const extension = /\.([A-Za-z0-9]{1,4})$/u.exec(name)?.[1];
	return extension ? extension.toUpperCase() : "TXT";
}

function saveAttachment(item: Attachment): void {
	const url =
		item.kind === "file"
			? URL.createObjectURL(new Blob([item.text], { type: "text/plain;charset=utf-8" }))
			: `data:${item.mimeType};base64,${item.data}`;
	const link = document.createElement("a");
	link.href = url;
	link.download = item.name;
	link.click();
	if (item.kind === "file") setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Fill the composer for this session and put the caret in it. Used by Try again and the starters. */
export function fillComposer(sessionId: string, text: string): void {
	draftStore(sessionId).write(text);
	focusHandlers.get(sessionId)?.();
}

export interface ComposerProps {
	readonly client: Client;
	readonly sessionId: string;
	readonly sessionState: SessionSnapshot["state"];
	readonly initialFocus: boolean;
	/** The id of the turn running right now, or null when none is. */
	readonly runningTurnId: string | null;
	/** Where the next request goes. Memoize it: a new object on every render re-renders the field. */
	readonly route: RouteFacts;
}

export const Composer = memo(function Composer({
	client,
	sessionId,
	sessionState,
	initialFocus,
	runningTurnId,
	route,
}: ComposerProps) {
	countRender("composer");
	const queries = useQueryClient();
	const store = draftStore(sessionId);
	const draft = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
	const field = useRef<HTMLTextAreaElement | null>(null);
	const sending = useRef(false);
	const fieldId = useId();
	const hintId = useId();
	const [enterSends, setEnterSends] = useState(initialEnterSends);
	const options = useRef<HTMLDetailsElement | null>(null);
	const [optionsOpen, setOptionsOpen] = useState(false);
	useDetailsDismiss(options, optionsOpen);
	const [attachments, setAttachments] = useState<Attachment[]>(() => savedAttachments(sessionId));
	const [attachmentsStored, setAttachmentsStored] = useState(true);
	const [attachProblem, setAttachProblem] = useState<string | null>(null);
	const [pasteReview, setPasteReview] = useState<{ text: string; reason: string; bytes: number } | null>(null);
	const [pasteNotice, setPasteNotice] = useState<{ id: string; text: string } | null>(null);
	const attached = useRef<Attachment[]>(attachments);
	const picker = useRef<HTMLInputElement | null>(null);
	const pickerId = useId();
	const layerOwned = useLayersActive();
	const running = runningTurnId !== null;
	const params = { params: { id: sessionId }, query: {}, body: {} };
	useEffect(() => {
		setAttachmentsStored(persistAttachments(sessionId, attachments));
	}, [sessionId, attachments]);

	useEffect(() => {
		const focus = () => field.current?.focus();
		focusHandlers.set(sessionId, focus);
		return () => {
			if (focusHandlers.get(sessionId) === focus) focusHandlers.delete(sessionId);
		};
	}, [sessionId]);
	useEffect(() => {
		if (initialFocus && sessionState === "open" && window.matchMedia("(pointer: fine)").matches) field.current?.focus();
	}, [initialFocus, sessionState]);

	// This runs only with the isolated draft, never with incoming transcript frames.
	// biome-ignore lint/correctness/useExhaustiveDependencies: draft.text is the resize trigger; the DOM read happens in the callback.
	useLayoutEffect(() => fitComposerField(field.current), [draft.text]);
	useEffect(() => {
		const fit = () => fitComposerField(field.current);
		window.addEventListener("resize", fit);
		return () => window.removeEventListener("resize", fit);
	}, []);
	useEffect(() => rememberEnterSends(enterSends), [enterSends]);

	// Read once per session and keep. Every steering route answers 409 when the
	// agent announced nothing, so this decides what is rendered at all.
	const capabilities = useQuery({
		queryKey: ["session-capabilities", sessionId],
		queryFn: () => client.call(routes.sessionCapabilities, params),
		enabled: sessionState === "open",
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const steering = steeringAffordances(capabilities.data);
	const modes = steerModeOffers(steering);

	// Read only once a draft starts with a slash. The template list changes on a
	// library reload, so this observer lets it go stale where the palette does not.
	const slashDraft = draft.text.trimStart().startsWith("/");
	const commandCatalog = useQuery({
		queryKey: ["session-commands", sessionId],
		queryFn: () => client.call(routes.sessionCommands, params),
		enabled: slashDraft && sessionState === "open" && !!capabilities.data?.commands,
		staleTime: 30_000,
		retry: false,
	});
	// The slash palette. The textarea stays the combobox and owns every key; the list only renders.
	const pane = usePaneActions();
	const listId = useId();
	const [activeIndex, setActiveIndex] = useState(0);
	// Escape closes the palette for the text it was pressed on; typing reopens it.
	const [dismissed, setDismissed] = useState<string | null>(null);
	const [dialog, setDialog] = useState<SlashAction | null>(null);
	const [slashError, setSlashError] = useState<string | null>(null);
	// The branch tree is keyed on settled turns, the way the pane passes it.
	const [settledTurns, setSettledTurns] = useState(0);
	useEffect(() => {
		if (runningTurnId === null) setSettledTurns((count) => count + 1);
	}, [runningTurnId]);
	const entries = useMemo(
		() => slashEntries({ capabilities: capabilities.data, catalog: commandCatalog.data, paneAvailable: pane !== null }),
		[capabilities.data, commandCatalog.data, pane],
	);
	const query = sessionState === "open" ? slashQuery(draft.text) : null;
	const matches = useMemo(() => (query === null ? [] : filterSlashEntries(entries, query)), [entries, query]);
	const paletteOpen = matches.length > 0 && dismissed !== draft.text && dialog === null;
	const active = Math.min(activeIndex, Math.max(0, matches.length - 1));
	const line = slashDraft ? parseSlashLine(draft.text, commandCatalog.data) : null;
	const slash = slashDraft && line === null && !paletteOpen ? slashNotice(draft.text, commandCatalog.data) : null;

	const queue = useQuery({
		queryKey: ["session-queue", sessionId],
		queryFn: () => client.call(routes.sessionQueue, params),
		enabled: steering.queue && running,
		retry: false,
		refetchInterval: running ? 3_000 : false,
	});
	const queued = projectQueue(queue.data);

	const send = useMutation({
		mutationFn: async ({
			intent,
			attachments: sent,
		}: {
			intent: Exclude<SubmitIntent, { kind: "blocked" }>;
			draft: typeof draft;
			attachments: readonly Attachment[];
		}) => {
			if (intent.kind === "prompt") {
				const images = sent.filter((item): item is ImageAttachment => item.kind === "image");
				const files = sent.filter((item): item is FileAttachment => item.kind === "file");
				await client.call(
					routes.turn,
					{
						...params,
						body: {
							text: intent.text,
							...(images.length > 0 ? { images: images.map(({ mimeType, data }) => ({ mimeType, data })) } : {}),
							...(files.length > 0 ? { files: files.map(({ name, text }) => ({ name, text })) } : {}),
						},
					},
					intent.idempotencyKey,
				);
				return null;
			}
			return client.call(
				routes.steerSession,
				{ ...params, body: { text: intent.text, mode: intent.mode } },
				intent.idempotencyKey,
			);
		},
		onSuccess: (result, submitted) => {
			if (result !== null && !result.accepted) store.refuse(submitted.draft);
			else store.acknowledge(submitted.draft);
			if (result === null && submitted.attachments.length > 0) {
				// A refusal from an earlier pick described a file that is not going anywhere now.
				setAttachProblem(null);
				const sent = new Set(submitted.attachments.map((item) => item.id));
				attached.current = attached.current.filter((image) => !sent.has(image.id));
				setAttachments(attached.current);
			}
			// The event stream normally paints the turn. A snapshot also catches up if
			// this browser was reconnecting when the request was accepted.
			void queries.invalidateQueries({ queryKey: ["session", sessionId] });
			if (result !== null) void queries.invalidateQueries({ queryKey: ["session-queue", sessionId] });
		},
		onError: (error, submitted) => {
			// A 409 is a definite server refusal and is cached by its idempotency key.
			// Network failures are ambiguous, so they keep the key for a safe retry.
			if (capabilityRefusal(error) !== null) store.refuse(submitted.draft);
		},
		onSettled: () => {
			sending.current = false;
		},
	});

	const interrupt = useMutation({
		mutationFn: () => client.call(routes.interruptSession, { ...params, body: {} }),
		onSuccess: () => void queries.invalidateQueries({ queryKey: ["session", sessionId] }),
	});
	const stop = useMutation({
		mutationFn: () =>
			client.call(routes.cancelTurn, { params: { id: sessionId, turnId: runningTurnId ?? "" }, query: {}, body: {} }),
		onSuccess: () => void queries.invalidateQueries({ queryKey: ["session", sessionId] }),
	});
	const command = useMutation({
		mutationFn: ({ request, key }: { request: CommandRequest; key: string; description: string; sent: string | null }) =>
			client.call(routes.invokeSessionCommand, { ...params, body: request }, key),
		onSuccess: (_result, submitted) => {
			// A typed line is cleared once it ran, and only if it was not edited in the meantime.
			if (submitted.sent !== null && store.snapshot().text === submitted.sent) store.clear();
			void queries.invalidateQueries({ queryKey: ["session", sessionId] });
			if (submitted.request.command === "tasks")
				void queries.invalidateQueries({ queryKey: ["session-board", sessionId] });
		},
	});
	const runCommand = (plan: { request: CommandRequest; description: string }, sent: string | null) => {
		if (command.isPending) return;
		setSlashError(null);
		command.mutate({ request: plan.request, key: crypto.randomUUID(), description: plan.description, sent });
	};
	const placeCaretAtEnd = () =>
		requestAnimationFrame(() => {
			const element = field.current;
			if (!element) return;
			element.focus();
			element.setSelectionRange(element.value.length, element.value.length);
		});
	const pick = (entry: SlashEntry) => {
		setActiveIndex(0);
		setSlashError(null);
		if (entry.kind === "command") {
			const parsed = entry.needsArgs ? null : parseSlashLine(`/${entry.name}`, commandCatalog.data);
			if (parsed?.kind === "command") {
				store.clear();
				runCommand(parsed.plan, null);
				return;
			}
			// Required arguments: complete the name and let the operator type them; Enter then runs it.
			store.write(completedDraft(entry));
			placeCaretAtEnd();
			return;
		}
		store.clear();
		if (entry.kind === "pane") pane?.show(entry.view);
		else setDialog(entry.action);
	};

	const drain = useMutation({
		mutationFn: () => client.call(routes.clearSessionQueue, { ...params, body: {} }),
		onSuccess: (result) => {
			store.write(restoredDraft(store.snapshot().text, result.restored));
			void queries.invalidateQueries({ queryKey: ["session-queue", sessionId] });
			field.current?.focus();
		},
	});
	// What the engine said about one turn's interrupt, stop or queue is not a fact about the next
	// turn: without this an interrupt refusal stayed under the composer for the rest of the session.
	const resetInterrupt = interrupt.reset;
	const resetStop = stop.reset;
	const resetDrain = drain.reset;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the turn id is the trigger; the resets are stable.
	useEffect(() => {
		resetInterrupt();
		resetStop();
		resetDrain();
	}, [runningTurnId]);

	const steeringUnavailable: "checking" | "failed" | undefined = capabilities.data
		? undefined
		: capabilities.isFetching || capabilities.isPending
			? "checking"
			: capabilities.error
				? "failed"
				: "checking";
	const situation = {
		sessionState,
		turnRunning: running,
		sending: send.isPending,
		steering,
		...(steeringUnavailable === undefined ? {} : { steeringUnavailable }),
	} as const;
	const intent = submitIntent(draft, situation);
	const canAttachImages = capabilities.data?.images === true && sessionState === "open";
	const canAttachFiles = capabilities.data?.embeddedContext === true && sessionState === "open";
	const canAttach = canAttachImages || canAttachFiles;
	const attachBlock = attachmentRefusal(attachments, running);
	// The delivery switch takes the route's place in the row, and only once there is a message to
	// deliver: an empty field mid-turn offers Stop alone.
	const steerChoice = running && modes.length > 1 && draft.text.trim() !== "";
	// The palette reads the whole draft as its query, so it cannot open over a message in progress.
	const commandsReachable = sessionState === "open" && (draft.text.trim() === "" || slashDraft);
	// An image goes as an image when the agent takes them; anything else is offered as text.
	const readPicked = async (file: File): Promise<Attachment> => {
		if (file.type.startsWith("image/") && canAttachImages) return readAttachment(file, crypto.randomUUID());
		const name = file.name || "Pasted file";
		if (!canAttachFiles) throw new Error(`${name} is not a PNG, JPEG, GIF or WebP image.`);
		const read = decodeTextFile(name, new Uint8Array(await file.arrayBuffer()));
		if (!read.ok) throw new Error(read.reason);
		return { id: crypto.randomUUID(), kind: "file", name, text: read.text, bytes: read.bytes };
	};
	// One at a time, so each admission sees the attachments the previous one added.
	const attach = async (files: readonly File[]) => {
		setAttachProblem(null);
		for (const file of files) {
			try {
				const item = await readPicked(file);
				const admitted = admitAttachment(attached.current, item);
				if (!admitted.ok) {
					setAttachProblem(admitted.reason);
					break;
				}
				attached.current = [...attached.current, item];
				setAttachments(attached.current);
			} catch (error) {
				setAttachProblem(error instanceof Error ? error.message : String(error));
			}
		}
	};
	const attachLabel = canAttachFiles ? (canAttachImages ? "Attach files" : "Attach text files") : "Attach images";
	const detach = (id: string) => {
		attached.current = attached.current.filter((image) => image.id !== id);
		setAttachments(attached.current);
		setAttachProblem(null);
	};
	// Recomputed from the store rather than closed over, so a keystroke that
	// lands between render and keydown still sends the text the operator sees.
	const submit = () => {
		if (sending.current) return;
		const current = store.snapshot();
		// A line naming a session action or a catalog command runs it instead of becoming a prompt.
		// Anything else that starts with a slash, a prompt template say, still goes to the agent.
		if (sessionState === "open" && current.text.trimStart().startsWith("/")) {
			const exact = exactEntry(entries, current.text);
			if (exact) {
				pick(exact);
				return;
			}
			const parsed = parseSlashLine(current.text, commandCatalog.data);
			if (parsed?.kind === "invalid") {
				setSlashError(parsed.error);
				return;
			}
			if (parsed?.kind === "command") {
				runCommand(parsed.plan, current.text);
				return;
			}
		}
		const next = submitIntent(current, situation);
		if (next.kind !== "blocked" && attachmentRefusal(attached.current, running) === null) {
			sending.current = true;
			store.markSubmitted(current);
			send.mutate({ intent: next, draft: current, attachments: attached.current });
		}
	};

	const closeOptions = () => {
		if (!options.current) return;
		options.current.open = false;
		options.current.querySelector("summary")?.focus();
	};

	const notice =
		noticeForError(send.error ?? interrupt.error ?? stop.error ?? drain.error) ??
		noticeForRefusal(send.data) ??
		noticeForRefusal(interrupt.data);

	return (
		<>
			<form
				className="composer"
				data-steering={steerChoice ? "" : undefined}
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
				onDragOver={(event) => {
					if (canAttach && event.dataTransfer.types.includes("Files")) event.preventDefault();
				}}
				onDrop={(event) => {
					if (!canAttach || event.dataTransfer.files.length === 0) return;
					event.preventDefault();
					void attach([...event.dataTransfer.files]);
				}}
			>
				<label className="composer__label sr-only" htmlFor={fieldId}>
					Message Clio Coder
				</label>
				{paletteOpen ? (
					<SlashPalette listId={listId} entries={matches} activeIndex={active} onActivate={setActiveIndex} onPick={pick} />
				) : line !== null && dialog === null ? (
					<div className="slash-palette slash-palette--line" role="status">
						<p className="slash-palette__line">
							<code>{line.hint}</code>
							<span>{line.command.summary}</span>
						</p>
						{slashError ? (
							<p className="slash-palette__error">{slashError}</p>
						) : (
							<p className="slash-palette__keys">
								<kbd>{enterSends ? "Enter" : "Ctrl/⌘+Enter"}</kbd> runs{" "}
								{line.kind === "command" ? <code>{line.plan.description}</code> : "it once the arguments are complete"}
							</p>
						)}
					</div>
				) : null}
				<p className="sr-only" role="status">
					{paletteOpen ? `${matches.length} slash ${matches.length === 1 ? "command" : "commands"}` : ""}
				</p>
				<textarea
					id={fieldId}
					ref={field}
					className="composer__field"
					role="combobox"
					aria-autocomplete="list"
					aria-expanded={paletteOpen}
					{...(paletteOpen
						? {
								"aria-controls": listId,
								"aria-activedescendant": matches[active] ? slashOptionId(listId, matches[active]) : undefined,
							}
						: {})}
					aria-describedby={hintId}
					value={draft.text}
					rows={1}
					disabled={sessionState !== "open"}
					placeholder={
						sessionState !== "open"
							? "This conversation is not open"
							: running
								? steering.steer || steering.queue
									? "Steer Clio Coder while it works"
									: "Draft your next message"
								: "Describe a task or ask a question"
					}
					onChange={(event) => {
						store.write(event.target.value);
						setActiveIndex(0);
						setSlashError(null);
						if (!event.target.value.startsWith("/")) setDismissed(null);
						if (!send.isPending) send.reset();
					}}
					onPaste={(event) => {
						const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
						if (canAttachImages && images.length > 0) {
							event.preventDefault();
							void attach(images);
							return;
						}
						const paste = event.clipboardData.getData("text/plain");
						if (paste.length < LARGE_PASTE_CHARACTERS && paste.length + store.snapshot().text.length <= 32000) return;
						event.preventDefault();
						const field = event.currentTarget;
						let index = 1;
						while (attached.current.some((item) => item.name === `pasted-text-${index}.txt`)) index++;
						const plan = planPaste(
							paste,
							store.snapshot().text,
							field.selectionStart,
							field.selectionEnd,
							canAttachFiles,
							`pasted-text-${index}.txt`,
						);
						setPasteNotice(null);
						if (plan.kind === "review") {
							setPasteReview(plan);
							return;
						}
						if (plan.kind === "file") {
							const file: FileAttachment = { ...plan.file, id: crypto.randomUUID() };
							const admission = admitAttachment(attached.current, file);
							if (!admission.ok) {
								setPasteReview({ text: paste, reason: admission.reason, bytes: file.bytes });
								return;
							}
							attached.current = [...attached.current, file];
							setAttachments(attached.current);
							setPasteNotice({
								id: file.id,
								text: `Full paste attached as ${file.name} · ${Math.max(1, Math.round(file.bytes / 1024))} KiB`,
							});
						}
						setPasteReview(null);
						store.write(plan.text);
						if (!send.isPending) send.reset();
						requestAnimationFrame(() => field.setSelectionRange(plan.caret, plan.caret));
					}}
					onKeyDown={(event) => {
						if (paletteOpen && !event.nativeEvent.isComposing) {
							const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
							const count = matches.length;
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault();
								setActiveIndex((active + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
								return;
							}
							if ((event.key === "Enter" || event.key === "Tab") && plain) {
								event.preventDefault();
								const entry = matches[active];
								if (entry) pick(entry);
								return;
							}
							if (event.key === "Escape") {
								// The palette is the innermost layer here; nothing behind it should also close.
								event.preventDefault();
								event.stopPropagation();
								setDismissed(draft.text);
								return;
							}
						}
						const action = composerKeyAction(
							{
								key: event.key,
								altKey: event.altKey,
								ctrlKey: event.ctrlKey,
								metaKey: event.metaKey,
								shiftKey: event.shiftKey,
							},
							{ layerOwned, composing: event.nativeEvent.isComposing, plainEnterSends: enterSends },
						);
						if (action !== "send") return;
						event.preventDefault();
						submit();
					}}
				/>
				{pasteNotice && attachments.some((item) => item.id === pasteNotice.id) ? (
					<p className="composer__paste-note" role="status">
						<Icon name="paperclip" />
						{pasteNotice.text}
					</p>
				) : null}
				{pasteReview ? (
					<div className="composer__paste-review" role="status">
						<strong>Paste kept for review · {Math.max(1, Math.round(pasteReview.bytes / 1024))} KiB</strong>
						<p>{pasteReview.reason}</p>
						<details>
							<summary>Preview pasted text</summary>
							<pre>
								{pasteReview.text.slice(0, 4000)}
								{pasteReview.text.length > 4000 ? "\n… Preview shortened. The download contains the full paste." : ""}
							</pre>
						</details>
						<div>
							<button
								type="button"
								onClick={() => {
									const url = URL.createObjectURL(new Blob([pasteReview.text], { type: "text/plain;charset=utf-8" }));
									const link = document.createElement("a");
									link.href = url;
									link.download = "clio-coder-gui-pasted-text.txt";
									link.click();
									setTimeout(() => URL.revokeObjectURL(url), 1000);
								}}
							>
								Save full paste
							</button>
							<button type="button" onClick={() => setPasteReview(null)}>
								Dismiss paste
							</button>
						</div>
					</div>
				) : null}
				{store.uncertainSubmission() && (
					<p className="composer__notice" role="status">
						<StatusMark tone="warn" label="Review draft" />A send may have finished before this page reloaded. Check the
						conversation above before sending this draft again.
						<button type="button" className="composer__secondary" onClick={() => store.clear()}>
							Discard draft
						</button>
					</p>
				)}
				{attachments.length > 0 ? (
					<ul className="composer__attachments" aria-label="Attachments to send with this request">
						{attachments.map((item) => (
							<li key={item.id}>
								{item.kind === "image" ? (
									<img src={`data:${item.mimeType};base64,${item.data}`} alt="" width={48} height={48} />
								) : (
									<span className="composer__attachment-file" aria-hidden="true">
										{fileBadge(item.name)}
									</span>
								)}
								<span className="composer__attachment-name">
									{item.name}
									<small>
										{item.kind === "image"
											? `${item.width}×${item.height}`
											: `text, ${Math.max(1, Math.round(item.bytes / 1024))} KiB`}
									</small>
								</span>
								<span className="composer__attachment-actions">
									<button type="button" className="composer__secondary" onClick={() => saveAttachment(item)}>
										Save<span className="sr-only"> {item.name}</span>
									</button>
									<button type="button" className="composer__secondary" onClick={() => detach(item.id)}>
										Remove<span className="sr-only"> {item.name}</span>
									</button>
								</span>
							</li>
						))}
					</ul>
				) : null}
				{attachments.length > 0 && !attachmentsStored ? (
					<p className="composer__paste-note" role="status">
						Browser draft storage is unavailable. These attachments are kept in memory; save them before reloading this tab.
					</p>
				) : null}
				{attachProblem ? (
					<p className="composer__notice" role="alert">
						<StatusMark tone="fail" label="Not attached" />
						{attachProblem}
					</p>
				) : null}
				<p className="composer__hint sr-only" id={hintId}>
					{enterSends ? "Shift+Enter adds a line" : "Enter adds a line · Ctrl/⌘+Enter sends"} · @path adds a project file
					{attachments.length > 0 ? ` · ${attachmentSummary(attachments)}` : ""}
				</p>
				<div className="composer__actions">
					<div className="composer__tools">
						{canAttach ? (
							<input
								ref={picker}
								id={pickerId}
								hidden
								type="file"
								{...(canAttachFiles ? {} : { accept: "image/png,image/jpeg,image/gif,image/webp" })}
								multiple
								onChange={(event) => {
									const files = [...(event.target.files ?? [])];
									event.target.value = "";
									void attach(files);
								}}
							/>
						) : null}
						{/* One menu for everything that adds to a message or changes how it is typed. The file
						    input stays outside it, so a closed menu never unmounts a picker that is open. */}
						<details
							className="composer__options"
							ref={options}
							onToggle={(event) => setOptionsOpen(event.currentTarget.open)}
							onKeyDown={(event) => {
								if (event.key !== "Escape") return;
								event.preventDefault();
								closeOptions();
							}}
						>
							<summary aria-label="Add to message" title="Attach files, run a command, keyboard options">
								<Icon name="plus" />
							</summary>
							<div className="composer__options-panel">
								{canAttach ? (
									<button
										type="button"
										className="composer__menu-item"
										title={`You can also ${canAttachImages ? "paste or " : ""}drop them on the message box.`}
										onClick={() => {
											closeOptions();
											picker.current?.click();
										}}
									>
										<Icon name="paperclip" />
										{attachLabel}
									</button>
								) : null}
								<button
									type="button"
									className="composer__menu-item"
									disabled={!commandsReachable}
									title={
										commandsReachable
											? "Clio Coder commands and this task's actions"
											: "A command is a line of its own. Send or clear the draft first."
									}
									onClick={() => {
										if (options.current) options.current.open = false;
										setDismissed(null);
										setActiveIndex(0);
										store.write("/");
										placeCaretAtEnd();
									}}
								>
									<Icon name="system" />
									Commands
									<kbd>/</kbd>
								</button>
								{running && steering.interrupt ? (
									<button
										type="button"
										className="composer__menu-item"
										disabled={interrupt.isPending}
										title="Ask Clio Coder to put down what it is doing and take new direction. The turn stays open."
										onClick={() => {
											closeOptions();
											interrupt.mutate();
										}}
									>
										<Icon name="stop" />
										{interrupt.isPending ? "Interrupting…" : "Interrupt"}
									</button>
								) : null}
								<label className="composer__enter-mode">
									<input type="checkbox" checked={enterSends} onChange={(event) => setEnterSends(event.target.checked)} />
									Enter sends
								</label>
								<p className="composer__options-note">
									{enterSends ? "Shift+Enter adds a line." : "Enter adds a line. Ctrl/⌘+Enter sends."} @path adds a project file.
								</p>
							</div>
						</details>
						<AutonomyPill client={client} sessionId={sessionId} capabilities={capabilities.data} locked={running} />
					</div>
					<div className="composer__route-actions">
						<RoutePicker
							client={client}
							sessionId={sessionId}
							route={route}
							running={running}
							capabilities={capabilities.data}
						/>
						{steerChoice ? (
							<fieldset className="composer__delivery">
								<legend className="sr-only">Deliver this message</legend>
								{modes.map((offer) => (
									<button
										key={offer.mode}
										type="button"
										aria-pressed={draft.mode === offer.mode}
										aria-label={offer.label}
										title={`${offer.label}. ${offer.lands}`}
										disabled={send.isPending}
										onClick={() => {
											store.chooseMode(offer.mode);
											if (!send.isPending) send.reset();
										}}
									>
										<span className="composer__delivery-full">{offer.label}</span>
										<span className="composer__delivery-short">{offer.short}</span>
									</button>
								))}
							</fieldset>
						) : null}
						{running ? (
							<button
								className="composer__icon-button composer__stop composer__stop--live"
								type="button"
								disabled={stop.isPending}
								onClick={() => stop.mutate()}
								aria-label={stop.isPending ? "Stopping…" : "Stop turn"}
								title="End this turn now. Nothing further is run."
							>
								{sessionState === "open" ? <ClioPulse size={PULSE_SIZE.row} /> : null}
								<Icon name="stop" />
								<span aria-hidden="true">{stop.isPending ? "Stopping" : "Stop"}</span>
							</button>
						) : null}
						{!running || draft.text.trim() !== "" ? (
							<button
								className="composer__submit primary"
								type="submit"
								disabled={intent.kind === "blocked" || attachBlock !== null}
								aria-label={send.isPending ? "Sending…" : submitLabel(intent, situation, draft.mode)}
								title={intent.kind === "blocked" ? intent.reason : (attachBlock ?? submitLabel(intent, situation, draft.mode))}
							>
								{send.isPending ? <ClioPulse size={PULSE_SIZE.row} /> : <Icon name="arrowUp" />}
							</button>
						) : null}
					</div>
				</div>
				{attachBlock !== null && intent.kind !== "blocked" ? (
					<p className="composer__blocked" role="status">
						{attachBlock}
					</p>
				) : null}
				{intent.kind === "blocked" && draft.text.trim() !== "" ? (
					<p className="composer__blocked" role="status">
						{intent.reason}
						{running && steeringUnavailable === "failed" ? (
							<button
								type="button"
								className="composer__secondary"
								disabled={capabilities.isFetching}
								onClick={() => void capabilities.refetch()}
							>
								Retry control check
							</button>
						) : null}
					</p>
				) : null}
				{slash && !send.isPending ? (
					<p className="composer__notice" role="status">
						<StatusMark tone={slash.tone} label="Not a command" />
						{slash.message}
					</p>
				) : null}
				{command.isPending ? (
					<p className="composer__notice" role="status">
						<ClioPulse size={PULSE_SIZE.row} />
						Running <code>{command.variables?.description}</code>…
					</p>
				) : null}
				{command.error ? (
					<p className="composer__notice" role="alert">
						<StatusMark tone="fail" label="Command failed" />
						{command.error.message}
					</p>
				) : null}
				{command.data ? (
					<div className="slash-result" role="status">
						<p className="slash-result__head">
							<StatusMark
								tone={
									command.data.level === "error"
										? "fail"
										: command.data.level === "warn"
											? "warn"
											: command.data.level === "success"
												? "success"
												: "neutral"
								}
								label={`Command ${command.data.level}`}
							/>
							<code>{command.variables?.description}</code>
							<button type="button" className="composer__secondary" onClick={() => command.reset()}>
								Dismiss
							</button>
						</p>
						{command.data.lines.length ? (
							// biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded result can scroll with keyboard arrows.
							<pre tabIndex={0}>{command.data.lines.join("\n")}</pre>
						) : (
							<p>Clio Coder returned no lines. Check the conversation for any ongoing work.</p>
						)}
					</div>
				) : null}
				{notice ? (
					<p className="composer__notice" role={notice.tone === "fail" ? "alert" : "status"}>
						<StatusMark tone={notice.tone} label={notice.tone === "fail" ? "Failed" : "Refused"} />
						{notice.message}
					</p>
				) : null}
				{/* Only while the turn runs: the query is disabled once it settles, and a
			    cached snapshot from a finished turn is a claim about the engine that
			    nothing observed. */}
				{running && steering.queue && queued.length > 0 ? (
					<section className="composer__queue" aria-label="Messages waiting on the engine">
						<p className="composer__queue-summary" role="status">
							{queueSummary(queued)}
						</p>
						<ol className="composer__queue-list">
							{queued.map((message) => (
								<li key={message.id} className="composer__queue-row">
									<StatusMark tone="warn" label={message.queue === "steer" ? "Now" : "After this turn"} />
									<span className="composer__queue-text">{message.text}</span>
								</li>
							))}
						</ol>
						<button
							className="composer__secondary"
							type="button"
							disabled={drain.isPending}
							onClick={() => drain.mutate()}
							title="Take every waiting message back out of the queue and into this field."
						>
							{drain.isPending ? "Taking them back…" : "Take them back"}
						</button>
					</section>
				) : null}
			</form>
			{/* Outside the form: React bubbles a portaled panel's submit through its owner, and the
		    composer's own submit must never hear it. */}
			{dialog !== null ? (
				<SlashActionDialog
					action={dialog}
					client={client}
					sessionId={sessionId}
					sessionOpen={sessionState === "open"}
					capabilities={capabilities.data}
					running={running}
					settledTurns={settledTurns}
					onClose={() => setDialog(null)}
				/>
			) : null}
		</>
	);
});
