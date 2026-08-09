# Connecting Scout to Google Drive

Scout always acts as **its own identity** — a dedicated Google service account, not you. You create Scout's GCP account once, then share the Drive folders you want Scout to see with its email. Scout can read exactly what you've granted it, nothing more.

No browser consent, no OAuth tokens, no impersonation.

## The fast path

```bash
./scripts/google_setup.sh
```

The script prompts for a project ID with a smart default derived from your gcloud account — `hello@agno.com` suggests `scout-agno`, personal emails fall back to `scout-<username>`. Hit Enter to accept or type your own. GCP project IDs are globally unique across all of Google Cloud (like S3 bucket names), so an org-scoped name avoids collisions.

The script needs the `gcloud` CLI ([install](https://cloud.google.com/sdk/docs/install)) and `gcloud auth login` once. It then:

1. Creates the GCP project under your org.
2. Enables the **Google Drive API** (what Scout actually uses) and the **Org Policy API** (lets step 4 auto-override the SA-key org policy if your org enforces one).
3. Creates Scout's service account (`scout-agent` — scoped to the project, not globally unique) and downloads a JSON key to `<repo>/.scout/service-account.json` (gitignored).
4. Prints the service account email — Scout's identity — and copies it to your clipboard.

The script is idempotent: re-running it reuses an existing project / service account and writes a fresh key. If your GCP org blocks SA key creation via `constraints/iam.disableServiceAccountKeyCreation`, the script auto-applies a project-scoped override when run by a user with `roles/orgpolicy.policyAdmin` — otherwise it prints the command for an admin to run.

Overrides (export before running to skip the prompt — useful for CI):

| Variable | Default |
|---|---|
| `SCOUT_GCP_PROJECT_ID` | prompted; smart default from your gcloud account domain |
| `SCOUT_GCP_PROJECT_NAME` | `Scout` |
| `SCOUT_SA_NAME` | `scout-agent` (6-30 chars; scoped to the project) |
| `SCOUT_KEY_PATH` | `<repo>/.scout/service-account.json` (gitignored; Docker Compose sees it via the existing `.:/app` mount) |

## Share folders with Scout

This is the one step only you can do — the service account has no way to grant itself access.

For each folder Scout should see:

1. Right-click the folder in Drive → **Share**.
2. Paste Scout's service account email (it's in your clipboard from the script, or at the top of the JSON key file as `client_email`).
3. Role: **Viewer**.
4. Uncheck **Notify people** — the service account has no inbox.
5. Click **Share**.

Shared Drives work the same way — share the Shared Drive root.

## Wire it up

Add to `.env`:

```bash
GOOGLE_SERVICE_ACCOUNT_FILE=.scout/service-account.json
```

The script prints this line at the end with the right path for your setup. A relative path works on both host (Python CLI from the repo root) and inside the container (where `.:/app` makes the repo root the container's `/app`). If you stored the key outside the repo, use the absolute path and add a matching volume mount to `compose.yaml`.

Restart Scout:

```bash
docker compose up -d
```

## Verify

```bash
curl -sS http://localhost:8000/contexts | jq '.[] | select(.id == "gdrive")'
```

Expected:

```json
{ "id": "gdrive", "name": "Google Drive", "ok": true, "detail": "gdrive" }
```

Then ask Scout in chat:

> *"Search Drive for files with 'roadmap' in the name."*

Scout calls `query_gdrive` and returns matches with webViewLinks.

## Manual setup (if you can't run the script)

Same steps as the script, done by hand in the GCP Console:

1. [console.cloud.google.com](https://console.cloud.google.com) → **New Project** → give it a 6-30 char globally-unique ID, typically `scout-<yourcompany>`. Project IDs collide across all of Google Cloud; org-scoped names avoid that.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **IAM & Admin → Service Accounts → Create Service Account** → name it `scout-agent` (Google requires 6-30 chars — `scout` alone is too short). Skip the "grant project access" and "grant users access" steps.
4. Click the new service account → **Keys → Add Key → Create new key → JSON**. Move the downloaded file into `<repo>/.scout/service-account.json` (the `.scout/` dir is gitignored) and `chmod 600` it.
5. Copy the service account's email from the console (looks like `scout-agent@your-project.iam.gserviceaccount.com`).
6. Share Drive folders with that email (as above), set `GOOGLE_SERVICE_ACCOUNT_FILE=.scout/service-account.json`, restart.

## Why Scout gets its own account

Scout is designed as an enterprise context agent. It shouldn't operate by borrowing your credentials — that collapses audit trails, limits what it can expose to others on your team, and means everything it "does" shows up as something *you* did. Scout having its own identity keeps actions attributable, lets multiple people interact with the same agent safely, and scopes access to exactly what's been granted to Scout — not to whichever human happens to be logged in.

The same principle applies to Gmail and Calendar when those providers ship: Scout will have its own mailbox and calendar seat, not impersonate yours.

## Security notes

- **The JSON key is a credential.** Don't commit it. Don't paste it into chat. Rotate it in GCP Console if exposed.
- **Role on shared folders is `Viewer`.** Scout cannot modify or delete your files. The Drive toolkit also runs with `upload_file=False, download_file=False` in code (see [`agno.context.gdrive.provider`](https://github.com/agno-agi/agno/blob/main/libs/agno/agno/context/gdrive/provider.py)).
- **Scout only sees what's shared with it.** There's no domain-wide delegation path in Scout — that's the flow where an SA impersonates a real user, which is exactly the thing we're not doing.

## Troubleshooting

- **`/contexts` shows `ok: false, detail: "service account file not found"`** — the path in `GOOGLE_SERVICE_ACCOUNT_FILE` doesn't resolve inside the container. Default path `.scout/service-account.json` works because the repo root is mounted at `/app`. If you moved the key outside the repo, either move it back under `.scout/` or add a matching volume mount in `compose.yaml`.
- **Queries return "permission denied" / 403** — the file or folder isn't shared with the service account email. Re-check the share step.
- **Queries return no results** — make sure you shared folders (not just individual files) if you're searching broadly. Also verify the JSON is valid: `python -m json.tool .scout/service-account.json`.
- **`gcloud projects create` fails with "project ID already in use"** — someone else owns that ID globally. Rerun and type a different one at the prompt, or set `SCOUT_GCP_PROJECT_ID=scout-<yourcompany>-alt ./scripts/google_setup.sh`.
- **`gcloud` errors about billing** — some GCP orgs require billing for project creation. Enable it in the console or use an existing project via `SCOUT_GCP_PROJECT_ID`.
- **Step 4 fails with `constraints/iam.disableServiceAccountKeyCreation`** — your GCP org blocks downloadable SA keys by default (common in enterprise orgs). The script tries to auto-apply a project-scoped override if you run it as someone with `roles/orgpolicy.policyAdmin`. If you don't have that role, ask a GCP org admin to run:

  ```bash
  gcloud resource-manager org-policies disable-enforce \
    constraints/iam.disableServiceAccountKeyCreation \
    --project=<your-project-id>
  ```

  Then rerun the script. If there's no admin to ask, create the project under a personal Google account outside the org (no org = no org policy).

- **Override was applied but key creation still fails** — the Org Policy API (`orgpolicy.googleapis.com`) needs to be enabled on the project for v2 policies to be consulted by the key-creation gate. Step 2 enables it automatically on new runs; for projects created before this fix, run `gcloud services enable orgpolicy.googleapis.com --project=<your-project-id>` and retry.
