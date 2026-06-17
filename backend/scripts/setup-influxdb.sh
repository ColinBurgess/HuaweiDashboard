#!/bin/bash

###############################################################################
# InfluxDB Setup Script
#
# Initializes InfluxDB with org, bucket, and generates authentication token
# Saves credentials to .env for application use
#
# Usage:
#   ./backend/scripts/setup-influxdb.sh
#
# What it does:
#   1. Waits for InfluxDB to be ready
#   2. Creates organization and bucket
#   3. Generates API token with read/write permissions
#   4. Updates .env with INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET
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
NC='\033[0m' # No Color

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║           InfluxDB Setup for HuaweiDashboard                   ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Step 1: Check if InfluxDB is running
echo -e "${YELLOW}[1/4]${NC} Checking InfluxDB connection..."
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

# Step 2: Check if setup is already done
echo -e "${YELLOW}[2/4]${NC} Checking if already configured..."

# Try to get buckets (requires authentication)
BUCKETS=$(curl -s -w "\n%{http_code}" \
  -H "Authorization: Token ${INFLUX_PASSWORD}" \
  "${INFLUX_URL}/api/v2/buckets" 2>/dev/null || echo "")

if echo "$BUCKETS" | grep -q "\"name\":\"${INFLUX_BUCKET}\""; then
  echo -e "${GREEN}✅ InfluxDB already configured${NC}"
  echo ""
  echo "Skipping setup. If you need to reconfigure, delete:"
  echo "  - InfluxDB container: docker compose down"
  echo "  - InfluxDB volume: docker volume rm huaweidashboard_influxdb_data"
  exit 0
fi

echo "Proceeding with setup..."
echo ""

# Step 3: Initialize setup (create user, org, bucket)
echo -e "${YELLOW}[3/4]${NC} Initializing InfluxDB..."

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

# Check if setup was successful
if echo "$SETUP_RESPONSE" | grep -q "\"auth\""; then
  echo -e "${GREEN}✅ Organization and bucket created${NC}"
else
  echo -e "${RED}❌ Setup failed${NC}"
  echo "Response: $SETUP_RESPONSE"
  exit 1
fi

# Extract token from setup response
INITIAL_TOKEN=$(echo "$SETUP_RESPONSE" | grep -o '"token":"[^"]*' | cut -d'"' -f4)

if [ -z "$INITIAL_TOKEN" ]; then
  echo -e "${RED}❌ Could not extract token from setup response${NC}"
  exit 1
fi

echo ""

# Step 4: Generate a permanent API token
echo -e "${YELLOW}[4/4]${NC} Generating API token..."

TOKEN_RESPONSE=$(curl -s -X POST \
  -H "Authorization: Token ${INITIAL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"description\": \"HuaweiDashboard API Token\",
    \"orgID\": \"$(curl -s -H "Authorization: Token ${INITIAL_TOKEN}" "${INFLUX_URL}/api/v2/orgs" | grep -o "\"id\":\"[^\"]*" | head -1 | cut -d'"' -f4)\",
    \"status\": \"active\",
    \"permissions\": [
      {
        \"action\": \"read\",
        \"resource\": {
          \"type\": \"buckets\"
        }
      },
      {
        \"action\": \"write\",
        \"resource\": {
          \"type\": \"buckets\"
        }
      }
    ]
  }" \
  "${INFLUX_URL}/api/v2/authorizations")

INFLUX_TOKEN=$(echo "$TOKEN_RESPONSE" | grep -o '"token":"[^"]*' | cut -d'"' -f4 | head -1)

if [ -z "$INFLUX_TOKEN" ]; then
  echo -e "${YELLOW}⚠️  Using initial setup token (less secure)${NC}"
  INFLUX_TOKEN="$INITIAL_TOKEN"
fi

echo -e "${GREEN}✅ API token generated${NC}"
echo ""

# Step 5: Update .env file
echo "Updating ${ENV_FILE}..."

# Function to update or add env variable
update_env() {
  local key=$1
  local value=$2

  if grep -q "^${key}=" "${ENV_FILE}"; then
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

echo -e "${GREEN}✅ Credentials saved to ${ENV_FILE}${NC}"
echo ""

# Final summary
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
echo "     Password: (check .env)"
echo ""
echo "  3. Verify data is being recorded:"
echo "     - Go to http://localhost:8086"
echo "     - Select bucket '${INFLUX_BUCKET}'"
echo "     - Check for 'telemetry' measurements"
echo ""
