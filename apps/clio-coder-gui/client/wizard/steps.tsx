import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import type { SetupAnswer } from "../../contracts/setup.js";
import { Icon } from "../design/icons.js";
import { ClioPulse, PULSE_SIZE } from "../shell/ClioMark.js";
import {
	backAnswer,
	type CategoryKey,
	type Choice,
	type CredentialOption,
	matches,
	type ProviderOption,
	type ReviewFact,
	type StepView,
	selectAnswer,
	sentence,
	startingModel,
	textAnswer,
} from "./wizard-model.js";

export interface StepProps<V extends StepView = StepView> {
	readonly view: V;
	readonly busy: boolean;
	/** The CLI's refusal of the last answer, shown beside the field it concerns. */
	readonly problem: string | null;
	send(answer: SetupAnswer): void;
}

type Of<K extends StepView["kind"]> = Extract<StepView, { kind: K }>;

/** Move focus to the field that matters, else the heading, when a step appears. */
function useStepFocus() {
	const root = useRef<HTMLElement>(null);
	useEffect(() => {
		const node = root.current;
		if (!node) return;
		const target = node.querySelector<HTMLElement>("[data-autofocus]") ?? node.querySelector<HTMLElement>("h1");
		target?.focus({ preventScroll: true });
	}, []);
	return root;
}

function Step({
	title,
	lede,
	children,
	actions,
	wide = false,
}: {
	title: string;
	lede?: ReactNode;
	children?: ReactNode;
	actions?: ReactNode;
	wide?: boolean;
}) {
	const root = useStepFocus();
	const id = useId();
	return (
		<section className="wizard-step" data-wide={wide ? "yes" : undefined} ref={root} aria-labelledby={id}>
			<h1 id={id} tabIndex={-1}>
				{title}
			</h1>
			{lede ? <div className="wizard-step__lede">{lede}</div> : null}
			{children}
			{actions ? <div className="wizard-step__actions">{actions}</div> : null}
		</section>
	);
}

function Problem({ text }: { text: string | null }) {
	return text ? (
		<p className="wizard-problem" role="alert">
			{text}
		</p>
	) : null;
}

/** Arrow keys move between the buttons of a tile grid, the way a menu does. */
function arrowNavigation(event: KeyboardEvent<HTMLElement>) {
	const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
	if (!keys.includes(event.key) || !(event.target instanceof HTMLElement)) return;
	const tiles = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-tile]:not(:disabled)")];
	const at = tiles.indexOf(event.target);
	if (at < 0) return;
	event.preventDefault();
	const next =
		event.key === "Home"
			? 0
			: event.key === "End"
				? tiles.length - 1
				: event.key === "ArrowRight" || event.key === "ArrowDown"
					? Math.min(tiles.length - 1, at + 1)
					: Math.max(0, at - 1);
	tiles[next]?.focus();
}

// ---- welcome -----------------------------------------------------------------------------------

export function WelcomeStep({
	mode,
	busy,
	error,
	onStart,
	onLater,
}: {
	mode: "first" | "add" | "repair";
	busy: boolean;
	error: string | null;
	onStart: () => void;
	onLater: (() => void) | null;
}) {
	return (
		<Step
			title={
				mode === "first" ? "Welcome to Clio Coder." : mode === "add" ? "Add a connection." : "Repair your connection."
			}
			lede={
				mode === "first" ? (
					<>
						<p>Choose what you already use. Clio checks the endpoint and model list when the provider allows it.</p>
						<p>
							Back returns to the previous step. Your choices are saved only at the review, except a browser sign-in you
							complete.
						</p>
					</>
				) : (
					<p>Clio checks what you choose before it saves anything, and a sign-in you finish stays stored.</p>
				)
			}
			actions={
				<>
					<button type="button" className="primary wizard-button" data-autofocus disabled={busy} onClick={onStart}>
						{busy ? (
							<>
								<ClioPulse size={PULSE_SIZE.row} />
								Starting setup
							</>
						) : (
							"Get started"
						)}
					</button>
					{onLater ? (
						<button type="button" className="wizard-quiet" onClick={onLater}>
							Not now
						</button>
					) : null}
				</>
			}
		>
			{mode === "first" ? (
				<ol className="wizard-promise">
					<li>
						<strong>Pick a provider.</strong> An app on this computer, a server, a subscription or an API account.
					</li>
					<li>
						<strong>Connect and choose a model.</strong> Clio checks the address and reads the model list.
					</li>
					<li>
						<strong>Open a folder.</strong> Clio works inside it and asks before it changes anything.
					</li>
				</ol>
			) : null}
			<Problem text={error} />
		</Step>
	);
}

// ---- provider ----------------------------------------------------------------------------------

const CATEGORY_ICONS: Readonly<Record<CategoryKey, Parameters<typeof Icon>[0]["name"]>> = {
	"local-app": "system",
	"local-server": "models",
	subscription: "skills",
	"cloud-api": "external",
	"external-worker": "fleet",
};

export function CategoryStep({ view, busy, send }: StepProps<Of<"category">>) {
	return (
		<Step
			title="Where does your model come from?"
			lede={<p>Choose the description you recognize. The providers come next.</p>}
		>
			<ul className="wizard-cards" onKeyDown={arrowNavigation}>
				{view.options.map((option, index) => (
					<li key={option.choice.id}>
						<button
							type="button"
							className="wizard-card"
							data-tile
							{...(index === view.prompt.initial || (index === 0 && view.prompt.initial >= view.options.length)
								? { "data-autofocus": true }
								: {})}
							disabled={busy}
							onClick={() => send(selectAnswer(view.prompt, option.choice))}
						>
							<span className="wizard-card__icon" aria-hidden="true">
								<Icon name={option.key ? CATEGORY_ICONS[option.key] : "models"} />
							</span>
							<span className="wizard-card__text">
								<strong>{option.label}</strong>
								<small>{option.summary}</small>
							</span>
							<Icon name="chevronRight" />
						</button>
					</li>
				))}
			</ul>
		</Step>
	);
}

export function ProviderStep({ view, busy, send }: StepProps<Of<"provider">>) {
	const [query, setQuery] = useState("");
	const shown = useMemo(
		() => view.options.filter((option) => matches([option.label, option.summary, option.runtimeId ?? ""], query)),
		[view.options, query],
	);
	const pick = (option: ProviderOption) => send(selectAnswer(view.prompt, option.choice));
	const first = view.options.find((option) => option.choice.id === view.prompt.initial) ?? view.options[0];
	return (
		<Step title="Which provider or app do you use?" wide lede={<p>Choose one. You can add more later in Settings.</p>}>
			{view.searchable ? (
				<div className="wizard-search">
					<Icon name="search" />
					<input
						type="search"
						data-autofocus
						aria-label="Find a provider"
						placeholder="Find a provider"
						autoComplete="off"
						spellCheck={false}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								const target = shown[0];
								if (target && !busy) pick(target);
							} else if (event.key === "ArrowDown") {
								event.preventDefault();
								event.currentTarget.closest("section")?.querySelector<HTMLElement>("[data-tile]")?.focus();
							}
						}}
					/>
					<span className="sr-only" role="status">
						{shown.length} {shown.length === 1 ? "provider" : "providers"} shown
					</span>
				</div>
			) : null}
			<ul className="wizard-tiles" onKeyDown={arrowNavigation}>
				{shown.map((option) => (
					<li key={option.choice.id}>
						<button
							type="button"
							className="wizard-tile"
							data-tile
							{...(!view.searchable && option === first ? { "data-autofocus": true } : {})}
							disabled={busy}
							title={option.runtimeId ? `Runtime ${option.runtimeId}` : undefined}
							onClick={() => pick(option)}
						>
							<span className="wizard-tile__mark" aria-hidden="true">
								{option.monogram}
							</span>
							<span className="wizard-tile__text">
								<strong>{option.label}</strong>
								{option.summary ? <small>{option.summary}</small> : null}
							</span>
						</button>
					</li>
				))}
			</ul>
			{shown.length === 0 ? (
				<p className="wizard-empty">Nothing matches “{query}”. Clear the search to see them all.</p>
			) : null}
		</Step>
	);
}

// ---- connect -----------------------------------------------------------------------------------

export function SignInStep({ view, busy, send }: StepProps<Of<"signin">>) {
	return (
		<Step
			title={`Sign in to ${view.provider}`}
			lede={
				<p>
					Clio opens your browser so you can sign in there. The Clio command-line tool stores the result, and this page never
					sees it.
				</p>
			}
			actions={
				<>
					{view.connect ? (
						<button
							type="button"
							className="primary wizard-button"
							data-autofocus
							disabled={busy}
							onClick={() => view.connect && send(selectAnswer(view.prompt, view.connect))}
						>
							Connect now
						</button>
					) : null}
					{view.later ? (
						<button
							type="button"
							className="wizard-quiet"
							disabled={busy}
							onClick={() => view.later && send(selectAnswer(view.prompt, view.later))}
						>
							Later
						</button>
					) : null}
				</>
			}
		>
			<dl className="wizard-facts">
				<div>
					<dt>Saved sign-in</dt>
					<dd>{view.status || "none"}</dd>
				</div>
			</dl>
			{view.later?.hint ? <p className="wizard-hint">Later: {view.later.hint}.</p> : null}
		</Step>
	);
}

const SOURCE_NOTES: Readonly<Record<string, string>> = {
	stored: "Recommended. Paste it once and Clio remembers it.",
	env: "For managed machines. Clio reads the variable each time and writes nothing.",
	keep: "Use the key that is already saved.",
	skip: "Only for servers that accept requests without a key.",
};

export function CredentialSourceStep({ view, busy, send }: StepProps<Of<"credential-source">>) {
	const preferred = view.options[view.prompt.initial] ?? view.options.find((option) => option.source === "stored");
	const [picked, setPicked] = useState<Choice | undefined>(preferred?.choice);
	const name = useId();
	const option = (entry: CredentialOption) => (
		<li key={entry.choice.id}>
			<label className="wizard-option" data-checked={picked?.id === entry.choice.id}>
				<input
					type="radio"
					name={name}
					checked={picked?.id === entry.choice.id}
					{...(picked?.id === entry.choice.id ? { "data-autofocus": true } : {})}
					onChange={() => setPicked(entry.choice)}
				/>
				<span>
					<strong>{entry.label}</strong>
					<small>{(entry.source && SOURCE_NOTES[entry.source]) || entry.hint}</small>
				</span>
			</label>
		</li>
	);
	return (
		<Step
			title="How should Clio get the API key?"
			lede={view.status ? <p>Currently: {view.status}.</p> : undefined}
			actions={
				<button
					type="button"
					className="primary wizard-button"
					disabled={busy || !picked}
					onClick={() => picked && send(selectAnswer(view.prompt, picked))}
				>
					Continue
				</button>
			}
		>
			<ul className="wizard-options">{view.options.map(option)}</ul>
		</Step>
	);
}

export function CredentialKeyStep({ view, busy, problem, send }: StepProps<Of<"credential-key">>) {
	const [value, setValue] = useState("");
	const [shown, setShown] = useState(false);
	const field = useId();
	const submit = () => {
		if (busy || value === "") return;
		send(textAnswer(view.prompt, value));
		// The key has been handed to the CLI. Nothing here keeps it.
		setValue("");
		setShown(false);
	};
	return (
		<Step
			title="Paste the API key"
			lede={
				<p>
					The Clio command-line tool stores the key in <code>credentials.yaml</code> with file mode 0600. It is not
					encrypted, and this page never keeps it.
				</p>
			}
			actions={
				<button type="button" className="primary wizard-button" disabled={busy || value === ""} onClick={submit}>
					Continue
				</button>
			}
		>
			<form
				className="wizard-field"
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<label htmlFor={field}>API key</label>
				<div className="wizard-field__row">
					<input
						id={field}
						data-autofocus
						type={shown ? "text" : "password"}
						autoComplete="off"
						autoCapitalize="off"
						spellCheck={false}
						maxLength={4096}
						value={value}
						disabled={busy}
						onChange={(event) => setValue(event.target.value)}
						aria-describedby={`${field}-hint`}
					/>
					<button type="button" className="wizard-quiet" aria-pressed={shown} onClick={() => setShown((on) => !on)}>
						{shown ? "Hide" : "Show"}
					</button>
				</div>
				<p id={`${field}-hint`} className="wizard-hint">
					{view.prompt.hint || "Stored by the Clio CLI only."}
				</p>
				<Problem text={problem} />
			</form>
		</Step>
	);
}

export function TextStep({
	view,
	busy,
	problem,
	send,
	title,
	lede,
	label,
	placeholder,
	submitLabel,
	mono = false,
}: StepProps<Of<"credential-env" | "server" | "model-manual" | "oauth-code" | "generic">> & {
	title: string;
	lede?: ReactNode;
	label: string;
	placeholder?: string;
	submitLabel: string;
	mono?: boolean;
}) {
	const prompt = view.kind === "generic" ? view.prompt : view.prompt;
	const text = prompt.kind === "text" ? prompt : null;
	const [value, setValue] = useState(text?.initial ?? "");
	const field = useId();
	if (!text) return null;
	const submit = () => {
		if (busy || (value === "" && text.initial === "")) return;
		send(textAnswer(text, value));
		if (text.mask) setValue("");
	};
	return (
		<Step
			title={title}
			lede={lede}
			actions={
				<button type="button" className="primary wizard-button" disabled={busy} onClick={submit}>
					{submitLabel}
				</button>
			}
		>
			<form
				className="wizard-field"
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<label htmlFor={field}>{label}</label>
				<input
					id={field}
					data-autofocus
					className={mono ? "wizard-mono" : undefined}
					type={text.mask ? "password" : "text"}
					autoComplete="off"
					autoCapitalize="off"
					spellCheck={false}
					maxLength={4096}
					placeholder={placeholder}
					value={value}
					disabled={busy}
					onChange={(event) => setValue(event.target.value)}
					aria-describedby={text.hint ? `${field}-hint` : undefined}
				/>
				{text.hint ? (
					<p id={`${field}-hint`} className="wizard-hint">
						{text.hint}
					</p>
				) : null}
				<Problem text={problem} />
			</form>
		</Step>
	);
}

export function DetectedStep({ view, busy, send }: StepProps<Of<"detected">>) {
	return (
		<Step title={`That address is serving ${view.served}.`} lede={<p>Clio can talk to it either way.</p>}>
			<ul className="wizard-options">
				{view.options.map((choice, index) => (
					<li key={choice.id}>
						<button
							type="button"
							className="wizard-card"
							data-tile
							{...(index === 0 ? { "data-autofocus": true } : {})}
							disabled={busy}
							onClick={() => send(selectAnswer(view.prompt, choice))}
						>
							<span className="wizard-card__text">
								<strong>{choice.label}</strong>
								<small>{choice.hint}</small>
							</span>
							<Icon name="chevronRight" />
						</button>
					</li>
				))}
			</ul>
		</Step>
	);
}

export function LoginMethodStep({ view, busy, send }: StepProps<Of<"login-method">>) {
	return (
		<Step
			title={`How do you want to sign in to ${view.provider}?`}
			lede={<p>Browser login opens a page on this machine. Device code is for a machine with no browser.</p>}
		>
			<ul className="wizard-options">
				{view.options.map((choice, index) => (
					<li key={choice.id}>
						<button
							type="button"
							className="wizard-card"
							data-tile
							{...(index === view.prompt.initial ? { "data-autofocus": true } : {})}
							disabled={busy}
							onClick={() => send(selectAnswer(view.prompt, choice))}
						>
							<span className="wizard-card__text">
								<strong>{choice.label.replace(/\s*\(default\)$/u, "")}</strong>
								{choice.hint ? (
									<small>{choice.hint}</small>
								) : /\(default\)/u.test(choice.label) ? (
									<small>Recommended</small>
								) : null}
							</span>
							<Icon name="chevronRight" />
						</button>
					</li>
				))}
			</ul>
		</Step>
	);
}

// ---- model -------------------------------------------------------------------------------------

export function ModelStep({ view, busy, send }: StepProps<Of<"model">>) {
	const [query, setQuery] = useState("");
	const start = startingModel(view.models, view.prompt.initial);
	const [picked, setPicked] = useState<number | undefined>(start?.choice.id);
	const name = useId();
	const shown = useMemo(
		() => view.models.filter((model) => matches([model.id, model.name ?? "", model.note ?? ""], query)),
		[view.models, query],
	);
	const current = view.models.find((model) => model.choice.id === picked);
	return (
		<Step
			title="Which model?"
			wide
			lede={
				<p>{sentence(view.note ?? "read live from the connection just now")} Clio starts on the one marked default.</p>
			}
			actions={
				<button
					type="button"
					className="primary wizard-button"
					disabled={busy || !current}
					onClick={() => current && send(selectAnswer(view.prompt, current.choice))}
				>
					{current ? `Use ${current.id}` : "Choose a model"}
				</button>
			}
		>
			{view.searchable ? (
				<div className="wizard-search">
					<Icon name="search" />
					<input
						type="search"
						aria-label="Find a model"
						placeholder="Find a model"
						autoComplete="off"
						spellCheck={false}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<span className="sr-only" role="status">
						{shown.length} {shown.length === 1 ? "model" : "models"} shown
					</span>
				</div>
			) : null}
			<ul className="wizard-options wizard-options--scroll">
				{shown.map((model) => (
					<li key={model.choice.id}>
						<label className="wizard-option" data-checked={picked === model.choice.id}>
							<input
								type="radio"
								name={name}
								checked={picked === model.choice.id}
								{...(!view.searchable && picked === model.choice.id ? { "data-autofocus": true } : {})}
								onChange={() => setPicked(model.choice.id)}
							/>
							<span>
								<strong className="wizard-mono">{model.id}</strong>
								{model.name ? <small>{model.name}</small> : null}
							</span>
							{model.note ? <em className="wizard-badge">{model.note}</em> : null}
						</label>
					</li>
				))}
			</ul>
			{shown.length === 0 ? <p className="wizard-empty">No model matches “{query}”.</p> : null}
		</Step>
	);
}

export function ModelMissingStep({ view, busy, send }: StepProps<Of<"model-missing">>) {
	const run = (choice: Choice | null) => choice && send(selectAnswer(view.prompt, choice));
	return (
		<Step
			title="Clio could not read a model list."
			lede={<p>{view.reason ?? "Start the app or server and load a model, then check again."}</p>}
			actions={
				<>
					{view.retry ? (
						<button
							type="button"
							className="primary wizard-button"
							data-autofocus
							disabled={busy}
							onClick={() => run(view.retry)}
						>
							Check again
						</button>
					) : null}
					{view.key ? (
						<button type="button" className="wizard-quiet" disabled={busy} onClick={() => run(view.key)}>
							This server needs an API key
						</button>
					) : null}
					{view.change ? (
						<button type="button" className="wizard-quiet" disabled={busy} onClick={() => run(view.change)}>
							Change the connection
						</button>
					) : null}
					{view.manual ? (
						<button type="button" className="wizard-quiet" disabled={busy} onClick={() => run(view.manual)}>
							Enter a model ID myself
						</button>
					) : null}
				</>
			}
		/>
	);
}

// ---- review ------------------------------------------------------------------------------------

/** Rows appear one at a time so the result reads as a check being run. Reduced motion shows them all at once. */
function useReveal(count: number): number {
	const [shown, setShown] = useState(0);
	useEffect(() => {
		if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) {
			setShown(count);
			return;
		}
		if (shown >= count) return;
		const timer = setTimeout(() => setShown((value) => value + 1), 420);
		return () => clearTimeout(timer);
	}, [shown, count]);
	return shown;
}

function FactRow({ fact }: { fact: ReviewFact }) {
	return (
		<li className="wizard-check" data-tone={fact.tone}>
			<span className="wizard-check__mark" aria-hidden="true">
				{fact.tone === "ok" ? <Icon name="check" /> : fact.tone === "warn" ? "!" : "·"}
			</span>
			<span className="wizard-check__body">
				<span className="wizard-check__label">{fact.label}</span>
				<span className="wizard-check__text">{fact.text}</span>
			</span>
			<span className="sr-only">{fact.tone === "ok" ? "verified" : fact.tone === "warn" ? "not verified" : ""}</span>
		</li>
	);
}

export function ReviewStep({ view, busy, send }: StepProps<Of<"review">>) {
	const shown = useReveal(view.facts.length);
	const done = shown >= view.facts.length;
	return (
		<Step
			title="Review what Clio could verify."
			lede={
				<p>
					These are the checks Clio ran while you set this up. None of them sends a prompt, and nothing is saved until you
					save.
				</p>
			}
			actions={
				<>
					{view.save ? (
						<button
							type="button"
							className="primary wizard-button"
							data-autofocus
							disabled={busy}
							onClick={() => view.save && send(selectAnswer(view.prompt, view.save))}
						>
							Save and continue
						</button>
					) : null}
					{view.details ? (
						<button
							type="button"
							className="wizard-quiet"
							disabled={busy}
							onClick={() => view.details && send(selectAnswer(view.prompt, view.details))}
						>
							Connection and machine details
						</button>
					) : null}
				</>
			}
		>
			<ul className="wizard-checks" aria-label="What Clio could verify">
				{view.facts.slice(0, shown).map((fact) => (
					<FactRow key={fact.key} fact={fact} />
				))}
			</ul>
			<p className="wizard-verdict" data-tone={view.verified ? "ok" : "warn"} role="status" hidden={!done}>
				{view.verified
					? "Everything Clio can check without sending a prompt checks out."
					: "Some checks could not run. You can still save, and fix the connection later in Settings."}
			</p>
			{view.notes.length > 0 ? (
				<ul className="wizard-notes">
					{view.notes.map((note) => (
						<li key={note}>{note}</li>
					))}
				</ul>
			) : null}
		</Step>
	);
}

export function DetailsStep({ view, busy, send }: StepProps<Of<"details">>) {
	return (
		<Step
			title={view.title}
			actions={
				<>
					{view.next ? (
						<button
							type="button"
							className="primary wizard-button"
							data-autofocus
							disabled={busy}
							onClick={() => view.next && send(selectAnswer(view.prompt, view.next))}
						>
							{view.next.label}
						</button>
					) : null}
					{view.previous && view.previous.id !== view.next?.id ? (
						<button
							type="button"
							className="wizard-quiet"
							disabled={busy}
							onClick={() => view.previous && send(selectAnswer(view.prompt, view.previous))}
						>
							{view.previous.label}
						</button>
					) : null}
				</>
			}
		>
			<ul className="wizard-notes">
				{view.lines.map((line) => (
					<li key={line}>{line}</li>
				))}
			</ul>
		</Step>
	);
}

// ---- anything else -----------------------------------------------------------------------------

/** A prompt this build does not know. It stays answerable: the CLI's own words, one button per choice. */
export function GenericStep({ view, busy, problem, send }: StepProps<Of<"generic">>) {
	const prompt = view.prompt;
	if (prompt.kind === "text")
		return (
			<TextStep
				view={view}
				busy={busy}
				problem={problem}
				send={send}
				title={prompt.heading[0] || "Continue setup"}
				lede={prompt.heading.slice(1).map((line) => <p key={line}>{line}</p>)}
				label="Your answer"
				submitLabel="Continue"
			/>
		);
	return (
		<Step
			title={prompt.heading[0] || "Continue setup"}
			lede={prompt.heading.slice(1).map((line) => <p key={line}>{line}</p>)}
		>
			<ul className="wizard-options">
				{prompt.choices.map((choice, index) => (
					<li key={choice.id}>
						<button
							type="button"
							className="wizard-card"
							data-tile
							{...(index === prompt.initial ? { "data-autofocus": true } : {})}
							disabled={busy}
							onClick={() => send(selectAnswer(prompt, choice))}
						>
							<span className="wizard-card__text">
								<strong>{choice.label}</strong>
								{choice.hint ? <small>{choice.hint}</small> : null}
							</span>
							<Icon name="chevronRight" />
						</button>
					</li>
				))}
			</ul>
			<Problem text={problem} />
		</Step>
	);
}

/** Back goes one step in the CLI's own order. On the first step the wizard decides what back means. */
export const back = backAnswer;
