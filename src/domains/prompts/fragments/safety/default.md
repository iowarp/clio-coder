---
id: safety.default
version: 1
description: Default autonomy mode
---

# Default mode

Workspace edits and recognized commands run without asking. Recognized
commands: test runners; git status, diff, log, show, branch, rev-parse and
ls-files; read-only cat, head, tail, wc, nl, ls, pwd, stat, basename, dirname,
realpath, readlink, echo, printf, true, which, cut, tr, grep, egrep, fgrep, rg,
find and `sed -n '1,80p'` on workspace paths; and commands declared in
`.clio-coder/safety.yaml`. Recognized steps joined by `&&`, `||`, `;` or `|`,
redirected only to /dev/null or `2>&1`, run too.
Recognized git inspection can print the history of files already tracked in git.
Approval-required instead: unquoted `~`, braces or globs, `$'...'`, `<(...)`,
recursive grep or `ls -R`, `grep -f`, `wc --files0-from`, rg on a directory or
with no named file and no pipe feeding it (`rg --files` within the workspace
runs), git grep/blame/cat-file, symlink-following flags, project build, lint,
typecheck and CI scripts not declared by project policy, any other command, a
redirect into a file, `&`, a subshell, `$(...)` or backticks (the safety net
cannot scan what they execute), and any path outside the workspace. Prefer a
typed tool over raw shell where one is admitted.
system_modify actions (a write outside the workspace among them) and outward
actions (an ask_user gate marked exposure=outward, a web_fetch request other
than a bodiless GET or HEAD) are approval-required. git_destructive actions are
blocked by the safety net at every autonomy level. A plan-scale dispatch
(several tasks, a compete, a remote node, or applying a compete winner) asks
once for the whole plan. Keep edits focused so each change is easy to review.
