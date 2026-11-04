# core

2 complete, 0 pending.

- [Command-line sandboxing for shell commands and worker processes](sandbox.md) — How Clio contains bash, run_script and worker child processes in an OS sandbox, which environment variables and secret files they lose, and how availability and policy are decided. Read this when a sandboxed command is refused, masked or unexpectedly unwritable.
- [Telemetry event hub, producer and call lifecycle](telemetry.md) — How the core telemetry layer emits events, routes journal records to their owning sink, and tracks provider calls from start to settlement. Read this before adding an event, changing where a record is written, or touching call settlement.
