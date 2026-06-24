# Changelog

All notable changes to HuaweiDashboard are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Format

Each release section includes:
- **Added**: New features
- **Changed**: Changes in existing functionality
- **Fixed**: Bug fixes
- **Removed**: Removed features
- **Security**: Security fixes
- **Deprecated**: Deprecated features

---

## [0.1.2] - Unreleased

### Fixed
- **CRITICAL**: Fixed false disconnection alerts at night (3+ AM, etc.)
  - Inverter enters "night mode" when no power generation detected for 1+ hour (expected standby)
  - Alerts suppressed during night mode to prevent false "Inversor Desconectado" → "Inversor Reconectado" pairs
  - Disconnection alerts still fire immediately during daytime (when inverter should be active)
  - Detector resets automatically when `activePower ≥ 50W` (solar generation detected)
- **CRITICAL**: Fixed consumption calculation to include EV charger power. Previously the chart only showed house load, excluding car charging consumption. Now `consumption = houseLoad + evLoad` correctly accounts for both.

---

## [Unreleased]

### Planned for v0.3.0
- **Configuration Menu**: Settings button/icon in dashboard header
- **Electricity Pricing Parameters**:
  - Grid import price (€/kWh)
  - Surplus export compensation (€/kWh)
  - Currency selector
- **Cost & Savings Analytics**:
  - Daily/weekly/monthly/yearly cost tracking
  - Calculate savings from self-consumption
  - Calculate revenue from surplus export
  - Net balance display (today's savings/cost)
- **Cost Analysis Widget**:
  - Real-time cost/savings display
  - 7-day, 30-day, 365-day trend charts
  - Breakdown: self-consumption vs. grid import
- **Version Management UI**:
  - Display global app version in frontend header
  - Show per-service versions in health monitor
  - Version compatibility indicator

---

## [0.1.1] - 2026-06-21

### Fixed
- **Log timestamp parsing**: Fixed "Invalid Date" errors in dashboard logs
  - Changed `LogEntry.timestamp` → `time` to match `RuntimeLogEntry` interface
  - Added backward compatibility migration for old logs with `timestamp` field
- **Log noise**: Filtered OCPP Heartbeat messages from logs
  - Only logs important events (BootNotification, StatusNotification, Authorize, StartTransaction, StopTransaction, MeterValues)
  - Reduces log spam from ~60 heartbeats/hour to meaningful state changes
  - Health monitoring still works independently via internal heartbeat tracking

### Added
- Version management infrastructure (groundwork for v0.2.0)

---

## [0.1.0] - 2026-06-19

### Summary
Foundation release with modular architecture, Modbus reconnection, and critical OCPP fixes.

### Added
- **Modbus Collector Reconnection**: Exponential backoff (5s → 120s) with 60s watchdog
  - Detects 3+ consecutive timeouts → forces disconnect + reconnect
  - Auto-recovery within 60s when offline
- **AI Skills Library**: Comprehensive documentation for future development
  - HUAWEI-IPC-STATE-MANAGEMENT.md: Field ownership, safe patterns
  - HUAWEI-MODBUS-COLLECTOR.md: Register map, reconnection logic
  - HUAWEI-OCPP-CHARGER.md: Protocol, smart charging modes, state persistence
  - HUAWEI-DOCKER-DEPLOYMENT.md: Monolith vs modular, Docker Compose
  - HUAWEI-DEBUGGING-CHECKLIST.md: 7 critical issues + systematic debugging
- **OCPP Debug Endpoint**: `/debug/ocpp` for manual raw OCPP calls
- **PV Alert Types**: Missing alerts in TelegramAlert interface (pv_disconnected, pv_reconnected, pv_string_loss)

### Fixed
- **CRITICAL**: Charger relay race condition in StopTransaction handler
- **CRITICAL**: TransactionId loss during intermediate charger states (Preparing, SuspendedEVSE, Unavailable)
- **CRITICAL**: OCPP message corruption after charger power loss (invalid timestamps, UTC/local mismatch)
  - Added sanitizePayloadForLogging() to safely handle NaN dates
- **Smart Probe Conflicts**: Disabled automatic probe on connection (now on-demand only)
  - Prevents firmware conflicts during charger initialization
- **Message Optimization**: Embed charging profile in RemoteStartTransaction to eliminate back-to-back messages

### Changed
- **Skills Migration**: Moved all project skills to `~/.claude/skills/` per VS Code best practices
- **Service Architecture**: Confirmed modular architecture as primary mode
- **YAML Frontmatter**: All skills now follow VS Code Agent Skills specification

### Deprecated
- Automatic smart probe on charger WebSocket connect (use `/api/charger/probe-smart` instead)

### Security
- None

---

## [0.0.1] - 2026-06-10

### Summary
Initial pre-release with modular services and file-based IPC.

### Added
- **Modular service architecture**: Split monolith into 3 independent services (collector, charger, dashboard)
- **File-based IPC**: Shared JSON state files in `storage/data/live-state-*.json`
  - Each service owns its own file (collector, charger, dashboard)
  - Each service loads all 3 files every 1s for consistency
- **OCPP 1.6 charger server** on port 9100
  - Smart charging modes: FAST / GREEN / HYBRID
  - BootNotification, StatusNotification, RemoteStartTransaction, StopTransaction
  - ChargingProfile management
- **Modbus TCP inverter collector**
  - Reads Huawei inverter data (power, voltage, frequency, etc.)
  - Registers: 0-100+ (PV, Grid, Battery, Meter)
  - Basic polling (1 Hz, no recovery logic)
- **Express API + Vite frontend**
  - Real-time dashboard (React)
  - API endpoints: `/api/charger`, `/api/inverter`, `/api/health`
  - WebSocket for live updates
- **Docker Compose**
  - Monolith mode (`--profile monolith`): All services in one container
  - Modular mode (`--profile modular`): 3 separate containers
  - Multi-stage Dockerfile with TypeScript compilation
- **InfluxDB integration**
  - Time-series historical data storage
  - Graphana dashboards (optional)
  - Backup/restore scripts
- **Telegram alerts**
  - PV disconnect/reconnect notifications
  - Battery low/high alerts
  - Charger status changes

### Known Limitations (Fixed in v0.1.0+)
- ❌ Modbus collector stuck offline without recovery mechanism
- ❌ OCPP timestamps corrupted after charger power loss
- ❌ TransactionId cleared during intermediate charger states
- ❌ Race conditions in StopTransaction handler
- ❌ Automatic smart probe on connect conflicts with charger firmware
- ❌ No exponential backoff for connection failures

### Docker Info
```bash
# Monolith (single container, all services)
docker compose --profile monolith up -d --build

# Modular (3 separate containers)
docker compose --profile modular up -d --build

# View logs
docker logs huawei-dashboard-service -f
docker logs huawei-collector-service -f
docker logs huawei-charger-service -f
```

---

## [0.0.0] - 2026-05-15 (Pre-release / Alpha)

### Summary
Initial monolithic prototype with manual charger control and MQTT integration (later replaced).

### Added
- **Monolithic architecture**: Single Node.js process running all logic
  - Modbus collector (polling inverter data)
  - Manual relay control for charger (GPIO or SSH)
  - Express API server
  - React frontend (Vite)
- **MQTT integration** (later replaced by file-based IPC in v0.0.1)
  - Publish inverter data to MQTT broker
  - Subscribe to charger control commands
  - Home automation bridge
- **Basic Modbus polling** (no reconnection logic)
  - Poll rate: 1 Hz
  - Reads: PV output, grid import/export, battery level
  - Issues: Hangs if connection lost, no auto-recover
- **Manual charger control**
  - GPIO relay trigger (Raspberry Pi)
  - SSH command to remote charger (MQTT)
  - No OCPP protocol (will be added in v0.0.1)
- **InfluxDB for historical data**
  - Store time-series metrics
  - Retention policies (1 year default)
  - Backup/restore utilities
- **Web dashboard**
  - Real-time power visualization (Recharts)
  - Manual charger on/off buttons
  - Log viewer
- **Docker containerization**
  - Single Dockerfile for monolith
  - Docker Compose with InfluxDB, Grafana

### Known Issues (Architecture Problems)
- ❌ MQTT dependency (external broker required)
- ❌ No OCPP protocol (charger control unreliable)
- ❌ Modbus stuck if connection lost
- ❌ All services in one process (no horizontal scaling)
- ❌ Single point of failure

### Migration Path
This version led to v0.0.1 refactor which:
1. Removed MQTT dependency
2. Added modular architecture
3. Implemented OCPP 1.6 server
4. Introduced file-based IPC

---

## Unreleased / Backlog

### Planned for v0.2.0 (Stability)
- [ ] Fix charger communication issue
- [ ] Add unit + integration tests
- [ ] Prometheus metrics export
- [ ] OpenAPI / Swagger documentation

### Planned for v0.3.0 (Smart Charging)
- [ ] Weather forecasting integration
- [ ] Smart charging recommendation engine
- [ ] Battery integration (Huawei, LG Resu)
- [ ] Analytics & reporting

### Planned for v1.0.0 (Production)
- [ ] OAuth 2.0 authentication
- [ ] RBAC (role-based access control)
- [ ] HTTPS + certificates
- [ ] Kubernetes deployment
- [ ] Mobile app (React Native)

### Planned for v2.0.0 (Ecosystem)
- [ ] Plugin system (WASM)
- [ ] Public REST API
- [ ] Webhook support
- [ ] Multi-language i18n

---

## Versioning Strategy

### Project Version (package.json)
Main application version following SemVer.

### Service Versions
Each service has its own logical version:
- **collector** (Modbus Inverter): v1.0.0
- **charger** (OCPP Server): v1.0.0
- **dashboard** (API + Frontend): v1.0.0

### How to Bump Version

```bash
# Update package.json version
npm version patch     # 0.1.0 → 0.1.1 (bugfixes)
npm version minor     # 0.1.0 → 0.2.0 (new features)
npm version major     # 0.1.0 → 1.0.0 (breaking changes)

# Commit and tag
git tag v0.2.0
git push origin v0.2.0
```

### Release Checklist

- [ ] Update CHANGELOG.md with all changes
- [ ] Bump package.json version
- [ ] Create git tag (`v0.x.y`)
- [ ] Update `SERVICE_VERSIONS` in backend/config/constants.ts (if changed)
- [ ] Test modular deployment: `docker compose --profile modular up -d --build`
- [ ] Run lint: `npm run lint`
- [ ] Test inverter, charger, and dashboard services
- [ ] Push to origin with tags: `git push origin master --tags`

