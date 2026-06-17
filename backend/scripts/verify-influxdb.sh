#!/bin/bash

###############################################################################
# Verify InfluxDB Data Collection
#
# This script verifies that the HuaweiDashboard application is successfully
# collecting and storing telemetry data in InfluxDB
###############################################################################

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Load configuration from .env
if [ -f ".env" ]; then
  source .env
fi

# Defaults - Fix URL for host execution
INFLUX_URL="${INFLUX_URL:-http://localhost:8086}"
# If running from Docker and INFLUX_URL was set to influxdb:8086, keep it
# If running from host and INFLUX_URL is influxdb:8086, change to localhost
if [[ "$INFLUX_URL" == "http://influxdb:8086" ]] && [ -z "$DOCKER" ]; then
  INFLUX_URL="http://localhost:8086"
fi

INFLUX_TOKEN="${INFLUX_TOKEN}"
INFLUX_ORG="${INFLUX_ORG:-huawei-dashboard}"
INFLUX_BUCKET="${INFLUX_BUCKET:-telemetry}"

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║        InfluxDB Data Collection Verification                  ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Check if token is set
if [ -z "$INFLUX_TOKEN" ]; then
  echo -e "${RED}❌ INFLUX_TOKEN not found in .env${NC}"
  echo "   Run: ./backend/scripts/setup-influxdb-v2.sh"
  exit 1
fi

echo -e "${BLUE}Configuration:${NC}"
echo "  URL: $INFLUX_URL"
echo "  Org: $INFLUX_ORG"
echo "  Bucket: $INFLUX_BUCKET"
echo ""

# Step 1: Check InfluxDB connection
echo "[1/4] Checking InfluxDB connection..."
HEALTH=$(curl -s -f "${INFLUX_URL}/health" 2>&1)

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✅ InfluxDB is responding${NC}"
else
  echo -e "${RED}❌ Cannot connect to InfluxDB at ${INFLUX_URL}${NC}"
  exit 1
fi
echo ""

# Step 2: Query data count
echo "[2/4] Querying data point count..."
COUNT_QUERY='from(bucket:"'"$INFLUX_BUCKET"'")
  |> range(start: -24h)
  |> group(columns: ["_measurement"])
  |> count()
  |> yield(name: "count")'

COUNT_RESPONSE=$(curl -s -X POST \
  -H "Authorization: Token ${INFLUX_TOKEN}" \
  -H "Content-Type: application/vnd.flux" \
  --data "$COUNT_QUERY" \
  "${INFLUX_URL}/api/v2/query?org=${INFLUX_ORG}" 2>/dev/null)

# Parse count from response
DATA_COUNT=$(echo "$COUNT_RESPONSE" | grep -o '"_value":[0-9]*' | cut -d':' -f2 | head -1)

if [ -z "$DATA_COUNT" ] || [ "$DATA_COUNT" == "0" ]; then
  echo -e "${YELLOW}⚠️  No data points found in the last 24 hours${NC}"
  DATA_COUNT=0
else
  echo -e "${GREEN}✅ Found ${DATA_COUNT} data points in the last 24 hours${NC}"
fi
echo ""

# Step 3: Check data time range
echo "[3/4] Checking data time range..."
TIME_RANGE_QUERY='from(bucket:"'"$INFLUX_BUCKET"'")
  |> range(start: -24h)
  |> group(columns: ["_time"])
  |> first()
  |> yield(name: "first")'

LATEST_QUERY='from(bucket:"'"$INFLUX_BUCKET"'")
  |> range(start: -24h)
  |> last()
  |> yield(name: "latest")'

LATEST_RESPONSE=$(curl -s -X POST \
  -H "Authorization: Token ${INFLUX_TOKEN}" \
  -H "Content-Type: application/vnd.flux" \
  --data "$LATEST_QUERY" \
  "${INFLUX_URL}/api/v2/query?org=${INFLUX_ORG}" 2>/dev/null)

# Extract latest timestamp
LATEST_TIME=$(echo "$LATEST_RESPONSE" | grep '_time' | tail -1 | grep -o '"[0-9T:.-]*Z"' | tr -d '"' | head -1)

if [ -n "$LATEST_TIME" ]; then
  echo -e "${GREEN}✅ Latest data point: ${LATEST_TIME}${NC}"
else
  echo -e "${YELLOW}⚠️  Could not determine latest data time${NC}"
fi
echo ""

# Step 4: Sample data
echo "[4/4] Fetching sample data..."
SAMPLE_QUERY='from(bucket:"'"$INFLUX_BUCKET"'")
  |> range(start: -24h)
  |> limit(n: 3)
  |> yield(name: "sample")'

SAMPLE_RESPONSE=$(curl -s -X POST \
  -H "Authorization: Token ${INFLUX_TOKEN}" \
  -H "Content-Type: application/vnd.flux" \
  --data "$SAMPLE_QUERY" \
  "${INFLUX_URL}/api/v2/query?org=${INFLUX_ORG}" 2>/dev/null)

# Count non-empty lines in response
SAMPLE_COUNT=$(echo "$SAMPLE_RESPONSE" | grep -c '"_value"' 2>/dev/null || echo "0")

if [ "$SAMPLE_COUNT" -gt 0 ]; then
  echo -e "${GREEN}✅ Sample data retrieved (${SAMPLE_COUNT} fields shown)${NC}"

  # Show fields being tracked
  echo ""
  echo "Data fields being collected:"
  echo "$SAMPLE_RESPONSE" | grep '"_field"' | grep -o '"_field","[^"]*' | cut -d'"' -f4 | sort | uniq | sed 's/^/  - /'
else
  echo -e "${YELLOW}⚠️  No sample data available yet${NC}"
fi

echo ""

# Final Summary
echo "╔════════════════════════════════════════════════════════════════╗"

if [ "$DATA_COUNT" -gt 0 ]; then
  echo "║              ✅ Data Collection Active                        ║"
  echo "╚════════════════════════════════════════════════════════════════╝"
  echo ""
  echo "✨ Success! The application is collecting data:"
  echo "   📊 Total points: ${DATA_COUNT}"
  echo "   📅 Latest: ${LATEST_TIME}"
  echo ""
  echo "Next steps:"
  echo "  1. View InfluxDB UI: http://localhost:8086"
  echo "  2. Login: admin / huawei2024"
  echo "  3. Navigate to: Buckets → telemetry"
  echo "  4. Explore the 'telemetry' measurement"
else
  echo "║              ⏳ Waiting for data...                          ║"
  echo "╚════════════════════════════════════════════════════════════════╝"
  echo ""
  echo "⚠️  No data collected yet. This could mean:"
  echo "  1. Services just started (wait 30 seconds and try again)"
  echo "  2. Modbus connection failed (check collector logs)"
  echo "  3. Backend not configured to write to InfluxDB"
  echo ""
  echo "Check collector logs:"
  echo "  docker logs huawei-collector-service --tail 50"
  echo ""
  echo "Try again in 30 seconds:"
  echo "  sleep 30 && ./backend/scripts/verify-influxdb.sh"
fi

echo ""
