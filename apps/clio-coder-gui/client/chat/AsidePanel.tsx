import { useMutation } from "@tanstack/react-query";
import { memo, useId, useState } from "react";
import { ASIDE_TEXT_MAX_CHARACTERS } from "../../contracts/aside.js";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { StatusMark } from "../design/status.js";
import { CopyButton, MarkdownContent } from "../render/Markdown.js";
import { answerView, asideBlock, draftCounts, draftsView } from "./aside-model.js";
import { fillComposer } from "./Composer.js";
import "./session-board.css";

/**
 * The terminal's /btw and /draft. Both read the conversation as it stands and answer here; nothing
 * they produce becomes a turn, a transcript entry or context the next request carries. A draft reaches
 * the conversation only when the operator puts it in the composer and sends it.
 */
export const AsidePanel = memo(function AsidePanel({
	client,
	sessionId,
	sessionOpen,
	capabilities,
	running,
}: {
	client: Client;
	sessionId: string;
	sessionOpen: boolean;
	capabilities: AgentCapabilities | undefined;
	running: boolean;
}) {
	const capability = capabilities?.aside;
	const block = asideBlock(capability, sessionOpen, running);
	const questionId = useId();
	const requestId = useId();
	const countId = useId();
	const [question, setQuestion] = useState("");
	const [request, setRequest] = useState("");
	const counts = capability ? draftCounts(capability) : null;
	const [count, setCount] = useState<number | null>(null);
	const params = { params: { id: sessionId }, query: {} };
	const ask = useMutation({
		mutationFn: (text: string) =>
			client.call(routes.askAside, { ...params, body: { question: text } }, crypto.randomUUID()),
	});
	const draft = useMutation({
		mutationFn: (body: { request: string; count: number }) =>
			client.call(routes.draftAside, { ...params, body }, crypto.randomUUID()),
	});
	const cancel = useMutation({ mutationFn: () => client.call(routes.cancelAside, { ...params, body: {} }) });
	const busy = ask.isPending || draft.isPending;
	const answer = ask.data ? answerView(ask.data) : null;
	const drafts = draft.data ? draftsView(draft.data) : null;
	const chosen = count ?? counts?.initial ?? 3;
	return (
		<details className="command-panel session-board aside-panel">
			<summary>Ask beside the conversation</summary>
			<p className="session-board__note">
				A side question or a set of drafts reads this conversation and answers here. Nothing either produces is added to the
				conversation, and each is billed like a request.
			</p>
			{block ? <p>{block}</p> : null}
			{capability && sessionOpen ? (
				<>
					<form
						className="aside-panel__form"
						onSubmit={(event) => {
							event.preventDefault();
							if (!block && !busy && question.trim()) ask.mutate(question.trim());
						}}
					>
						<label htmlFor={questionId}>Side question</label>
						<textarea
							id={questionId}
							rows={2}
							maxLength={ASIDE_TEXT_MAX_CHARACTERS}
							value={question}
							onChange={(event) => setQuestion(event.target.value)}
							placeholder="Which file did the report land in?"
						/>
						<span className="session-board__actions">
							<button type="submit" disabled={block !== null || busy || question.trim() === ""}>
								{ask.isPending ? "Asking…" : "Ask"}
							</button>
							{ask.isPending ? (
								<button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
									Stop
								</button>
							) : null}
						</span>
					</form>
					{ask.error ? <p role="alert">{ask.error.message}</p> : null}
					{answer ? (
						<section className="aside-panel__result" aria-label="Side answer">
							<p className="aside-panel__status" role="status">
								<StatusMark tone={answer.tone} label={answer.word} />
								{answer.note}
							</p>
							{answer.text ? (
								<>
									<MarkdownContent source={answer.text} complete />
									<CopyButton text={answer.text} label="Copy answer" />
								</>
							) : null}
						</section>
					) : null}
					<form
						className="aside-panel__form"
						onSubmit={(event) => {
							event.preventDefault();
							if (!block && !busy && request.trim()) draft.mutate({ request: request.trim(), count: chosen });
						}}
					>
						<label htmlFor={requestId}>Request to draft</label>
						<textarea
							id={requestId}
							rows={2}
							maxLength={ASIDE_TEXT_MAX_CHARACTERS}
							value={request}
							onChange={(event) => setRequest(event.target.value)}
							placeholder="How should the report show the readings?"
						/>
						<span className="session-board__actions">
							<label htmlFor={countId}>Drafts</label>
							<select id={countId} value={chosen} onChange={(event) => setCount(Number(event.target.value))}>
								{(counts?.counts ?? [chosen]).map((value) => (
									<option key={value} value={value}>
										{value}
									</option>
								))}
							</select>
							<button type="submit" disabled={block !== null || busy || request.trim() === ""}>
								{draft.isPending ? "Drafting…" : "Draft"}
							</button>
							{draft.isPending ? (
								<button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
									Stop
								</button>
							) : null}
						</span>
					</form>
					{draft.error ? <p role="alert">{draft.error.message}</p> : null}
					{drafts ? (
						<section className="aside-panel__result" aria-label="Drafts">
							<p className="aside-panel__status" role="status">
								{drafts.summary}
							</p>
							<ol className="aside-panel__drafts">
								{drafts.cards.map((card) => (
									<li key={card.label} className={card.picked ? "is-picked" : undefined}>
										<p className="aside-panel__draft-head">
											<strong>Draft {card.label}</strong>
											{card.picked ? <StatusMark tone="success" label="Picked" /> : null}
											{card.share ? <span className="aside-panel__share">{card.share}</span> : null}
											{card.sound ? <span>{card.sound}</span> : null}
										</p>
										{card.text ? (
											<>
												<MarkdownContent source={card.text} complete />
												<span className="session-board__actions">
													<button type="button" onClick={() => card.text && fillComposer(sessionId, card.text)}>
														Put in composer
													</button>
													<CopyButton text={card.text} label={`Copy draft ${card.label}`} />
												</span>
												{card.truncated ? <small>Shortened to fit.</small> : null}
											</>
										) : (
											<p>
												<StatusMark tone="fail" label="Failed" />
												{card.failed}
											</p>
										)}
									</li>
								))}
							</ol>
						</section>
					) : null}
				</>
			) : null}
		</details>
	);
});
