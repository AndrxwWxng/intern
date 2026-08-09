#!/bin/bash

############################################################################
#
#    Scout Google Setup — creates Scout's Google Cloud identity
#
#    Provisions a GCP project + service account + JSON key so Scout can
#    read Google Drive. After this runs, share the Drive folders you want
#    Scout to see with the service account email it prints.
#
#    Scout always operates as its own identity — it never impersonates
#    you. The service account is Scout's account; you grant it access to
#    whatever you want it to see.
#
#    Usage:    ./scripts/google_setup.sh
#    Prereqs:  `gcloud` installed and `gcloud auth login` completed.
#
#    Interactive by default — prompts for the GCP project ID with a smart
#    default derived from your gcloud account (e.g. hello@agno.com →
#    scout-agno). For CI / scripting, set SCOUT_GCP_PROJECT_ID to skip
#    the prompt.
#
#    Overrides (export before running):
#      SCOUT_GCP_PROJECT_ID    6-30 char globally-unique project ID.
#                              GCP project IDs share one namespace across
#                              all of Google Cloud (like S3 buckets).
#      SCOUT_GCP_PROJECT_NAME  default: "Scout"
#      SCOUT_SA_NAME           default: scout-agent  (6-30 chars)
#      SCOUT_KEY_PATH          default: <repo>/.scout/service-account.json
#
#    The default key path lives inside the repo at `.scout/` (gitignored).
#    This keeps Scout's credentials co-located with the project and means
#    Docker Compose sees them without extra volume mounts.
#
#    Safe to re-run — reuses an existing project / service account if
#    one is already there, and writes a fresh key each time.
#
############################################################################

set -e

CURR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${CURR_DIR}")"

# Colors
ORANGE='\033[38;5;208m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

PROJECT_ID="${SCOUT_GCP_PROJECT_ID:-}"
PROJECT_NAME="${SCOUT_GCP_PROJECT_NAME:-Scout}"
SA_NAME="${SCOUT_SA_NAME:-scout-agent}"
KEY_PATH="${SCOUT_KEY_PATH:-${REPO_ROOT}/.scout/service-account.json}"

echo ""
echo -e "${ORANGE}"
cat << 'BANNER'
     █████╗  ██████╗ ███╗   ██╗ ██████╗
    ██╔══██╗██╔════╝ ████╗  ██║██╔═══██╗
    ███████║██║  ███╗██╔██╗ ██║██║   ██║
    ██╔══██║██║   ██║██║╚██╗██║██║   ██║
    ██║  ██║╚██████╔╝██║ ╚████║╚██████╔╝
    ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝
BANNER
echo -e "${NC}"
echo -e "    ${DIM}Google Setup — Scout's own GCP identity${NC}"
echo ""

# Preflight
if ! command -v gcloud &> /dev/null; then
    echo -e "    ${ORANGE}gcloud CLI not found.${NC}"
    echo -e "    Install: ${DIM}https://cloud.google.com/sdk/docs/install${NC}"
    exit 1
fi

ACTIVE_ACCOUNT=$(gcloud config get-value account 2>/dev/null || true)
if [[ -z "$ACTIVE_ACCOUNT" ]] || [[ "$ACTIVE_ACCOUNT" == "(unset)" ]]; then
    echo -e "    ${ORANGE}gcloud is not authenticated.${NC}"
    echo -e "    Run: ${DIM}gcloud auth login${NC}"
    exit 1
fi

# Derive a sensible default project ID from the gcloud account:
#   enterprise email (e.g. hello@agno.com) → scout-agno
#   personal email (gmail/icloud/etc.)        → scout-<username>
DOMAIN_SLUG=$(echo "${ACTIVE_ACCOUNT}" | awk -F@ 'NF==2{print $2}' | awk -F. 'NF>=2{print $1}' | tr -cd 'a-z0-9-')
case "${DOMAIN_SLUG}" in
    gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|protonmail|proton|pm|aol|fastmail|zoho|tutanota|gmx|mail)
        DOMAIN_SLUG=""
        ;;
esac
if [[ -n "${DOMAIN_SLUG}" ]]; then
    DEFAULT_PROJECT_ID="scout-${DOMAIN_SLUG}"
else
    USER_SLUG=$(whoami | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9-')
    DEFAULT_PROJECT_ID="scout-${USER_SLUG:-agent}"
fi
# GCP requires 6-30 chars; safety pad / truncate.
while (( ${#DEFAULT_PROJECT_ID} < 6 )); do
    DEFAULT_PROJECT_ID="${DEFAULT_PROJECT_ID}x"
done
if (( ${#DEFAULT_PROJECT_ID} > 30 )); then
    DEFAULT_PROJECT_ID="${DEFAULT_PROJECT_ID:0:30}"
    DEFAULT_PROJECT_ID="${DEFAULT_PROJECT_ID%-}"
fi

if [[ -z "${PROJECT_ID}" ]]; then
    if [[ -t 0 ]]; then
        echo -e "    ${DIM}GCP project IDs are globally unique across all of Google Cloud${NC}"
        echo -e "    ${DIM}(like S3 bucket names). Something org-scoped works best.${NC}"
        echo ""
        read -r -p "    GCP Project ID [${DEFAULT_PROJECT_ID}]: " PROJECT_ID
        PROJECT_ID="${PROJECT_ID:-$DEFAULT_PROJECT_ID}"
        echo ""
    else
        echo -e "    ${ORANGE}SCOUT_GCP_PROJECT_ID is required in non-interactive mode.${NC}"
        echo ""
        echo -e "    Example:"
        echo -e "      ${DIM}SCOUT_GCP_PROJECT_ID=${DEFAULT_PROJECT_ID} ./scripts/google_setup.sh${NC}"
        exit 1
    fi
fi

# GCP requires 6-30 chars for both project IDs and service account names.
validate_length() {
    local value="$1" label="$2" len=${#1}
    if (( len < 6 || len > 30 )); then
        echo -e "    ${ORANGE}${label} must be 6-30 chars, got ${len}: '${value}'${NC}"
        exit 1
    fi
}
validate_length "${PROJECT_ID}" "SCOUT_GCP_PROJECT_ID"
validate_length "${SA_NAME}"    "SCOUT_SA_NAME"

echo -e "    ${DIM}Authenticated as ${ACTIVE_ACCOUNT}${NC}"
echo -e "    ${DIM}Project ID:     ${PROJECT_ID}${NC}"
echo -e "    ${DIM}Service acct:   ${SA_NAME}${NC}"
echo -e "    ${DIM}Key path:       ${KEY_PATH}${NC}"
echo ""

# Step 1 — project
echo -e "    ${DIM}[1/4] Creating GCP project...${NC}"
if gcloud projects describe "${PROJECT_ID}" &> /dev/null; then
    echo -e "    ${DIM}      project already exists, reusing${NC}"
else
    gcloud projects create "${PROJECT_ID}" --name="${PROJECT_NAME}" --quiet
    echo -e "    ${DIM}      created ${PROJECT_ID}${NC}"
fi
gcloud config set project "${PROJECT_ID}" --quiet 2>/dev/null

# Step 2 — enable APIs
#   drive.googleapis.com     : what Scout actually uses
#   orgpolicy.googleapis.com : lets step 4 auto-override the SA-key org
#                              policy when enterprise orgs block key
#                              creation. Without this, v2 org policies
#                              aren't consulted and the override no-ops.
echo -e "    ${DIM}[2/4] Enabling APIs (Drive + Org Policy)...${NC}"
gcloud services enable drive.googleapis.com orgpolicy.googleapis.com --project="${PROJECT_ID}" --quiet

# Step 3 — service account
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
echo -e "    ${DIM}[3/4] Creating service account...${NC}"
if gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT_ID}" &> /dev/null; then
    echo -e "    ${DIM}      service account already exists, reusing${NC}"
else
    gcloud iam service-accounts create "${SA_NAME}" \
        --display-name="Scout Agent" \
        --project="${PROJECT_ID}" \
        --quiet
    echo -e "    ${DIM}      created ${SA_EMAIL}${NC}"
fi

# Step 4 — key
echo -e "    ${DIM}[4/4] Generating JSON key...${NC}"
mkdir -p "$(dirname "${KEY_PATH}")"

create_key() {
    gcloud iam service-accounts keys create "${KEY_PATH}" \
        --iam-account="${SA_EMAIL}" \
        --project="${PROJECT_ID}" \
        --quiet 2>&1
}

KEY_OK=0
if KEY_ERR=$(create_key); then
    KEY_OK=1
fi

# Enterprise orgs commonly block SA key creation via
# constraints/iam.disableServiceAccountKeyCreation. If that's the
# specific blocker and the caller has policy-admin rights, apply a
# project-scoped override and retry. Requires roles/orgpolicy.policyAdmin
# on the org (or on the project via inheritance).
if [[ $KEY_OK -eq 0 ]] && echo "${KEY_ERR}" | grep -q "iam.disableServiceAccountKeyCreation"; then
    echo -e "    ${DIM}      org policy blocks key creation; applying project override...${NC}"
    if OVERRIDE_ERR=$(gcloud resource-manager org-policies disable-enforce \
        constraints/iam.disableServiceAccountKeyCreation \
        --project="${PROJECT_ID}" --quiet 2>&1); then
        sleep 2  # brief propagation window
        echo -e "    ${DIM}      override applied, retrying key creation...${NC}"
        if KEY_ERR=$(create_key); then
            KEY_OK=1
        fi
    else
        echo -e "    ${DIM}      override failed:${NC}"
        while IFS= read -r line; do
            echo -e "    ${DIM}      ${line}${NC}"
        done <<< "${OVERRIDE_ERR}"
    fi
fi

if [[ $KEY_OK -eq 0 ]]; then
    echo ""
    echo -e "    ${ORANGE}Key creation failed.${NC}"
    echo -e "    ${DIM}${KEY_ERR}${NC}"
    echo ""
    if echo "${KEY_ERR}" | grep -q "iam.disableServiceAccountKeyCreation"; then
        echo -e "    ${BOLD}This is a GCP org policy, not a script bug.${NC}"
        echo -e "    Your org blocks downloadable SA keys, and the script"
        echo -e "    tried to auto-apply a project-scoped override but you"
        echo -e "    don't have ${DIM}roles/orgpolicy.policyAdmin${NC}."
        echo ""
        echo -e "    ${BOLD}Fix:${NC} ask a GCP org admin to run:"
        echo ""
        echo "    gcloud resource-manager org-policies disable-enforce constraints/iam.disableServiceAccountKeyCreation --project=${PROJECT_ID}"
        echo ""
        echo -e "    Then rerun this script."
    fi
    exit 1
fi

chmod 600 "${KEY_PATH}"
echo -e "    ${DIM}      wrote ${KEY_PATH}${NC}"

# Copy SA email to clipboard for easy sharing
CLIPBOARD_MSG=""
if command -v pbcopy &> /dev/null; then
    echo -n "${SA_EMAIL}" | pbcopy
    CLIPBOARD_MSG="(copied to clipboard)"
elif command -v xclip &> /dev/null; then
    echo -n "${SA_EMAIL}" | xclip -selection clipboard
    CLIPBOARD_MSG="(copied to clipboard)"
fi

echo ""
echo -e "    ${BOLD}Done.${NC} Scout's identity: ${BOLD}${SA_EMAIL}${NC} ${DIM}${CLIPBOARD_MSG}${NC}"
echo ""
# Prefer a repo-relative path for the env var if the key is under REPO_ROOT.
# Relative paths resolve the same on the host (cwd=repo root) and in the
# container (cwd=/app via .:/app mount), so docker + CLI both work.
if [[ "${KEY_PATH}" == "${REPO_ROOT}/"* ]]; then
    ENV_VALUE="${KEY_PATH#${REPO_ROOT}/}"
else
    ENV_VALUE="${KEY_PATH}"
fi

echo -e "    ${BOLD}Next:${NC}"
echo ""
echo -e "    1. Add to ${DIM}${REPO_ROOT}/.env${NC}:"
echo -e "       ${DIM}GOOGLE_SERVICE_ACCOUNT_FILE=${ENV_VALUE}${NC}"
echo ""
echo -e "    2. Share Drive folders with Scout:"
echo -e "       ${DIM}Right-click folder → Share → paste ${SA_EMAIL} → Viewer${NC}"
echo -e "       ${DIM}(Uncheck \"Notify people\" — the SA has no inbox.)${NC}"
echo ""
echo -e "    3. Restart Scout:"
echo -e "       ${DIM}docker compose up -d${NC}"
echo ""
