# Built-in and custom agents

See the agents you can dispatch and add your own.

## See the agents

Clio Coder dispatches focused agents from Markdown recipes. Each recipe declares the agent's tools, budget, and the result it must return.

```sh
clio-coder agents
clio-coder agents validate
clio-coder run --agent coder "<task>"
```

`clio-coder agents` lists the agents you can run, including `architect`, `coder`, `debugger`, `documenter`, `git-master`, `tester`, and `verifier`. `/run` dispatches one from a session. Add `--read-only` to deny writes, commands, and delegation for one dispatch.

Helper agents such as Scout are dispatched by the main agent, and `clio-coder agents --all` lists them. You cannot start them directly.

## Add your own

Put a recipe at `.clio-coder/agents/<id>.md` for one project, or in the `agents` folder of your Clio Coder config directory for yourself. The file name is the agent's id, and when a user recipe and a project recipe share an id, the project one wins. Run `clio-coder agents validate` after an edit.
