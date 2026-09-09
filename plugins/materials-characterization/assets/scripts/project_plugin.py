#!/usr/bin/env python3
"""Generate a peer host package without claiming equivalent fleet enforcement."""
import argparse
import json
from pathlib import Path
import shutil
import sys


ACTION_ROLES = {
    "identify-research": "research-explorer", "literature-review": "literature-reviewer",
    "define-virtual-lab": "lab-definer", "define-research-tasks": "workflow-planner",
    "execute-task": "task-executor",
}


def render_peer_guides(target, output, name):
    """Bind logical action/skill requests to capabilities actually exported."""
    actions = sorted(path.stem for path in (output / "assets/actions").glob("*.md"))
    invocations = {}
    for action in actions:
        skill = name + "-" + ACTION_ROLES.get(action, "research-explorer")
        invocations[action] = ({"kind": "skill", "name": skill, "request": action}
                               if target == "codex" else {"kind": "command", "name": f"/{name}:{action}"})
    paths = list((output / "assets/actions").glob("*.md")) + list((output / "skills").glob("*/SKILL.md"))
    for path in paths:
        text = path.read_text()
        if target in {"claude", "gemini"}:
            for action in actions:
                skill = name + "-" + ACTION_ROLES.get(action, "research-explorer")
                text = text.replace(f"Run {action} using the {skill} skill", f"/{name}:{action}")
            text = text.replace("this standard package registers no slash commands",
                                "this native package registers the command routes shown below")
            text = text.replace("actual skill invocation vocabulary", "native command vocabulary")
        if path.parent.name == "actions":
            role = ACTION_ROLES.get(path.stem)
            if target == "claude" and role:
                binding = (f"\n## Native role binding\n\nThe interactive orchestrator dispatches the registered agent `{name}:{role}`\n"
                           f"for the `{name}-{role}` scientific skill. After a checkpoint, dispatch that\n"
                           "same registered agent again with the complete transcript, prior outputs and\n"
                           "actual researcher answer. Skill names identify instructions, not agent IDs.\n"
                           "A worker returns the checkpoint and does not dispatch or interview.\n")
                if role == "task-executor":
                    binding += (f"For the separate read-only artifact review, dispatch the registered agent `{name}:task-verifier`.\n"
                                "Give it no write grant and preserve any host grounding limitations.\n")
            elif target in {"codex", "gemini"}:
                binding = ("\n## Host role execution\n\nThis export registers no named agents. Apply the role's installed skill in the\n"
                           "main conversation, or give that skill and complete context to a generic worker\n"
                           "only when the host supports delegation. The interactive assistant owns every\n"
                           "researcher question and resumes the role with the actual answer.\n")
            else:
                binding = ""
            text += binding
        path.write_text(text)
    return invocations


def project(target, output, source=None):
    source = Path(source or Path(__file__).resolve().parents[2]).resolve(strict=True)
    output = Path(output).absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("projection output must not already exist")
    output = output.resolve()
    if source == output or source in output.parents:
        raise ValueError("projection output must be outside the canonical bundle")
    manifest = json.loads((source / "plugin.json").read_text())
    output.mkdir(parents=True)
    try:
        for directory in ("skills", "assets"):
            for path in (source / directory).rglob("*"):
                if path.is_symlink():
                    raise ValueError(f"projection refuses symbolic link: {path}")
            shutil.copytree(source / directory, output / directory,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        metadata = {key: manifest[key] for key in ("name", "version", "description", "author", "repository", "keywords") if key in manifest}
        report = {"target": target, "skills": 6, "commands": 0, "agents": 0,
                  "fleet": "instructions only; no native write-scope enforcement claimed",
                  "scripts": "local Python helpers; no automatic execution",
                  "validation": "generated structure; run target-native validation before publication"}
        report["invocations"] = render_peer_guides(target, output, metadata["name"])
        report["agent_bindings"] = {}
        if target == "codex":
            # Codex recognizes the current portable standard. Do not fabricate a
            # separate proprietary manifest or pretend Clio recipes are native.
            portable = {"$schema": manifest["$schema"], **metadata}
            (output / "plugin.json").write_text(json.dumps(portable, indent=2) + "\n")
        elif target == "claude":
            directory = output / ".claude-plugin"
            directory.mkdir()
            (directory / "plugin.json").write_text(json.dumps(metadata, indent=2) + "\n")
            commands = output / "commands"
            agents = output / "agents"
            commands.mkdir()
            agents.mkdir()
            roles = ACTION_ROLES
            for guide in sorted((output / "assets/actions").glob("*.md")):
                assignment = (f"Delegate this scientific role to the registered agent `{metadata['name']}:{roles[guide.stem]}`.\n"
                              if guide.stem in roles else "This action is owned by the interactive orchestrator.\n")
                text = (f"---\ndescription: Materials characterization {guide.stem} workflow.\n---\n\n"
                        f"Read ${{CLAUDE_PLUGIN_ROOT}}/assets/actions/{guide.name} and follow that workflow.\n"
                        + assignment +
                        "Use AskUserQuestion for the interactive interview. If delegating, use the registered\n"
                        "materials-characterization role agent and include full context; workers return\n"
                        "checkpoint questions to this orchestrator. Use Bash only for approved local helper\n"
                        "calls; bind PACKAGE_ROOT to ${CLAUDE_PLUGIN_ROOT} in each call.\n"
                        "Arguments: $ARGUMENTS\n")
                (commands / guide.name).write_text(text)
                report["commands"] += 1
            for skill in sorted((output / "skills").glob("*/SKILL.md")):
                role = skill.parent.name.removeprefix("materials-characterization-")
                tools = "Read, Glob, Grep" if role == "task-verifier" else "Read, Glob, Grep, Write, Edit, Bash, WebFetch"
                text = (f"---\nname: {role}\ndescription: Materials characterization {role} role.\n"
                        f"tools: {tools}\n---\n\n"
                        f"Read ${{CLAUDE_PLUGIN_ROOT}}/skills/{skill.parent.name}/SKILL.md.\n"
                        "Apply its scientific contract within the caller's approved output paths.\n"
                        "Return structured complete, blocked, or needs_input with checkpoint kind\n"
                        "decision, human-action, or human-verify. Do not interview the researcher.\n"
                        "The caller owns state reconciliation, optional recording and paper gates.\n")
                (agents / (role + ".md")).write_text(text)
                report["agents"] += 1
                report["agent_bindings"][role] = metadata["name"] + ":" + role
        elif target == "gemini":
            (output / "gemini-extension.json").write_text(json.dumps({
                "name": metadata["name"], "version": metadata["version"],
                "description": metadata["description"], "contextFileName": "GEMINI.md"
            }, indent=2) + "\n")
            (output / "GEMINI.md").write_text(
                "# Materials characterization\n\nUse the installed materials-characterization skills and their relative action-guide links.\n"
                "The interactive assistant owns researcher questions and state changes. Roles may\n"
                "run inline when delegation is unavailable. No native fleet boundary is claimed.\n")
            directory = output / "commands/materials-characterization"
            directory.mkdir(parents=True)
            for guide in sorted((output / "assets/actions").glob("*.md")):
                text = (f"Use the installed materials-characterization skills to perform {guide.stem}. "
                        f"Read their relative link to assets/actions/{guide.name} and follow its contract. "
                        "Use the host conversation tool for researcher interviews. Delegate only with "
                        "available capabilities; otherwise perform the role inline. Arguments: {{args}}")
                (directory / (guide.stem + ".toml")).write_text(
                    "description = " + json.dumps(f"Materials characterization {guide.stem}") + "\n"
                    "prompt = " + json.dumps(text) + "\n")
                report["commands"] += 1
        else:
            raise ValueError(f"unsupported peer target: {target}")
        (output / "capability-report.json").write_text(json.dumps(report, indent=2) + "\n")
        return report
    except Exception:
        shutil.rmtree(output)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=["codex", "claude", "gemini"], required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(project(args.target, args.output), indent=2))
        return 0
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
