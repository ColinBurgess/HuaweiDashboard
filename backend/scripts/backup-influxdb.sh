#!/bin/bash

###############################################################################
# InfluxDB Backup Script
#
# Creates a backup of InfluxDB data and configuration
# Stores backup with timestamp for easy restoration
#
# Usage:
#   ./backend/scripts/backup-influxdb.sh              # Create backup now
#   ./backend/scripts/backup-influxdb.sh --schedule   # Schedule daily backups via cron
#
# Backups stored in: storage/backups/influxdb/
#
###############################################################################

set -e

# Configuration
BACKUP_DIR="storage/backups/influxdb"
CONTAINER_NAME="huawei-influxdb"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
BACKUP_FILE="$BACKUP_DIR/influxdb-backup-$TIMESTAMP"
INFLUX_BACKUP_DIR="/tmp/influxdb-backup-$TIMESTAMP"

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

# ============================================================================
# MAIN
# ============================================================================

print_header "InfluxDB Backup Tool"
echo ""

# Check if container is running
if ! docker ps | grep -q "$CONTAINER_NAME"; then
  print_error "Container '$CONTAINER_NAME' is not running"
  echo "   Start it with: docker compose --profile modular up -d influxdb"
  exit 1
fi

print_info "Checking InfluxDB connectivity..."
if ! docker exec "$CONTAINER_NAME" influx ping > /dev/null 2>&1; then
  print_error "Cannot connect to InfluxDB"
  exit 1
fi
print_success "InfluxDB is responding"
echo ""

# Create backup directory
mkdir -p "$BACKUP_DIR"
print_info "Backup directory: $BACKUP_DIR"
echo ""

# Create backup
print_info "Starting backup..."
if docker exec "$CONTAINER_NAME" influx backup "$INFLUX_BACKUP_DIR" > /dev/null 2>&1; then
  print_success "Backup created successfully"
else
  print_error "Failed to create backup"
  exit 1
fi

# Copy from container to host
print_info "Copying backup to host..."
docker cp "$CONTAINER_NAME:$INFLUX_BACKUP_DIR" "$BACKUP_DIR/temp-$TIMESTAMP" > /dev/null 2>&1

# Compress backup
print_info "Compressing backup..."
if tar -czf "$BACKUP_FILE.tar.gz" -C "$BACKUP_DIR" "temp-$TIMESTAMP" > /dev/null 2>&1; then
  print_success "Backup compressed: $BACKUP_FILE.tar.gz"
  
  # Calculate size
  SIZE=$(du -h "$BACKUP_FILE.tar.gz" | cut -f1)
  print_info "Backup size: $SIZE"
  
  # Clean up temp directory
  rm -rf "$BACKUP_DIR/temp-$TIMESTAMP"
  
  # Clean up in container
  docker exec "$CONTAINER_NAME" rm -rf "$INFLUX_BACKUP_DIR" > /dev/null 2>&1
else
  print_error "Failed to compress backup"
  rm -rf "$BACKUP_DIR/temp-$TIMESTAMP"
  docker exec "$CONTAINER_NAME" rm -rf "$INFLUX_BACKUP_DIR" > /dev/null 2>&1
  exit 1
fi

echo ""

# Cleanup old backups (keep last 30 days)
DAYS_TO_KEEP=30
print_info "Cleaning up backups older than $DAYS_TO_KEEP days..."
find "$BACKUP_DIR" -name "influxdb-backup-*.tar.gz" -mtime +"$DAYS_TO_KEEP" -delete
KEPT=$(find "$BACKUP_DIR" -name "influxdb-backup-*.tar.gz" | wc -l)
print_info "Kept $KEPT recent backups"

echo ""

# Show backup info
print_success "Backup completed!"
echo ""
echo "Backup file:"
echo "  $BACKUP_FILE.tar.gz"
echo ""
echo "To restore this backup later, run:"
echo "  ./backend/scripts/restore-influxdb.sh $BACKUP_FILE.tar.gz"
echo ""

# If scheduled option
if [ "$1" == "--schedule" ]; then
  echo ""
  print_header "Setting up daily backups"
  echo ""
  print_info "To enable automatic daily backups, add this to your crontab:"
  echo ""
  echo "  # Run InfluxDB backup daily at 2 AM"
  echo "  0 2 * * * cd /path/to/HuaweiDashboard && ./backend/scripts/backup-influxdb.sh >> \$(date +%Y-%m-%d).backup.log 2>&1"
  echo ""
  print_info "Add it with: crontab -e"
  echo ""
fi
