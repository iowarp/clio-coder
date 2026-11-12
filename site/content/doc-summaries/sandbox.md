## Check your machine first

Run `clio-coder doctor` and read the `shell sandbox` row. `OK` means shell commands run inside an OS sandbox: bubblewrap on Linux and WSL, `sandbox-exec` on macOS (not yet verified on a real Mac). `WARN` means they run uncontained, so more of them ask first. Windows has no sandbox.

Then work at the `default` level. In your request, name anything that reaches beyond the project, such as "push the branch when the tests pass".

## What a sandboxed command may do

A sandboxed command can read your files and use the network. It writes only to the project, the temp directories, any directory in `safety.scratchRoots`, a private tool cache and the repository's Git data. Git hooks and Git config stay read-only, because they run later outside the sandbox.

## What the sandbox hides

The command cannot read SSH and GPG keys, the SSH agent, cloud and cluster logins, code-host and registry tokens, password stores, browser profiles, shell histories or other agents' logins. Secret files in the project, such as `.env` and `*.key`, are hidden too. Variables whose names or values look like credentials are removed. List one a build needs in `safety.sandboxPassEnv`.

## Commands that leave the sandbox

`git push`, `gh`, cloud CLIs, `ssh`, publishing commands and the Slurm, PBS, LSF and Flux clients need your credentials, so they run outside the sandbox. At `default` the safety judge reviews each one against your own messages first, and you are asked when it has no verdict. Contained yolo runs one only when your message names it.

## Stricter or looser

`safety.sandbox` is `auto` by default. `required` refuses workers' commands on a machine without a sandbox and keeps unconfined yolo sandboxed; `srun`, `salloc` and `flux` then stay inside it. `off` never sandboxes. Unconfined yolo, for containers only, runs commands as you with your credentials.

## Project configuration and /trust

A repository's own CLIO Coder settings, safety rules, hooks and packages are ignored until you approve their exact contents. A card lists them when you open the project, and `/trust` reopens it. Even approved, project settings can only make CLIO Coder more careful: they cannot raise the autonomy level, loosen the sandbox, raise limits or carry credentials.
