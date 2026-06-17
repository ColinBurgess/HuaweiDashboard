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
#   ./backend/scripts/setup-influxdb-v2.sh              # Normal setup
#   ./backend/scripts/setup-influxdb-v2.sh --rotate-password  # Rotate admin password
#
# What it does:
#   1. Waits for InfluxDB to be ready
#   2. Checks if already configured (reads .env or queries InfluxDB)
#   3. If not configured: Creates organization, bucket, and token
#   4. If configured: Shows current configuration
#   5. Updates .env with credentials
#
# Password Management:
#   - Reads INFLUX_PASSWORD from .env if it exists
#   - If missing, generates a random password and saves to .env
#   - Use --rotate-password to generate and apply a new password
#
# Note: Run this BEFORE starting the application services
###############################################################################

set -e

# Parse command-line flags
ROTATE_PASSWORD=false
if [ "$1" = "--rotate-password" ]; then
  ROTATE_PASSWORD=true
fi

# Configuration
INFLUX_HOST="${INFLUX_HOST:-localhost}"
INFLUX_PORT="${INFLUX_PORT:-8086}"
INFLUX_URL="http://${INFLUX_HOST}:${INFLUX_PORT}"
INFLUX_ORG="${INFLUX_ORG:-huawei-dashboard}"
INFLUX_BUCKET="${INFLUX_BUCKET:-telemetry}"
INFLUX_USERNAME="${INFLUX_USERNAME:-admin}"
ENV_FILE=".env"

# Load or generate INFLUX_PASSWORD
if [ -f "$ENV_FILE" ] && grep -q "^INFLUX_PASSWORD=" "$ENV_FILE" 2>/dev/null; then
  INFLUX_PASSWORD=$(grep "^INFLUX_PASSWORD=" "$ENV_FILE" | sed 's/^INFLUX_PASSWORD=//')
else
  # Generate random password if not in .env
  INFLUX_PASSWORD=$(openssl rand -base64 12 | tr -d '=+')
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ============================================================================
# Handle --rotate-password flag
# ============================================================================
if [ "$ROTATE_PASSWORD" = true ]; then
  echo "╔════════════════════════════════════════════════════════════════╗"
  echo "║           InfluxDB Password Rotation                           ║"
  echo "╚════════════════════════════════════════════════════════════════╝"
  echo ""
  
  # Wait for InfluxDB
  echo -e "${YELLOW}[1/2]${NC} Checking InfluxDB connection..."
  MAX_RETRIES=10
  RETRY_COUNT=0
  while ! curl -s -f "${INFLUX_URL}/health" > /dev/null 2>&1; do
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
      echo -e "${RED}❌ InfluxDB not responding${NC}"
      exit 1
    fi
    sleep 2
  done
  echo -e "${GREEN}✅ InfluxDB is running${NC}"
  echo ""
  
  # Generate new password
  echo -e "${YELLOW}[2/2]${NC} Rotating admin password..."
  NEW_PASSWORD=$(openssl rand -base64 12 | tr -d '=+')
  
  # Change password in InfluxDB
  docker exec huawei-influxdb influx user change-password \
    --username "${INFLUX_USERNAME}" \
    --password "${NEW_PASSWORD}" 2>/dev/null
  
  if [ $? -eq 0 ]; then
    # Save new password to .env
    if grep -q "^INFLUX_PASSWORD=" "${ENV_FILE}" 2>/dev/null; then
      if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|^INFLUX_PASSWORD=.*|INFLUX_PASSWORD=${NEW_PASSWORD}|" "${ENV_FILE}"
      else
        sed -i "s|^INFLUX_PASSWORD=.*|INFLUX_PASSWORD=${NEW_PASSWORD}|" "${ENV_FILE}"
      fi
    else
      echo "INFLUX_PASSWORD=${NEW_PASSWORD}" >> "${ENV_FILE}"
    fi
    
    echo -e "${GREEN}✅ Password rotated successfully${NC}"
    echo ""
    echo "╔════════════════════════════════════════════════════════════════╗"
    echo "║              ✅ Rotation Complete                              ║"
    echo "╚════════════════════════════════════════════════════════════════╝"
    echo ""
    echo "New credentials saved to .env:"
    echo "  Username: ${INFLUX_USERNAME}"
    echo "  Password: (saved in .env)"
    echo ""
  else
    echo -e "${RED}❌ Failed to rotate password${NC}"
    exit 1
  fi
  
  exit 0
fi

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
    echo -e "${GREEN}✅ Token is valid (HTTP 200)${NC}"
    ALREADY_CONFIGURED=true
  else
    echo -e "${YELLOW}⚠️  Token in .env is invalid (HTTP $HTTP_CODE)${NC}"
    ALREADY_CONFIGURED=false
  fi
fi

echo ""

# ============================================================================
# STEP 3: If already configured, show configuration and exit
# ============================================================================
if [ "$ALREADY_CONFIGURED" = true ]; then
  echo -e "${YELLOW}[3/3]${NC} Displaying current configuration..."

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
echo -e "${YELLOW}[3/4]${NC} Initializing InfluxDB (first time setup)..."

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
  # Need to generate a token for the already-initialized InfluxDB
  # Use admin credentials to get initial access via Basic Auth
  echo -e "${YELLOW}[3.5/4]${NC} Generating API token..."
  
  ADMIN_CREDS=$(echo -n "${INFLUX_USERNAME}:${INFLUX_PASSWORD}" | base64)
  
  # Get org ID with Basic auth
  ORG_RESPONSE=$(curl -s -H "Authorization: Basic ${ADMIN_CREDS}" \
    "${INFLUX_URL}/api/v2/orgs" 2>/dev/null)
  
  ORG_ID=$(echo "$ORG_RESPONSE" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
  
  if [ -z "$ORG_ID" ]; then
    echo -e "${RED}❌ Could not retrieve organization ID${NC}"
    exit 1
  fi
  
  # Get bucket ID
  BUCKET_RESPONSE=$(curl -s -H "Authorization: Basic ${ADMIN_CREDS}" \
    "${INFLUX_URL}/api/v2/buckets?org=${ORG_ID}" 2>/dev/null)
  
  BUCKET_ID=$(echo "$BUCKET_RESPONSE" | grep -o '"name":"'"${INFLUX_BUCKET}"'"[^}]*"id":"[^"]*' | tail -1 | grep -o '"id":"[^"]*' | cut -d'"' -f4)
  
  if [ -z "$BUCKET_ID" ]; then
    echo -e "${RED}❌ Could not find bucket ID for '${INFLUX_BUCKET}'${NC}"
    exit 1
  fi
  
  # Generate API token with Basic auth
  TOKEN_RESPONSE=$(curl -s -X POST \
    -H "Authorization: Basic ${ADMIN_CREDS}" \
    -H "Content-Type: application/json" \
    -d "{
      \"description\": \"HuaweiDashboard API Token\",
      \"orgID\": \"${ORG_ID}\",
      \"status\": \"active\",
      \"permissions\": [
        {\"action\": \"read\", \"resource\": {\"type\": \"buckets\", \"id\": \"${BUCKET_ID}\"}},
        {\"action\": \"write\", \"resource\": {\"type\": \"buckets\", \"id\": \"${BUCKET_ID}\"}}
      ]
    }" \
    "${INFLUX_URL}/api/v2/authorizations" 2>/dev/null)
  
  INITIAL_TOKEN=$(echo "$TOKEN_RESPONSE" | grep -o '"token":"[^"]*' | cut -d'"' -f4 | head -1)
  
  if [ -z "$INITIAL_TOKEN" ] || [ "$INITIAL_TOKEN" = "null" ]; then
    echo -e "${RED}❌ Failed to generate API token${NC}"
    exit 1
  fi
  
  echo -e "${GREEN}✅ API token generated${NC}"
else
  echo -e "${RED}❌ Setup failed${NC}"
  echo "Response: $SETUP_RESPONSE" | head -20
  exit 1
fi

echo ""

# ============================================================================
# STEP 4: Save credentials to .env
# ============================================================================
echo -e "${YELLOW}[4/4]${NC} Saving credentials to .env..."

# At this point, INITIAL_TOKEN should be set from STEP 3
if [ -z "$INITIAL_TOKEN" ]; then
  echo -e "${RED}❌ No token available to save${NC}"
  exit 1
fi

INFLUX_TOKEN="$INITIAL_TOKEN"

echo ""

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
update_env "INFLUX_PASSWORD" "${INFLUX_PASSWORD}"
update_env "INFLUX_ORG" "${INFLUX_ORG}"
update_env "INFLUX_BUCKET" "${INFLUX_BUCKET}"
update_env "INFLUX_ENABLED" "true"

echo -e "${GREEN}✅ Credentials saved to ${ENV_FILE}${NC}"
echo ""

# ============================================================================
# Setup Complete Summary
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
echo "     Password: (see .env file)"
echo ""
echo "  3. Verify data is being stored:"
echo "     Check the Bucket 'telemetry' in InfluxDB UI"
echo ""
echo "  4. To rotate admin password in the future:"
echo "     ./backend/scripts/setup-influxdb-v2.sh --rotate-password"
echo ""
