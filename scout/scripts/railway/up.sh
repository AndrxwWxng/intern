#!/bin/bash

############################################################################
#
#    Agno Railway Setup (first-time provisioning)
#
#    Usage: ./scripts/railway/up.sh
#    Redeploy: ./scripts/railway/redeploy.sh
#    Sync .env:  ./scripts/railway/env.sh
#
#    Prerequisites:
#      - Railway CLI installed
#      - Logged in via `railway login`
#      - OPENAI_API_KEY set in environment (or .env)
#
############################################################################

set -e

# Colors
ORANGE='\033[38;5;208m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

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

# Load env file — .env.production preferred for Railway, .env as fallback
if [[ -f .env.production ]]; then
    set -a
    source .env.production
    set +a
    echo -e "${DIM}Loaded .env.production${NC}"
elif [[ -f .env ]]; then
    set -a
    source .env
    set +a
    echo -e "${DIM}Loaded .env${NC}"
fi

# Preflight
if ! command -v railway &> /dev/null; then
    echo "Railway CLI not found. Install: https://docs.railway.app/guides/cli"
    exit 1
fi

if [[ -z "$OPENAI_API_KEY" ]]; then
    echo "OPENAI_API_KEY not set. Add to .env or export it."
    exit 1
fi

echo -e "${BOLD}Initializing project...${NC}"
echo ""
railway init -n "scout"

echo ""
echo -e "${BOLD}Deploying PgVector database...${NC}"
echo ""
railway add -s pgvector -i agnohq/pgvector:18 \
    -v "POSTGRES_USER=${DB_USER:-ai}" \
    -v "POSTGRES_PASSWORD=${DB_PASS:-ai}" \
    -v "POSTGRES_DB=${DB_DATABASE:-ai}"

echo ""
echo -e "${BOLD}Adding database volume...${NC}"
railway service link pgvector
railway volume add -m /var/lib/postgresql 2>/dev/null || echo -e "${DIM}Volume already exists or skipped${NC}"

echo ""
echo -e "${DIM}Waiting 15s for database...${NC}"
sleep 15

echo ""
echo -e "${BOLD}Creating application service...${NC}"
echo ""
# Forward every relevant env var the first deploy might need. Keys not
# set in the local shell become empty strings (harmless). Use
# ./scripts/railway/env.sh to sync from .env after the fact.
railway add -s scout \
    -v "DB_USER=${DB_USER:-ai}" \
    -v "DB_PASS=${DB_PASS:-ai}" \
    -v "DB_HOST=pgvector.railway.internal" \
    -v "DB_PORT=${DB_PORT:-5432}" \
    -v "DB_DATABASE=${DB_DATABASE:-ai}" \
    -v "DB_DRIVER=postgresql+psycopg" \
    -v "WAIT_FOR_DB=True" \
    -v "PORT=8000" \
    -v "OPENAI_API_KEY=${OPENAI_API_KEY}" \
    -v "PARALLEL_API_KEY=${PARALLEL_API_KEY:-}"

echo ""
echo -e "${BOLD}Deploying application...${NC}"
echo ""
railway up --service scout -d

echo ""
echo -e "${BOLD}Creating domain...${NC}"
echo ""
railway domain --service scout

echo ""
echo -e "${BOLD}Done.${NC} Domain may take ~5 minutes."
echo -e "${DIM}Logs:             railway logs --service scout${NC}"
echo -e "${DIM}Sync env vars:    ./scripts/railway/env.sh  (defaults to .env.production)${NC}"
echo ""
