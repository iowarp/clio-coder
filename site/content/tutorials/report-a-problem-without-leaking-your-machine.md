When CLIO Coder itself misbehaves, `/report` in a session and `clio-coder report` in a shell draft a bug report, a feature request or a question for its maintainers. You read the exact text before anything leaves your machine, with your paths, names and keys masked, and CLIO Coder never sends a report on its own. This tutorial previews a report and never sends one.

::: note Version scope
This tutorial describes v0.8.0. The output below is from CLIO Coder run with `--dry-run` against a fresh CLIO Coder home and a small Git repository that had one finished session. Nothing was sent or saved.
:::

::: needs
- CLIO Coder installed.
- A folder where you have run at least one session, for `--last`.
- To send for real: the GitHub CLI `gh`, signed in. Without it you can still open or write the report.
:::

## Draft a report

In a session, `/report bug footer flickers on resize` uses the summary as the title and adds what CLIO Coder observed in the current session. `/report feature` and `/report question` work the same way. From a shell, `--title` and `--body-file` supply the text, and `--last` adds the newest session in this folder:

```sh
clio-coder report bug --title "footer flickers on resize" --body-file notes.txt --last --dry-run
```

Without `--body-file`, a terminal opens `$EDITOR` on a template. `--session <id>` names another session. The note in this run named the machine and the project folder on purpose.

## Read what would be posted

The preview opens with where the report would go, then the body exactly as it would be sent:

```text
Public, posted from your gh account to github.com/iowarp/clio-coder; nothing sent yet

----- title -----

fix: footer flickers on resize

----- body, exactly as it will be sent -----
### What happened

The footer flickers when I resize the terminal on <host>.
Repro: open clio-coder in <path> and drag the window edge.
```

The host name and the folder were masked before the preview was shown. Below the body come an environment block (version, platform, Node, install kind and model) and a report block with an id. The preview ends with what was masked and what sending would do:

```text
Masked by Clio: 1 path, 1 host name. No secrets recognized.
No diagnostic bundle is attached.

Sending will, in this order:
  1. search iowarp/clio-coder for an existing report of the same problem
  2. post the text you reviewed as a public issue from your gh account
dry run: nothing sent
```

The masks cover local paths, URLs other than CLIO Coder's own, user, host, project, branch, remote and target names, e-mail and IP addresses, and secrets, including the API keys the process holds. The review then searches the text again for this machine's names, and refuses to send while one slipped past or the text holds hidden characters.

In the session, `e` edits the text in `$EDITOR` and masks the edit again, `m` masks or unmasks one value, Enter moves to the next step and Esc closes the review and keeps a draft.

## Choose how it leaves

What happens at the end depends on what the machine has:

- **Send.** With a signed-in `gh`, CLIO Coder searches GitHub for the same problem, then posts a public issue, or a discussion for a question, under your account. In a session only `s` on the send step sends, never Enter. In a shell you choose send at the prompt, or pass `--yes`.
- **Open.** Without `gh`, it opens a prefilled form in your browser, and you submit it there.
- **Write.** Without a browser, it writes the report to a file and prints the link to paste it into.
- **Preview.** `--dry-run` stops after the preview, with no network call.

The shell prompt can also save a draft for `clio-coder report send <id>` later. When the search finds an open report of the same problem, you choose to add your details to it, file a new issue that links it, or cancel. With `--yes`, `--on-duplicate stop` is the default: the draft is saved and the command exits 3.

## Attach a diagnostic bundle only if you want to

A bundle is opt-in and built only from a shell: add `--bundle mechanics --consent debug` with `--last` or `--session <id>`. Its preview lists what it keeps and what it never keeps:

```text
Never kept:
  - Prompts, model text, thinking, tool arguments and output, unless the transcript is ticked.
  - File contents, diffs, commit messages.
  - Absolute or relative paths, repository names and remotes, branch names.
  - Host and user names, endpoint URLs, target ids, agent, rule and hook names, environment variables.
  - Anything a schema does not bound.
```

`--transcript [N]` adds the last turns, scrubbed. `debug` lets the maintainers read the bundle to fix this report, and `dataset` also lets its mechanics go into public datasets. `clio-coder report selftest` builds the same bundle in memory and writes nothing. Here it printed `0 identifiers found in 11370 bytes`, and it exits 1 when an identifier survives.

Without `--share`, the bundle stays on your machine and the issue never carries it. `/report` in a session, over ACP or in the desktop app attaches no bundle.

## Share it encrypted, in your own account

`--share` encrypts the bundle so that only the maintainers' key opens it, and uploads it as a secret gist in your own GitHub account through your `gh`. The issue names the gist.

The preview in this run showed the pointer it would carry, `bundle: gist:<created on send>#shr_2784226036f4c9e7`: the gist is created only when you send, and deleted again if posting fails. Without a signed-in `gh`, the bundle is sealed to a `.box` file you attach by hand.

## Forget it later

`clio-coder report status` lists your reports and drafts, and `clio-coder report forget <id>` deletes a draft you never posted. A posted report cannot be withdrawn from CLIO Coder; edit or close it on GitHub. For a shared report, `forget` deletes the gist first, then offers a one-line comment asking the maintainers to delete their copy, posted only if you confirm.

Once a share is 180 days old, CLIO Coder deletes its gist the next time you run `clio-coder report` or `clio-coder telemetry share`. Nothing runs at startup or in the background. Your local copy of a sent report's bundle is deleted after 30 days.

::: result Exit codes
`clio-coder report` exits 0 when the report was sent, opened in the browser, written or previewed; 1 when sending failed or a bundle was refused; 2 on a usage error, or outside a terminal without `--yes`; and 3 when a likely duplicate or a newer release stopped it and the draft was saved.
:::

::: limits
- The masks cover the names CLIO Coder knows about this machine. Text you typed about another machine can pass, so read the preview.
- A sent report is a public GitHub issue or discussion. Security problems never go there: `/report security` prints the link to the private advisory form.
- The agent can save a draft, but never send one or share a bundle. Only your own review sends.
:::

::: next
- [Report a problem to the maintainers](/docs/guide/troubleshooting.html#report-a-problem-to-the-maintainers)
- [See what a session cost and what a run did](/tutorials/see-what-a-session-cost-and-what-a-run-did.html)
- [Automate with clio-coder run](/docs/guide/exit-codes-and-output.html)
:::
