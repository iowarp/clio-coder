import { useId, useState } from "react";
import { originFromLaunchInput, ticketFromLaunchInput, tokenFromLaunchInput } from "../api/auth-state.js";
import { adoptLaunchSecret } from "../api/token.js";

/**
 * Shown when this browser has no launch token or the server refused the one it had. A refused token
 * never starts working again, so this names the command that prints a fresh link and accepts one.
 */
export function Reconnect({ refused }: { refused: boolean }) {
	const field = useId();
	const [text, setText] = useState("");
	const ticket = ticketFromLaunchInput(text);
	const token = ticket === null ? tokenFromLaunchInput(text) : null;
	const secret = ticket !== null ? { ticket } : token !== null ? { token } : null;
	return (
		<div className="reconnect" role="alert">
			<h1>{refused ? "This browser is no longer connected" : "Open your launch link"}</h1>
			<p>
				{refused
					? "The server refused this browser's launch link. That happens when the server restarted with a new token, or the app was reinstalled. Nothing is wrong with your data, and the old token has been removed from this browser."
					: "This browser has no launch link yet."}
			</p>
			<p>
				Run <code className="reconnect__command">clio-coder gui</code> in a terminal. It reopens the background app when one
				is installed, or starts a new server, and opens a fresh link. You can also paste the printed link here.
			</p>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (secret) adoptLaunchSecret(secret, originFromLaunchInput(text) ?? location.origin);
				}}
			>
				<label htmlFor={field}>Launch link</label>
				<input
					id={field}
					value={text}
					autoComplete="off"
					spellCheck={false}
					placeholder="http://127.0.0.1:4343/#ticket=…"
					onChange={(event) => setText(event.target.value)}
				/>
				{text.trim() !== "" && !secret && <p className="reconnect__problem">That text is not a launch link.</p>}
				<div className="actions">
					<button type="submit" className="primary" disabled={!secret}>
						Connect this browser
					</button>
				</div>
			</form>
		</div>
	);
}
