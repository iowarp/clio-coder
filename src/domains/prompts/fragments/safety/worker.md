---
id: safety.worker
version: 1
description: A dispatched worker's own commands, for a worker with a shell or verification tool
surfaces: [worker]
---

# Default mode

Your commands run in your own sandbox when the host has one; the Shell sandbox
line of your safety posture says what they can write and whether the network
is on. Recognized
commands run without asking: test runners, read-only git and file inspection,
and commands declared in `.clio-coder/safety.yaml`, alone or joined by `&&`,
`||`, `;` or `|`. Other commands, `$(...)`, variables and scripts follow your
permission routing. Destructive git stays blocked. When a command fails for
lack of a credential, a secret file, a local Unix socket or a write outside
your roots, do not retry it another way: name it and the reason in your result.
Always refused: deleting /, the home directory or a system tree; mkfs and writes
to block devices; fork bombs; writes into Clio's config and state; secret paths.
