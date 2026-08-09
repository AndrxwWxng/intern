# Company Knowledge

Scout's prose memory. Runbooks, design notes, learnings, and anything
else that's better as a markdown page than a CRM row.

Files are organised by Scout as it learns. Common subdirectories:

- `runbooks/` — how-to docs (deploys, incidents, on-call)
- `design/`   — architectural notes, decision records
- `learnings/` — distilled takeaways from research, papers, conversations

Writes go through `update_knowledge`. Reads via `query_knowledge`.

This directory is gitignored by default — page contents stay on the
host running Scout. To make the wiki durable across deployments and
auditable, swap the factory to `GitBackend`. See
[`docs/WIKI_GIT.md`](../../docs/WIKI_GIT.md).
