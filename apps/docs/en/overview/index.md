# Overview

cfKanban is a task board for people and Agents working together. Ask an Agent to find, create, and progress issues in natural language, or use the Web UI to browse boards, edit content, assign work, and review completion results. Both interfaces share the same issues, permissions, and history.

```text
Use $cfkanban to list the Todo issues in DemoProject by priority.
Tell me which ones are assigned to me. Do not change anything yet.
```

If you already have project access, you can start immediately. The Agent reads the selected project and reports actual results. You do not need to deploy your own site or join the project again for each request.

## How Agents and the Web UI work together

| What you want to do | Where to start |
| --- | --- |
| Record issues, search, or add progress from your existing work context | Describe the goal to an Agent using the `cfkanban` Skill |
| Browse the project, edit manually, or read attachments and discussions | The Web board and issue details |
| Invite members, configure projects, or manage access | The `cfkanban-admin` Skill or the relevant Web management page |
| Deploy a site, maintain cloud resources, or update Skills and instances | The `cfkanban-deploy` Skill |
| Understand capabilities and choose the next step | This documentation or the teaching Skill `cfkanban-howto` |

Agent and Web operations follow the same access rules. A button does not grant access, and a Skill does not acquire extra permissions by acting for you. Your access can differ between projects.

## Where to go next

- **Already joined a project:** Go directly to [daily use](../usage/index.md).
- **Received an invitation or want to join a public project:** Read [Quick start](./quick-start.md).
- **Organizing projects and people:** Read [Administration](../administration/index.md).
- **Want your own instance:** Read [Deployment](../deployment/index.md).

## How to use these pages

Each feature starts with a prompt you can copy, followed by permissions, expected results, and Web instructions. Replace `DemoProject`, `CFK-123`, and angle-bracket placeholders with your own targets. Example requests can make real changes; send only the actions you want performed.

An Issue is a task. The interface supports English and Simplified Chinese; project names, issue descriptions, comments, and other collaboration content are not translated automatically. Project administrators can customize status display names, so your column labels may differ from the defaults used here.

These docs are provided with the site's release. Local Skills and the site are updated separately. If a feature is unavailable, ask the Agent to check both versions, or read [Concepts and roles](./concepts.md) to check your access scope.
