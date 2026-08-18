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

## [Unreleased]

### Planned
- Message broker integration (MQTT/Redis) for real-time telemetry
- OpenAPI / Internal gRPC for inter-service communication

## [0.1.9] - 2026-08-18

### Fixed
- Prevented Telegram false positives during night-time or no-solar periods by requiring recent daylight evidence before confirming PV or Modbus disconnection alerts.

### Added
- Added a regression test for stale running inverter states with zero PV readings.
- Refreshed the HuaweiDashboard troubleshooting, deployment, IPC, Modbus, OCPP, recovery, and release skill guides.

---

## [0.1.8] - 2026-07-31

### Added
- Custom solar-energy favicon, including the supplied PNG artwork, and web app manifest for browser and installed-app identity.

### Fixed
- Replaced the generic Google AI Studio browser title and icon with HuaweiDashboard branding.

### Changed
- Updated the dashboard service from `1.0.0` to `1.0.1`.

---

## [0.1.7] - 2026-07-31

### Added
- Deterministic unit tests for PV alert detection, covering startup, sunset, standby, transient failures, stale readings, persistent faults, recovery, and Huawei alarm 2015.
- Structured `[PV_ALERT_DIAGNOSTIC]` records with the complete telemetry sample, applied thresholds, reading freshness, inverter state, triggering reason, and confirmation duration.

### Changed
- Extracted PV alert evaluation into an isolated state monitor to make time-dependent behavior reproducible and testable without Modbus or Telegram.
- Updated the collector service from `1.1.0` to `1.2.0`.

### Fixed
- Stale readings now interrupt the continuous confirmation period instead of contributing toward a PV alert.

---

## [0.1.6] - 2026-07-30

### Fixed
- **Photovoltaic alert false positives**: Require fresh readings and persistent confirmation before notifying about PV disconnections, recoveries, or string-loss alarms. Expected inverter standby states and startup transitions are ignored.

### Changed
- Added configurable confirmation windows, freshness limits, startup grace period, and Telegram alert throttling.
- Updated PV alert messages to describe confirmed inverter telemetry instead of asserting a specific electrical fault.

## [0.1.5] - 2026-06-24

### Fixed
- **CRITICAL: ClearChargingProfile parser crash** - Huawei charger firmware parser crashes when `ClearChargingProfile` is sent with empty payload `{}` or missing required fields (id, connectorId, chargingProfilePurpose). This was blocking HYBRID and GREEN charging modes. Now sends explicit JSON structure matching Huawei parser expectations.
  - Impact: Fixes charger blocking state that prevented any charging after profile operations
  - Root cause: C++ parser expects fields at fixed line offsets; any omission causes deserialization failure
  - Solution: Replace `{}` with explicit `{ id: 100, connectorId: 0, chargingProfilePurpose: "TxDefaultProfile" }` in both `clearChargingLimit()` and smart-charging-disabled path

### Changed
- `clearChargingLimit()` now includes explicit `id: 100` field when clearing TxDefaultProfile

---

## [0.1.4] - 2026-06-24

### Fixed
- **Watchtower version tag**: Corrected from non-existent `v1.18.1` to `:latest` (only tag published by nicholas-fedor in GHCR)
- Updated docker-compose comments to clarify GHCR fork only publishes `:latest` tag

---

## [0.1.3] - 2026-06-24

### Fixed
- **Watchtower image reference**: Corrected from `nickfedor/watchtower` to proper GHCR registry path `ghcr.io/nicholas-fedor/watchtower`

---

## [0.1.2] - 2026-06-24

### Added
- **CI/CD Pipeline**: GitHub Actions workflow for multi-architecture Docker builds (linux/amd64, linux/arm64)
- **GHCR Publication**: Automated image push to GitHub Container Registry with semantic versioning:
  - `latest` tag for main/master branch
  - `vX.Y.Z` tags for git release tags
  - SHA commit hash for traceability
- **Watchtower Integration**: GitOps-style automatic image updates. Checks registry every 10 minutes and pulls latest images
- **pnpm Configuration**: Moved to `.pnpmrc` with `only-built-dependencies` setting for proper build dependency handling
- **Build Validation**: Added ESLint, TypeScript type-check, and Hadolint checks to validation job

### Changed
- **Dockerfile**: Replaced npm-based pnpm installation with corepack (native Node.js 16+ tool)
- **docker-compose.yml**: Switched from local `build: .` to GHCR image references (`ghcr.io/colinburgess/huaweidashboard:latest`)
- **pnpm Setup**: Official `pnpm/action-setup@v4` action with auto-detection of version from `packageManager` field
- **Project Structure**: Removed `pnpm-workspace.yaml` (project is not a true monorepo; single package.json at root)

### Fixed
- **GitHub Actions**: pnpm cache now properly configured via `setup-node@v4` `cache: 'pnpm'` parameter
- **Deprecated Configuration**: Moved `pnpm.onlyBuiltDependencies` from package.json to `.pnpmrc` (package.json field is no longer read by pnpm v9+)
- **Dockerfile References**: Removed non-existent `pnpm-workspace.yaml` from COPY commands in builder and final stages

### DevOps Benefits
- **No Local Docker Rebuild**: Production environments pull images directly from GHCR
- **Automatic Updates**: Watchtower keeps containers synchronized with latest published image
- **Multi-Architecture Support**: Same image works on x86_64 and ARM64 architectures
- **Reproducibility**: Exact pnpm version (9.12.0) enforced across CI/CD and local development
- **Disk Efficiency**: Watchtower cleanup flag removes old images to save storage space

---

## [0.1.1] - 2026-06-19 (Previous)

### Fixed
- **CRITICAL**: Eliminated false Telegram alerts about inverter disconnection during Standby mode. Now reads device status register (32089) to differentiate between:
  - **Standby states (0-3)**: Normal sleep mode when no solar irradiance (night, cloudy). Modbus timeouts expected. Alerts suppressed.
  - **Running states (512-515)**: Normal operation. Modbus timeouts now properly trigger disconnection alerts.
  - **Shutdown states (768-771)**: Faults or alarms. Alerts enabled.
  - SmartDongle behavior clarified: Loses TCP connectivity when inverter CPU powered down (no battery), which is expected with SUN2000 + SmartDongle configuration.
- **ENHANCEMENT**: Added secondary device-status.jsonl log file (separate from main logs) to track inverter state transitions without polluting main logs. Useful for diagnosing state changes and troubleshooting.
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
