# Git-Backed Knowledge Wiki

Scout ships with the knowledge wiki hosted on the local filesystem
(`wiki/knowledge/`). This is a good for a local development but in
production we should use use something we can share across containers.

`GitBackend` swaps the storage layer for a git repository. Every time
`update_knowledge` is called, the backend stages the changed files,
commits with an LLM-summarised one-line message, rebases onto the remote, and pushes. You get durability, an audit trail, and a place reviewers can leave
comments on what Scout has learned.

The voice wiki stays filesystem-backed. Voice rules are code-managed by
design — change them via PR to the scout repo, not via the agent.

## Setup

### 1. Create the wiki repo

A new private repo on GitHub. One file is enough to start:

```sh
gh repo create your-org/your-wiki --private --add-readme
```

Default branch `main` works. Branch can be configured later.

### 2. Mint a fine-grained PAT

GitHub → Settings → Developer settings → Personal access tokens →
**Fine-grained tokens** → **Generate new token**.

- **Resource owner**: your org (or your user)
- **Repository access**: only `your-org/your-wiki`
- **Repository permissions** → **Contents**: **Read and write**

> Note: make sure to have read and write permissions.

Copy the `github_pat_*` value.

> The PAT is registered with `agno.context.wiki.GitBackend`'s `Scrubber`
> on construction — it will not appear in any log line, including stderr
> from a failed git invocation.

### 3. Set env vars

In `.env` (or `.env.production` for Railway):

```sh
WIKI_REPO_URL=https://github.com/your-org/your-wiki.git
WIKI_GITHUB_TOKEN=github_pat_***
# Optional:
# WIKI_BRANCH=main                       # defaults to main
# WIKI_LOCAL_PATH=/var/lib/scout/wiki    # defaults to /repos/<your-wiki>
```

Both `WIKI_REPO_URL` and `WIKI_GITHUB_TOKEN` must be set. Setting only one
logs a warning and falls back to `FileSystemBackend`.

### 4. Restart Scout

`scout/contexts.py::_create_knowledge_wiki()` detects the env vars at
startup and switches the backend automatically — no code changes
needed. On startup you'll see `Knowledge wiki: GitBackend (<repo_url>)`
in the logs.

The first `update_knowledge` call clones the repo into `WIKI_LOCAL_PATH`
(or a default tmp path if unset), writes the page, commits with an
LLM-summarised message, rebases onto the remote, and pushes. Subsequent
calls reuse the clone.

The provider keeps the same id (`knowledge`) and the same tools
(`query_knowledge`, `update_knowledge`) — Scout's prompts and evals
don't need to know which backend is wired in.

## What gets committed

One commit per `update_knowledge` call. Commit messages are
LLM-summarised from the diff, no trailers, single line. The author is
`Agno Wiki Bot <wiki-bot@agno.local>` by default — override via the
`author_name` / `author_email` kwargs on `GitBackend`.

The git history is the audit trail. `git log -p wiki/knowledge/` shows
exactly what Scout has filed and when.

## Conflicts

If the remote has moved since the last write, the backend rebases
locally before pushing. If rebase fails (genuine content conflict on
the same lines), the call returns an error — Scout surfaces it to the
caller rather than silently overwriting.
