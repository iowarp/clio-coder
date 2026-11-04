# Information flow

Keep named files away from destinations you did not choose.

## What it does

Information flow keeps named content, such as files under `secrets/`, away from destinations you did not choose. A source rule labels content when a session observes it, and the restrictions are checked before bytes leave for a model or a mediated outbound tool. It does nothing until a project declares rules and you approve them.

This controls where observed content may go. The safety model still decides whether a read or tool call may run.

## Declare and approve

Put `informationFlow` in the project's `.clio-coder/safety.yaml`, with each source naming its paths or tools and its allowed recipients. Then review and approve those exact bytes:

```sh
clio-coder config trust safety
clio-coder config trust safety --hash <reviewed-sha256>
clio-coder config trust safety --revoke
```

Restart Clio Coder after approving. An unapproved edit can only forbid more.

Recipients can be a pinned model target, an exact endpoint, an origin, a pinned MCP server, or a named group. Follow [the tutorial](/tutorials/information-flow-rules.html) for a complete worked policy.
