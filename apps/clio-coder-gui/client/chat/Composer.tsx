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
import type { CommandRequest, QueueEditRequest, QueueSnapshot } from "../../contracts/steering.js";
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
import { type HistoryBrowse, readHistory, rememberPrompt, stepHistory } from "./composer-history.js";
import {
	type ComposerNotice,
	capabilityRefusal,
	composerKeyAction,
	draftStore,
	noticeForError,
	noticeForQueueEdit,
	noticeForRefusal,
	projectQueue,
	queueActions,
	queueSummary,
	restoredDraft,
	type SubmitIntent,
	shellNotice,
	slashNotice,
	steeringAffordances,
	steerModeOffers,
	submitIntent,
	submitLabel,
} from "./composer-model.js";
import { foldFleetRuns, isLiveRun, steerOutcome } from "./fleet-facts.js";
import { SuggestionPalette, type SuggestionRow, suggestionOptionId } from "./MentionPalette.js";
import {
	applyMention,
	mentionQuery,
	parseSteerMention,
	type RunningRun,
	resolveSteerTarget,
	steerCandidates,
} from "./mention-model.js";
import { usePaneActions } from "./pane-context.js";
import { LARGE_PASTE_CHARACTERS, planPaste } from "./paste-model.js";
import { RoutePicker } from "./RoutePicker.js";
import type { RouteFacts } from "./route.js";
import { SlashActionDialog, SlashPalette, slashOptionId } from "./SlashPalette.js";
import {
	argumentSuggestions,
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
	/** The workspace an `@` reference is completed against. */
	readonly workspaceId: string;
	readonly sessionState: SessionSnapshot["state"];
	readonly initialFocus: boolean;
	/** The id of the turn running right now, or null when none is. */
	readonly runningTurnId: string | null;
	readonly contextRunning?: boolean;
	/** Where the next request goes. Memoize it: a new object on every render re-renders the field. */
	readonly route: RouteFacts;
}

export const Composer = memo(function Composer({
	client,
	sessionId,
	workspaceId,
	sessionState,
	initialFocus,
	runningTurnId,
	contextRunning = false,
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

	// The `@` list. The caret is state only so the reference under it can be read during render; it
	// changes with typing and caret moves, never with transcript frames.
	const [caret, setCaret] = useState(0);
	const [mentionIndex, setMentionIndex] = useState(0);
	const [mentionDismissed, setMentionDismissed] = useState<string | null>(null);
	const mention =
		sessionState === "open" && !paletteOpen && draft.text.includes("@") ? mentionQuery(draft.text, caret) : null;
	const mentionKey = mention === null ? null : `${mention.start}:${mention.path}`;
	const files = useQuery({
		queryKey: ["workspace-files", workspaceId, mention?.path ?? ""],
		queryFn: () =>
			client.call(routes.workspaceFiles, { params: { id: workspaceId }, query: { input: mention?.path ?? "" }, body: {} }),
		enabled: mention !== null && workspaceId !== "",
		staleTime: 4_000,
		retry: false,
		// The previous list stays up while the next keystroke's answer is on its way.
		placeholderData: (previous) => previous,
	});
	const fileMatches = mention === null ? [] : (files.data?.matches ?? []);
	// Read from the cache when the list is built, never subscribed to: the composer must not render
	// with the transcript.
	const liveRuns = (): readonly RunningRun[] =>
		foldFleetRuns(queries.getQueryData<SessionSnapshot>(["session", sessionId])?.fleet ?? []).filter(isLiveRun);
	// A message that opens with `@name` can steer a running agent, so those lead the list there.
	const agents =
		mention !== null && mention.start === 0 && running && steering.dispatch && !mention.path.includes("/")
			? liveRuns().filter((run) => run.agentId.toLowerCase().startsWith(mention.path.toLowerCase()))
			: [];
	const argMatches =
		!paletteOpen && slashDraft && mention === null ? argumentSuggestions(draft.text, commandCatalog.data) : [];
	const suggestions: readonly SuggestionRow[] =
		mention !== null
			? [
					...agents.map((run) => ({
						id: `agent:${run.runId}`,
						label: run.agentId,
						summary: `running agent · ${run.runId.slice(0, 8)}`,
						icon: "bolt" as const,
					})),
					...fileMatches.map((match) => ({
						id: `file:${match.path}`,
						label: `${match.name}${match.directory ? "/" : ""}`,
						summary: match.path.slice(0, match.path.length - match.name.length - (match.directory ? 1 : 0)),
						icon: match.directory ? ("folder" as const) : ("artifacts" as const),
						path: true,
					})),
				]
			: argMatches.map((row) => ({ id: `arg:${row.value}`, label: row.value, summary: row.summary }));
	const suggestionKey = mention !== null ? mentionKey : argMatches.length > 0 ? draft.text : null;
	const mentionOpen = suggestions.length > 0 && mentionDismissed !== suggestionKey && dialog === null;
	const mentionActive = Math.min(mentionIndex, Math.max(0, suggestions.length - 1));
	const [steerNote, setSteerNote] = useState<{ tone: "success" | "warn" | "fail"; message: string } | null>(null);
	// A second Esc within this window stops the turn; the first only says so.
	const [stopArmed, setStopArmed] = useState(false);
	useEffect(() => {
		if (!stopArmed) return;
		const timer = setTimeout(() => setStopArmed(false), 2_000);
		return () => clearTimeout(timer);
	}, [stopArmed]);
	// What ↑ and ↓ recalled, so the next press continues from it instead of moving the caret.
	const browse = useRef<(HistoryBrowse & { readonly text: string }) | null>(null);
	const slash = slashDraft && line === null && !paletteOpen ? slashNotice(draft.text, commandCatalog.data) : null;

	const queue = useQuery({
		queryKey: ["session-queue", sessionId],
		queryFn: () => client.call(routes.sessionQueue, params),
		enabled: steering.queue && running,
		retry: false,
		// An agent with the queue capability pushes every change; an older one is asked.
		refetchInterval: running && !capabilities.data?.queue ? 3_000 : false,
	});
	const queued = projectQueue(queue.data);
	const queueOps = capabilities.data?.queue?.ops;

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
			if (intent.kind === "shell") {
				await client.call(
					routes.shellSession,
					{
						...params,
						body: {
							command: intent.command,
							...(intent.excludeFromContext ? { excludeFromContext: true } : {}),
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
		if (command.isPending || contextRunning) return;
		setSlashError(null);
		command.mutate({ request: plan.request, key: crypto.randomUUID(), description: plan.description, sent });
	};
	const placeCaret = (at: number | null) =>
		requestAnimationFrame(() => {
			const element = field.current;
			if (!element) return;
			element.focus();
			const position = at ?? element.value.length;
			element.setSelectionRange(position, position);
			setCaret(position);
		});
	const placeCaretAtEnd = () => placeCaret(null);
	const pickSuggestion = (index: number) => {
		setMentionIndex(0);
		if (mention === null) {
			const row = argMatches[index];
			if (!row) return;
			store.write(row.draft);
			placeCaretAtEnd();
			return;
		}
		const agent = agents[index];
		const file = fileMatches[index - agents.length];
		if (!agent && !file) return;
		const edit = agent
			? { text: `@${agent.agentId} ${draft.text.slice(caret).trimStart()}`, caret: agent.agentId.length + 2 }
			: file
				? applyMention(draft.text, caret, mention, file.path, file.directory)
				: null;
		if (edit === null) return;
		store.write(edit.text);
		placeCaret(edit.caret);
	};
	const guide = useMutation({
		mutationFn: ({ run, message }: { run: RunningRun; message: string; sent: string }) =>
			client.call(routes.steerDispatchRun, {
				params: { id: sessionId },
				query: {},
				body: { runId: run.runId, action: "guide", message },
			}),
		onSuccess: (result, submitted) => {
			const outcome = steerOutcome("guide", result);
			setSteerNote({
				tone: outcome.tone === "success" ? "success" : "warn",
				message: `${submitted.run.agentId}: ${outcome.message}`,
			});
			if (result.accepted && store.snapshot().text === submitted.sent) store.clear();
		},
		onError: (error) =>
			setSteerNote({
				tone: capabilityRefusal(error) === null ? "fail" : "warn",
				message: capabilityRefusal(error) ?? (error instanceof Error ? error.message : String(error)),
			}),
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
	const [queueNote, setQueueNote] = useState<ComposerNotice | null>(null);
	const edit = useMutation({
		mutationFn: (request: QueueEditRequest) =>
			client.call(routes.editSessionQueue, { ...params, body: request }, crypto.randomUUID()),
		onMutate: () => setQueueNote(null),
		onSuccess: (result, request) => {
			queries.setQueryData<QueueSnapshot>(["session-queue", sessionId], {
				steer: result.entries.filter((entry) => entry.kind === "steer").map((entry) => entry.text),
				followUp: result.entries.filter((entry) => entry.kind === "follow-up").map((entry) => entry.text),
				entries: result.entries,
			});
			setQueueNote(noticeForQueueEdit(result));
			if (request.op === "restore" && result.applied && result.text !== undefined) {
				store.write(restoredDraft(store.snapshot().text, [result.text]));
				placeCaretAtEnd();
			}
			if (request.op === "send_now") void queries.invalidateQueries({ queryKey: ["session", sessionId] });
		},
		onError: (error) => setQueueNote(noticeForError(error)),
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
		setQueueNote(null);
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
		shell: capabilities.data?.shell !== undefined,
	} as const;
	const intent = submitIntent(draft, situation);
	const canAttachImages = capabilities.data?.images === true && sessionState === "open";
	const canAttachFiles = capabilities.data?.embeddedContext === true && sessionState === "open";
	const canAttach = canAttachImages || canAttachFiles;
	const shellBlock = (kind: SubmitIntent["kind"], count: number) =>
		kind === "shell" && count > 0 ? "A shell line takes no attachments. Remove them, or send a message instead." : null;
	const attachBlock =
		(contextRunning && !running ? "Context work is running. Your draft is kept until it finishes." : null) ??
		shellBlock(intent.kind, attachments.length) ??
		attachmentRefusal(attachments, running);
	const shellHint = shellNotice(draft.text, situation.shell);
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
		if (sending.current || (contextRunning && !running)) return;
		const current = store.snapshot();
		// `@agent text` guides a running worker instead of the main turn. With no worker running the
		// line is an ordinary message, and its `@word` an ordinary file reference.
		const steerTo = steering.dispatch ? parseSteerMention(current.text) : null;
		const runs = steerTo === null ? [] : liveRuns();
		if (steerTo !== null && runs.length > 0) {
			const target = resolveSteerTarget(steerTo.target, runs);
			if (target.kind === "match") {
				if (guide.isPending) return;
				setSteerNote(null);
				rememberPrompt(current.text);
				guide.mutate({ run: target.run, message: steerTo.text, sent: current.text });
			} else
				setSteerNote({
					tone: "warn",
					message:
						target.kind === "ambiguous"
							? `@${steerTo.target} names more than one running agent. Use a run id: ${steerCandidates(target.candidates)}.`
							: `No running agent is named @${steerTo.target}. Running: ${steerCandidates(runs)}. To reference a file of that name, write @"${steerTo.target}".`,
				});
			return;
		}
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
				rememberPrompt(current.text);
				runCommand(parsed.plan, current.text);
				return;
			}
		}
		const next = submitIntent(current, situation);
		if (
			next.kind !== "blocked" &&
			shellBlock(next.kind, attached.current.length) === null &&
			attachmentRefusal(attached.current, running) === null
		) {
			sending.current = true;
			browse.current = null;
			rememberPrompt(current.text);
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
		queueNote ??
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
				) : mentionOpen ? (
					<SuggestionPalette
						listId={listId}
						label={mention !== null ? "Files in this workspace" : "Command arguments"}
						rows={suggestions}
						activeIndex={mentionActive}
						onActivate={setMentionIndex}
						onPick={pickSuggestion}
						keys={
							mention !== null ? (
								<>
									<kbd>Enter</kbd> or <kbd>Tab</kbd>{" "}
									{mentionActive < agents.length
										? "steer"
										: fileMatches[mentionActive - agents.length]?.directory
											? "open"
											: "add"}{" "}
									· <kbd>Esc</kbd> close{files.data?.truncated ? " · keep typing to narrow" : ""}
								</>
							) : (
								<>
									<kbd>Tab</kbd> pick · <kbd>Enter</kbd> {line?.kind === "command" ? "runs the line" : "pick"} · <kbd>Esc</kbd>{" "}
									close
								</>
							)
						}
					/>
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
					{paletteOpen
						? `${matches.length} slash ${matches.length === 1 ? "command" : "commands"}`
						: mentionOpen
							? `${suggestions.length} ${suggestions.length === 1 ? "suggestion" : "suggestions"}`
							: ""}
				</p>
				{/* Only while the turn runs: the query is disabled once it settles, and a
			    cached snapshot from a finished turn is a claim about the engine that
			    nothing observed. */}
				{running && steering.queue && queued.length > 0 ? (
					<section className="composer__queue" aria-label="Messages waiting on the engine">
						<div className="composer__queue-head">
							<p className="composer__queue-summary" role="status">
								{queueSummary(queued)}
							</p>
							<button
								className="composer__attachment-action"
								type="button"
								disabled={drain.isPending}
								onClick={() => drain.mutate()}
								title="Take every waiting message back out of the queue and into this field."
							>
								{drain.isPending ? "Taking them back…" : "Take them back"}
							</button>
						</div>
						<ol className="composer__queue-list">
							{queued.map((message) => (
								<li key={message.id} className="composer__queue-row">
									<StatusMark tone="warn" label={message.queue === "steer" ? "Now" : "After this turn"} />
									<span className="composer__queue-text" title={message.text}>
										{message.text}
									</span>
									<span className="composer__queue-actions">
										{queueActions(message, queued, queueOps).map((action) => (
											<button
												key={action.key}
												className={`composer__attachment-action${action.icon ? " composer__attachment-remove" : ""}`}
												type="button"
												disabled={edit.isPending}
												aria-label={action.icon ? `${action.label}: ${message.text.slice(0, 80)}` : undefined}
												title={action.title}
												onClick={() => edit.mutate(action.request)}
											>
												{action.icon ? <Icon name={action.icon} /> : action.label}
											</button>
										))}
									</span>
								</li>
							))}
						</ol>
					</section>
				) : null}
				{attachments.length > 0 ? (
					<ul className="composer__attachments" aria-label="Attachments to send with this request">
						{attachments.map((item) => (
							<li key={item.id}>
								{item.kind === "image" ? (
									<img src={`data:${item.mimeType};base64,${item.data}`} alt="" width={28} height={28} />
								) : (
									<span className="composer__attachment-file" aria-hidden="true">
										{fileBadge(item.name)}
									</span>
								)}
								<span className="composer__attachment-name">
									<span className="composer__attachment-title" title={item.name}>
										{item.name}
									</span>
									<small>
										{item.kind === "image"
											? `${item.width}×${item.height}`
											: `text, ${Math.max(1, Math.round(item.bytes / 1024))} KiB`}
									</small>
								</span>
								<button type="button" className="composer__attachment-action" onClick={() => saveAttachment(item)}>
									Save<span className="sr-only"> {item.name}</span>
								</button>
								<button
									type="button"
									className="composer__attachment-action composer__attachment-remove"
									onClick={() => detach(item.id)}
								>
									<Icon name="close" />
									<span className="sr-only">Remove {item.name}</span>
								</button>
							</li>
						))}
					</ul>
				) : null}
				{pasteNotice && attachments.some((item) => item.id === pasteNotice.id) ? (
					<p className="composer__paste-note" role="status">
						<Icon name="paperclip" />
						{pasteNotice.text}
					</p>
				) : null}
				{attachments.length > 0 && !attachmentsStored ? (
					<p className="composer__paste-note" role="status">
						Browser draft storage is unavailable. These attachments are kept in memory; save them before reloading this tab.
					</p>
				) : null}
				{pasteReview ? (
					<div className="composer__paste-review" role="status">
						<div className="composer__paste-head">
							<StatusMark tone="warn" label="Paste kept for review" />
							<span className="composer__paste-size">· {Math.max(1, Math.round(pasteReview.bytes / 1024))} KiB</span>
							<span className="composer__paste-actions">
								<button
									type="button"
									className="composer__attachment-action"
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
								<button type="button" className="composer__attachment-action" onClick={() => setPasteReview(null)}>
									Dismiss paste
								</button>
							</span>
						</div>
						<p>{pasteReview.reason}</p>
						<details>
							<summary>Preview pasted text</summary>
							<pre>
								{pasteReview.text.slice(0, 4000)}
								{pasteReview.text.length > 4000 ? "\n… Preview shortened. The download contains the full paste." : ""}
							</pre>
						</details>
					</div>
				) : null}
				<textarea
					id={fieldId}
					ref={field}
					className="composer__field"
					role="combobox"
					aria-autocomplete="list"
					aria-expanded={paletteOpen || mentionOpen}
					{...(paletteOpen
						? {
								"aria-controls": listId,
								"aria-activedescendant": matches[active] ? slashOptionId(listId, matches[active]) : undefined,
							}
						: mentionOpen
							? { "aria-controls": listId, "aria-activedescendant": suggestionOptionId(listId, mentionActive) }
							: {})}
					aria-describedby={hintId}
					value={draft.text}
					rows={1}
					// A paused task keeps its draft editable without waking its agent.
					disabled={sessionState !== "open" && sessionState !== "parked"}
					placeholder={
						sessionState !== "open" && sessionState !== "parked"
							? "This conversation is not open"
							: running
								? steering.steer || steering.queue
									? "Steer Clio while it works"
									: "Draft your next message"
								: "Describe a task or ask a question"
					}
					onChange={(event) => {
						store.write(event.target.value);
						setCaret(event.target.selectionStart);
						setMentionIndex(0);
						setMentionDismissed(null);
						setSteerNote(null);
						setStopArmed(false);
						browse.current = null;
						setActiveIndex(0);
						setSlashError(null);
						if (!event.target.value.startsWith("/")) setDismissed(null);
						if (!send.isPending) send.reset();
					}}
					onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
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
						const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
						if (mentionOpen && !event.nativeEvent.isComposing) {
							const count = suggestions.length;
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault();
								setMentionIndex((mentionActive + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
								return;
							}
							// On a command line that can already run, Enter runs it and Tab takes the suggestion.
							const enterPicks = mention !== null || line?.kind !== "command";
							if ((event.key === "Tab" || (event.key === "Enter" && enterPicks)) && plain) {
								event.preventDefault();
								pickSuggestion(mentionActive);
								return;
							}
							if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								setMentionDismissed(suggestionKey);
								return;
							}
						}
						// Esc with nothing open stops the turn, as it does in the terminal, on the second press.
						if (event.key === "Escape" && plain && running && !layerOwned && !optionsOpen) {
							event.preventDefault();
							if (stopArmed && !stop.isPending) stop.mutate();
							setStopArmed(!stopArmed);
							return;
						}
						if ((event.key === "ArrowUp" || event.key === "ArrowDown") && plain && !event.nativeEvent.isComposing) {
							const element = event.currentTarget;
							const browsing = browse.current !== null && browse.current.text === draft.text ? browse.current : null;
							// ↑ recalls from the very start of the field, where there is no line above to move to.
							const offered =
								event.key === "ArrowUp"
									? browsing !== null || (element.selectionStart === 0 && element.selectionEnd === 0)
									: browsing !== null;
							const step = offered
								? stepHistory(readHistory(), browsing, event.key === "ArrowUp" ? "older" : "newer", draft.text)
								: null;
							if (step !== null) {
								event.preventDefault();
								store.write(step.text);
								browse.current = step.browse === null ? null : { ...step.browse, text: step.text };
								placeCaretAtEnd();
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
				{store.uncertainSubmission() && (
					<p className="composer__notice" role="status">
						<StatusMark tone="warn" label="Review draft" />A send may have finished before this page reloaded. Check the
						conversation above before sending this draft again.
						<button type="button" className="composer__secondary" onClick={() => store.clear()}>
							Discard draft
						</button>
					</p>
				)}
				{stopArmed && running ? (
					<p className="composer__notice" role="status">
						Press <kbd>Esc</kbd> again to stop this turn.
					</p>
				) : null}
				{steerNote ? (
					<p className="composer__notice" role={steerNote.tone === "fail" ? "alert" : "status"}>
						<StatusMark
							tone={steerNote.tone}
							label={steerNote.tone === "success" ? "Sent to agent" : steerNote.tone === "fail" ? "Failed" : "Not sent"}
						/>
						{steerNote.message}
					</p>
				) : null}
				{attachProblem ? (
					<p className="composer__notice" role="alert">
						<StatusMark tone="fail" label="Not attached" />
						{attachProblem}
					</p>
				) : null}
				<p className="composer__hint sr-only" id={hintId}>
					{enterSends ? "Shift+Enter adds a line" : "Enter adds a line · Ctrl/⌘+Enter sends"} · @ adds a file or folder · ↑
					recalls earlier messages
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
									{enterSends ? "Shift+Enter adds a line." : "Enter adds a line. Ctrl/⌘+Enter sends."} @ adds a file or folder. ↑
									recalls earlier messages.
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
				{shellHint !== null && intent.kind === "shell" && attachBlock === null ? (
					<p className="composer__notice" role="status">
						<StatusMark tone="neutral" label="Shell" />
						{shellHint}
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
