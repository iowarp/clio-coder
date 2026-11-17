import { parseRunCliArgs } from "./args.js";

export const RUN_USAGE =
	'usage: clio-coder run [--cwd <dir>] [--target <id>] [--model <wireId>] [--thinking <level>] [--autonomy <level>] [--systemone <engine|off>] [--read-only] [--record] [--json] [--json-events full|terminal] [--session <id>|--continue] [--fail-on-noop] [--timeout <seconds>] [--verify "<cmd>" [--verify-timeout <seconds>]] [--max-cost-usd <N>] [--answers <file.yaml>] [--agent <recipe-id>] [--] "<task>"\n';

export const RUN_HELP = `clio-coder run [flags] [--] "<task>"

Run one headless main-agent turn. Fleet dispatch is explicit with --agent.
Everything after "--" is the task text, even when it starts with "-" or "@".

Flags:
  --cwd <dir>               run as if started in <dir>; applies to --agent too
  --target <id>             one-run main-agent or dispatch target override
  --model <wireId>          one-run model override
  --thinking <level>        one-run thinking level: off|minimal|low|medium|high|xhigh|max
  --autonomy <level>        main-agent autonomy: default|yolo
  --systemone <engine|off>  System One for this run: jev, memory, main, an engine, a target, or off
  --read-only               deny every write, command, and delegation; with --agent, the dispatch is read-only
  --record                  save a bounded redacted display asciicast for --agent dispatch
  --turn-mode <mode>        main-agent workflow: answer|proposal|change; not an authorization grant
  --allow-tools <names>     main-agent capability allowlist, comma-separated; none disables all tools
  --no-delegate             forbid main-agent dispatch for this task and its continuations
  --delegate-tools <names>  tools dispatched workers may hold, independent of --allow-tools; none gives workers no tools
  --temperature <N>         one-run sampler override for supported local/OpenAI-compatible runtimes
  --top-p <N>               one-run nucleus sampling override (0..1)
  --top-k <N>               one-run top-k override
  --min-p <N>               one-run min-p override (0..1)
  --presence-penalty <N>    one-run presence penalty override
  --frequency-penalty <N>   one-run frequency penalty override
  --repeat-penalty <N>      one-run repeat penalty override
  --max-context-tokens <N>  cap this run's context budget without enlarging the server window
  --json                    stream JSONL frames, one JSON object per line; the first is a "session" header
                            carrying schemaVersion; the last is {"type":"run_end",...} with the run's exitCode
                            and outcome, or with --agent {"type":"result",...}
  --json-events <mode>      full: progress and final answer in turn_end.message.content
                            terminal: accounting and final answer in turn_end.text
                            implies --json; refused with --agent
  --steer-channel <path>    read live steering lines from a FIFO or appended regular file
  --session <id>            append this turn to an existing session
  --continue                append this turn to the most recent session for this cwd; after a yolo
                            autonomous-cap (exit 4) or judge-streak (exit 3) stop it resumes with a fresh window
  --fail-on-noop            also exit 1 when tools ran and none succeeded; a text-only answer or an answer/proposal
                            turn is not a no-op (see below)
  --timeout <seconds>       wall-clock limit for the whole run; exit 124 on expiry
  --verify "<cmd>"          an acceptance check for this run only, repeatable: bash runs it in the run's cwd after
                            the turn, and the finish gate counts the agent's own run of it (see below)
  --verify-timeout <secs>   limit for each --verify check (default 300); a check that runs over fails
  --max-cost-usd <N>        priced spend this run may add: main agent, compaction and dispatched workers are each
                            admitted only while under it, and running workers are stopped when it is reached; exit 4
                            when it stops the run. Spend can pass it by the model calls already in flight then: one per
                            running worker plus the main agent's. Unpriced routes are not bounded; stderr names each
                            configured one: chat, compaction, fleet default, fleet profiles (which recipe pins name),
                            roster members and every target at its default model. A model the main agent names for one
                            dispatch is not checked
  --answers <file.yaml>     answer the questions only the author may answer (extension interviews, operator_only
                            ask_user questions) from this file; an unanswered one ends the run with exit 5 (see below)
  --agent <recipe-id>       dispatch a fleet agent instead of the main agent
  --agent-profile <name>    named fleet profile for dispatch
  --agent-runtime <id>      pick the first fleet profile whose target uses this runtime
  --tool-profile <name>     restrict dispatched-agent tools: minimal-local|science-local|full-agent
  --require <capability>    capability the dispatch target must advertise (repeatable)
  --skill <path>            make one explicit skill available for this run, repeatable
  --no-skills               disable skill discovery while still honoring --skill

--cwd enters <dir> before anything reads the working directory: settings
layers, context files, skills, @file references, the session ledger, and every
tool path. A run started with --cwd <dir> behaves as if it had been started in
<dir>, so relative paths in other arguments resolve there too. A directory the
process cannot enter is a usage error (exit 2) and no model is called.
CLIO_CODER_HOME, CLIO_CODER_CONFIG_DIR, CLIO_CODER_DATA_DIR,
CLIO_CODER_STATE_DIR, and CLIO_CODER_CACHE_DIR are not resolved before the
chdir, so a relative value lands under <dir>. Pass absolute paths in them
when using --cwd.

A headless turn starts a fresh session unless --session or --continue names one
to append to. A named session that cannot be resumed fails the run: an answer
written without the history the caller asked for is worse than no answer. The
session id is reported on stderr, and as the "session" event under --json.

--verify declares a check for this run alone, named run-acceptance (then
run-acceptance-2, ...); nothing is written to .clio-coder/verifiers.yaml. The
finish gate treats it like a declared verifier: when the agent changes files
and then runs the command through bash, as a whole && segment, it counts as a
check. After the turn, the run itself runs each check with bash and reports it
as {id, command, exitCode, passed, durationMs, timedOut, ranAfterLastEdit} in
the terminal turn_end's "verify" array, in a {"type":"verify"} frame under
--json-events full, and on stderr in text mode. ranAfterLastEdit says whether
the agent ran the check after its last edit. A failed check does not change
the run's exit code. An interrupted run skips the checks.

There is no operator in a headless run: permission asks are denied, and the
ask_user interview tool is not registered. Skills that interview fall back to
their stated defaults; supply decisions in the task prompt instead.

--answers <file.yaml> scripts the author for this run. It answers only the
questions the author alone may answer: an extension's interview steps (its gate
questions) and ask_user questions the model marks operator_only. The file is a
mapping with one key, answers: a list whose entries each name exactly one rule
(id: an extension question's checkpoint id; header: the question's header,
exactly; match: a regular expression over the question text) and give a choice
(an option label, or a list of labels for a multi-select question), a note
(typed text beside the choice, or the whole answer to a question without
options), or both. With it, ask_user is registered and extension interviews are
asked; the first entry in file order that matches answers each author question
as the operator, and the session records the answer as scripted, naming the
file and the entry. Rules never match the model's ordinary ask_user questions:
such a call is refused as having no operator, as in a run without the file, and
the model goes on from its stated defaults. An author question no entry
matches, or whose matching choice is not offered, is never answered for you:
its round is cancelled as "unscripted", the turn stops, and the run exits 5
with outcome "failed" and outcomeDetail "unscripted", naming the question's
header or id so the file can be extended. Permission asks stay denied. A file
that cannot be read or fails validation is a usage error (exit 2) naming the
file and the offending entry. Main agent only.

The main agent's terminal frame records blocked calls under safety.blockedAttempts
and a noop flag. A run is a no-op when a block remains unresolved and no write
succeeded, or when it ran tools and none succeeded; a run that called no tool
is not. The main agent's own write-class calls count as writes, and so does a
dispatch whose task worktree merged; an artifact report, bash, and other
dispatch work do not. A later successful read or
command can recover a block of the same action class. Native observation does
not certify that a blocked execution or write requirement was fulfilled.
Bookkeeping and reports cannot recover blocks. An unresolved blocked run with no successful write exits 1 with outcome
"failed" and outcomeDetail "noop".
A successful limitation call also fails, with outcomeDetail "limitation".
--fail-on-noop additionally fails runs whose tools all failed without a block.
With --turn-mode answer or proposal the task asked for no change, so it never fails as a no-op, --fail-on-noop
included: blocked or failed calls leave it at exit 0 with its answer, and stderr names any blocked calls in one line.
The flag applies to the main agent only.

--timeout <seconds> bounds the whole run, boot included. On expiry the run
starts the same coordinated shutdown a SIGTERM does: the turn is aborted, a
running bash tool's process group is signaled, and the run is recorded with
outcome "timed_out" before the process exits 124, the code timeout(1) uses. An
external SIGTERM still seals "canceled" with exit 143. A timeout during boot,
before the turn starts, exits 124 with no run recorded. With --agent, expiry
aborts the dispatched worker, which is recorded as "canceled".

With --agent the exit code is the dispatched run's: 0 on success, 2 for a
usage or admission error, 3 when the worker stopped on a refused permission
(outcome "failed" with permission_required detail), 4 when the session cost ceiling ended the
run, and 1 for every other failure.

A turn that ends by writing an artifact (plan/review/report) has no assistant
message after it, because writing the artifact is the answer. Text mode prints
that tool's result line, naming what was written and where; --json carries the
artifact content itself in the event stream.
`;

/**
 * Answer `run --help` without loading the run command's module graph, so leaf help comes back about as fast as the
 * other leaves'. Returns null when the arguments ask for a run.
 */
export function answerRunHelp(args: ReadonlyArray<string>): number | null {
	const parsed = parseRunCliArgs(args);
	if (!parsed.help) return null;
	(parsed.json ? process.stderr : process.stdout).write(RUN_HELP);
	return 0;
}
