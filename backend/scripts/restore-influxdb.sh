#!/bin/bash

###############################################################################
# InfluxDB Restore Script
#
# Restores InfluxDB from a backup created by backup-influxdb.sh
#
# Usage:
#   ./backend/scripts/restore-influxdb.sh storage/backups/influxdb/influxdb-backup-2026-06-17_14-30-45.tar.gz
#
# WARNING: This will restore InfluxDB to the state of the backup
#          Any data written after the backup was created will be lost
#
###############################################################################

set -e

# Configuration
CONTAINER_NAME="huawei-influxdb"
RESTORE_DIR="/tmp/influxdb-restore"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper function
print_header() {
  echo -e "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║${NC} $1"
  echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
}

print_success() {
  echo -e "${GREEN}✅${NC} $1"
}

print_error() {
  echo -e "${RED}❌${NC} $1"
}

print_info() {
  echo -e "${YELLOW}ℹ️${NC}  $1"
}

print_warning() {
  echo -e "${RED}⚠️${NC}  $1"
}

# ============================================================================
# VALIDATION
# ============================================================================

print_header "InfluxDB Restore Tool"
echo ""

if [ -z "$1" ]; then
  print_error "No backup file specified"
  echo ""
  echo "Usage:"
  echo "  $0 <backup-file.tar.gz>"
  echo ""
  echo "Example:"
  echo "  $0 storage/backups/influxdb/influxdb-backup-2026-06-17_14-30-45.tar.gz"
  echo ""
  exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
  print_error "Backup file not found: $BACKUP_FILE"
  exit 1
fi

print_success "Found backup file: $BACKUP_FILE"
SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
print_info "Size: $SIZE"
echo ""

# ============================================================================
# CONFIRMATION
# ============================================================================

print_warning "RESTORE WILL:"
echo "  1. Stop InfluxDB container"
echo "  2. Delete current InfluxDB volume"
echo "  3. Restore data from backup"
echo "  4. Restart InfluxDB container"
echo ""
print_warning "⚠️  Any data written after the backup was created will be LOST"
echo ""

read -p "Continue with restore? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  print_info "Restore cancelled"
  exit 0
fi

echo ""
print_info "Starting restore process..."
echo ""

# ============================================================================
# RESTORE PROCESS
# ============================================================================

# Step 1: Stop containers
print_info "[1/5] Stopping InfluxDB container..."
docker compose --profile modular down influxdb
print_success "Container stopped"

# Step 2: Remove volume
print_warning "[2/5] Removing InfluxDB volume (this deletes current data)..."
docker volume rm huaweidashboard_influxdb_data
print_success "Volume removed"

# Step 3: Create restore directory
print_info "[3/5] Extracting backup..."
rm -rf "$RESTORE_DIR"
mkdir -p "$RESTORE_DIR"

if tar -xzf "$BACKUP_FILE" -C "$RESTORE_DIR"; then
  print_success "Backup extracted"
else
  print_error "Failed to extract backup"
  exit 1
fi

# Step 4: Start InfluxDB
print_info "[4/5] Starting InfluxDB container..."
docker compose --profile modular up -d influxdb

# Wait for container to be ready
MAX_RETRIES=30
RETRY_COUNT=0
while ! docker exec "$CONTAINER_NAME" influx ping > /dev/null 2>&1; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    print_error "InfluxDB did not start in time"
    exit 1
  fi
  echo "  Waiting for InfluxDB... (attempt $RETRY_COUNT/$MAX_RETRIES)"
  sleep 2
done
print_success "InfluxDB is running"

# Step 5: Restore backup
print_info "[5/5] Restoring data from backup..."

# Find the actual backup dir (it's nested in the tar)
EXTRACTED_DIR=$(find "$RESTORE_DIR" -maxdepth 1 -type d ! -name "$RESTORE_DIR" | head -1)

if [ -z "$EXTRACTED_DIR" ]; then
  print_error "Could not find extracted backup directory"
  rm -rf "$RESTORE_DIR"
  exit 1
fi

# Restore to InfluxDB
if docker exec -i "$CONTAINER_NAME" influx restore "$EXTRACTED_DIR" --full > /dev/null 2>&1; then
  print_success "Data restored successfully"
else
  print_error "Failed to restore data"
  rm -rf "$RESTORE_DIR"
  exit 1
fi

# Cleanup
rm -rf "$RESTORE_DIR"

echo ""
print_header "✅ Restore Completed Successfully"
echo ""
print_success "InfluxDB has been restored from backup"
print_info "All data is back to the state when the backup was created"
echo ""
