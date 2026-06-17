#!/bin/bash

###############################################################################
# InfluxDB Setup Script (Idempotent Version)
#
# Initializes InfluxDB with org, bucket, and generates authentication token
# Saves credentials to .env for application use
#
# Idempotent: Safe to run multiple times. Detects existing configuration.
#
# Usage:
#   ./backend/scripts/setup-influxdb-v2.sh
#
# What it does:
#   1. Waits for InfluxDB to be ready
#   2. Checks if already configured (reads .env or queries InfluxDB)
#   3. If not configured: Creates organization, bucket, and token
#   4. If configured: Shows current configuration
#   5. Updates .env with credentials
#
# Note: Run this BEFORE starting the application services
###############################################################################

set -e

# Configuration
INFLUX_HOST="${INFLUX_HOST:-localhost}"
INFLUX_PORT="${INFLUX_PORT:-8086}"
INFLUX_URL="http://${INFLUX_HOST}:${INFLUX_PORT}"
INFLUX_ORG="${INFLUX_ORG:-huawei-dashboard}"
INFLUX_BUCKET="${INFLUX_BUCKET:-telemetry}"
INFLUX_USERNAME="${INFLUX_USERNAME:-admin}"
INFLUX_PASSWORD="${INFLUX_PASSWORD:-huawei2024}"
ENV_FILE=".env"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║           InfluxDB Setup for HuaweiDashboard                   ║"
echo "║                   (Idempotent v2)                              ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# ============================================================================
# STEP 1: Check if InfluxDB is running
# ============================================================================
echo -e "${YELLOW}[1/5]${NC} Checking InfluxDB connection..."
MAX_RETRIES=30
RETRY_COUNT=0

while ! curl -s -f "${INFLUX_URL}/health" > /dev/null 2>&1; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    echo -e "${RED}❌ InfluxDB not responding after ${MAX_RETRIES} attempts${NC}"
    echo "   Make sure InfluxDB is running:"
    echo "   docker compose --profile dev up -d influxdb"
    exit 1
  fi
  echo "   Waiting for InfluxDB... (attempt $RETRY_COUNT/$MAX_RETRIES)"
  sleep 2
done

echo -e "${GREEN}✅ InfluxDB is running${NC}"
echo ""

# ============================================================================
# STEP 2: Check if already configured (idempotency check)
# ============================================================================
echo -e "${YELLOW}[2/5]${NC} Checking if already configured..."

ALREADY_CONFIGURED=false
EXISTING_TOKEN=""

# First check: Does .env have the token?
if [ -f "$ENV_FILE" ]; then
  EXISTING_TOKEN=$(grep "^INFLUX_TOKEN=" "$ENV_FILE" 2>/dev/null | sed 's/^INFLUX_TOKEN=//' | tr -d ' \n' || echo "")
  if [ -n "$EXISTING_TOKEN" ] && [ "$EXISTING_TOKEN" != "" ]; then
    ALREADY_CONFIGURED=true
    echo -e "${BLUE}ℹ️  Found INFLUX_TOKEN in $ENV_FILE${NC}"
  fi
fi

# Second check: Can we connect to InfluxDB with existing credentials?
if [ "$ALREADY_CONFIGURED" = true ]; then
  CHECK_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Token ${EXISTING_TOKEN}" \
    "${INFLUX_URL}/api/v2/orgs" 2>/dev/null)

  # Extract HTTP code (last line)
  HTTP_CODE=$(echo "$CHECK_RESPONSE" | tail -1)

  if [ "$HTTP_CODE" == "200" ]; then
    echo -e "${GREEN}✅ InfluxDB is already configured (credentials verified)${NC}"
    ALREADY_CONFIGURED=true
  else
    echo -e "${YELLOW}⚠️  Token in .env appears invalid (HTTP $HTTP_CODE)${NC}"
    ALREADY_CONFIGURED=false
  fi
fi

echo ""

# ============================================================================
# STEP 3: If already configured, show configuration and exit
# ============================================================================
if [ "$ALREADY_CONFIGURED" = true ]; then
  echo -e "${YELLOW}[3/5]${NC} Displaying current configuration..."

  # Try to read from .env
  if [ -f "$ENV_FILE" ]; then
    SAVED_URL=$(grep "^INFLUX_URL=" "$ENV_FILE" 2>/dev/null | sed 's/^INFLUX_URL=//' | tr -d ' \n' || echo "$INFLUX_URL")
    SAVED_ORG=$(grep "^INFLUX_ORG=" "$ENV_FILE" 2>/dev/null | sed 's/^INFLUX_ORG=//' | tr -d ' \n' || echo "$INFLUX_ORG")
    SAVED_BUCKET=$(grep "^INFLUX_BUCKET=" "$ENV_FILE" 2>/dev/null | sed 's/^INFLUX_BUCKET=//' | tr -d ' \n' || echo "$INFLUX_BUCKET")
  else
    SAVED_URL="$INFLUX_URL"
    SAVED_ORG="$INFLUX_ORG"
    SAVED_BUCKET="$INFLUX_BUCKET"
  fi

  echo "  INFLUX_URL=$SAVED_URL"
  echo "  INFLUX_ORG=$SAVED_ORG"
  echo "  INFLUX_BUCKET=$SAVED_BUCKET"
  echo "  INFLUX_TOKEN=$(echo "$EXISTING_TOKEN" | cut -c1-20)..." # Truncated for security
  echo ""

  echo "╔════════════════════════════════════════════════════════════════╗"
  echo "║                 ✅ Already Configured                          ║"
  echo "╚════════════════════════════════════════════════════════════════╝"
  echo ""
  echo "InfluxDB is ready. You can now:"
  echo "  1. Start the dashboard:"
  echo "     docker compose --profile modular up -d"
  echo ""
  echo "  2. Access InfluxDB UI:"
  echo "     ${INFLUX_URL}"
  echo "     Username: ${INFLUX_USERNAME}"
  echo ""
  exit 0
fi

# ============================================================================
# STEP 3 (continued): If NOT configured, initialize InfluxDB
# ============================================================================
echo -e "${YELLOW}[3/5]${NC} Initializing InfluxDB (first time setup)..."

SETUP_RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "{
    \"username\": \"${INFLUX_USERNAME}\",
    \"password\": \"${INFLUX_PASSWORD}\",
    \"org\": \"${INFLUX_ORG}\",
    \"bucket\": \"${INFLUX_BUCKET}\",
    \"retentionPeriodSeconds\": 0
  }" \
  "${INFLUX_URL}/api/v2/setup")

# Check if setup was successful or already completed
if echo "$SETUP_RESPONSE" | grep -q '"auth"'; then
  echo -e "${GREEN}✅ Organization and bucket created${NC}"
  INITIAL_TOKEN=$(echo "$SETUP_RESPONSE" | grep -o '"token":"[^"]*' | cut -d'"' -f4 | head -1)
elif echo "$SETUP_RESPONSE" | grep -q "already been completed"; then
  echo -e "${BLUE}ℹ️  InfluxDB already initialized (detected 'onboarding completed')${NC}"
  # Will use influx CLI to generate token in STEP 4
else
  echo -e "${RED}❌ Setup failed${NC}"
  echo "Response: $SETUP_RESPONSE" | head -20
  exit 1
fi

echo ""

# ============================================================================
# STEP 4: Generate API token (reuse existing valid token if it works)
# ============================================================================
echo -e "${YELLOW}[4/5]${NC} Setting up API credentials..."

# If we got here and token is invalid, generate a new one from scratch
# Since we're already past the "already configured" check, we know we need a new token

# We'll use the initial token from fresh setup if available
if [ -n "$INITIAL_TOKEN" ]; then
  TOKEN_TO_USE="$INITIAL_TOKEN"
else
  # Fallback: token in .env is the one to use
  TOKEN_TO_USE="$EXISTING_TOKEN"
fi

if [ -z "$TOKEN_TO_USE" ]; then
  echo -e "${RED}❌ No valid token available to query InfluxDB${NC}"
  echo "Unable to proceed. Please delete InfluxDB data and restart:"
  echo "  docker compose --profile modular down"
  echo "  docker volume rm huaweidashboard_influxdb-storage"
  echo "  docker compose --profile modular up -d"
  exit 1
fi

# Extract org ID
ORG_RESPONSE=$(curl -s -H "Authorization: Token ${TOKEN_TO_USE}" \
  "${INFLUX_URL}/api/v2/orgs" 2>/dev/null)

ORG_ID=$(echo "$ORG_RESPONSE" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)

if [ -z "$ORG_ID" ]; then
  echo -e "${RED}❌ Could not retrieve organization ID${NC}"
  exit 1
fi

# Extract bucket ID for the telemetry bucket
BUCKET_RESPONSE=$(curl -s -H "Authorization: Token ${TOKEN_TO_USE}" \
  "${INFLUX_URL}/api/v2/buckets?org=${ORG_ID}" 2>/dev/null)

BUCKET_ID=$(echo "$BUCKET_RESPONSE" | grep -o '"name":"'"${INFLUX_BUCKET}"'"[^}]*"id":"[^"]*' | tail -1 | grep -o '"id":"[^"]*' | cut -d'"' -f4)

if [ -z "$BUCKET_ID" ]; then
  echo -e "${RED}❌ Could not find bucket ID for '${INFLUX_BUCKET}'${NC}"
  exit 1
fi

# The existing/initial token is already valid - use it as-is
INFLUX_TOKEN="$TOKEN_TO_USE"
echo -e "${GREEN}✅ Using valid token for InfluxDB access${NC}"

echo ""

# ============================================================================
# STEP 5: Save credentials to .env
# ============================================================================
echo -e "${YELLOW}[5/5]${NC} Saving credentials to ${ENV_FILE}..."

# Function to update or add env variable
update_env() {
  local key=$1
  local value=$2

  if grep -q "^${key}=" "${ENV_FILE}" 2>/dev/null; then
    # Update existing
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}"
    else
      sed -i "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}"
    fi
  else
    # Add new
    echo "${key}=${value}" >> "${ENV_FILE}"
  fi
}

# Save credentials
update_env "INFLUX_URL" "http://influxdb:8086"
update_env "INFLUX_TOKEN" "${INFLUX_TOKEN}"
update_env "INFLUX_ORG" "${INFLUX_ORG}"
update_env "INFLUX_BUCKET" "${INFLUX_BUCKET}"
update_env "INFLUX_ENABLED" "true"

echo -e "${GREEN}✅ Credentials saved to ${ENV_FILE}${NC}"
echo ""

# ============================================================================
# Final Summary
# ============================================================================
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║              ✅ Setup Complete                                 ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "InfluxDB Configuration:"
echo "  Organization: ${INFLUX_ORG}"
echo "  Bucket: ${INFLUX_BUCKET}"
echo "  URL: http://influxdb:8086"
echo ""
echo "What's next:"
echo "  1. Start the application:"
echo "     docker compose --profile modular up -d"
echo ""
echo "  2. Access InfluxDB UI:"
echo "     http://localhost:8086"
echo "     Username: ${INFLUX_USERNAME}"
echo "     Password: ${INFLUX_PASSWORD}"
echo ""
echo "  3. Verify data is being stored:"
echo "     Check the Bucket 'telemetry' in InfluxDB UI"
echo ""
