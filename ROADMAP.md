# HuaweiDashboard - Product Roadmap

## Vision

Transform home solar + car charging into an intelligent, self-learning energy management system that maximizes self-consumption and minimizes grid dependency. The system learns user patterns, predicts demand, and optimizes charging schedules in real-time.

---

## Current Status

**v0.1.0** (2026-06-19)
- ✅ Modular architecture (3 independent services)
- ✅ Modbus collector with exponential backoff recovery
- ✅ OCPP 1.6 charger with smart modes (FAST/GREEN/HYBRID)
- ✅ Real-time dashboard with health monitoring
- ⚠️ **Charger communication broken** (root cause TBD)

---

## 📌 Roadmap by Version

### [DevOps Phase 1] - Automated Multi-Arch Docker Build & Publication (In Progress)

**Goal**: Establish a professional CI/CD pipeline with automated code validation, multi-architecture Docker builds, and secure publication to GitHub Container Registry (GHCR).

#### 🔄 CI/CD Pipeline Setup
- [x] **Add**: GitHub Actions workflow for code validation
  - Lint TypeScript/JavaScript (ESLint)
  - Type checking (if configured)
  - Dockerfile validation (Hadolint)
  - Cached dependency installation (pnpm)
- [x] **Add**: Multi-architecture Docker build system
  - Setup QEMU for cross-compilation
  - Configure Docker Buildx
  - Build for `linux/amd64` (x86_64) and `linux/arm64` (Raspberry Pi, ARM servers)
  - GitHub Actions layer caching (type=gha) for efficiency
- [x] **Add**: Secure image publication to GHCR
  - Automatic authentication with `GITHUB_TOKEN`
  - Semantic versioning: `latest` tag for main/master, `vX.Y.Z` for git tags
  - Image digest and metadata tracking
  - Automatic image tagging by branch/tag/commit SHA

#### 📋 Implementation Details
- **Workflow File**: `.github/workflows/build-and-push.yml`
- **Triggers**: Push to main/master, git tags (v*), pull requests
- **Permissions**: `contents: read`, `packages: write`
- **Supported Platforms**: 
  - `linux/amd64` - Intel/AMD servers and desktops
  - `linux/arm64` - Raspberry Pi 4/5, ARM servers

#### 🎯 Benefits
- Automated validation prevents broken code from being deployed
- Multi-architecture support enables Raspberry Pi deployments (future)
- Cached builds reduce CI/CD execution time
- Semantic versioning enables easy rollback/testing of specific releases
- GHCR provides private container registry without external dependencies

#### ⏱️ Timeline
- ✅ Complete: Workflow configuration and testing
- ⏳ Next: Integrate with deployment automation (Phase 2)

---

### [v0.2.0] - Stability & Debugging (Q3 2026)

**Goal**: Fix charger communication issue and establish stable baseline.

#### 🔧 Critical Fixes
- [ ] **Fix**: Restore charger-dashboard communication
  - Use RECOVERY_GUIDE.md to diagnose
  - Verify OCPP WebSocket on port 9100
  - Test IPC state sync across all services
  - Add integration tests for charger endpoints
- [ ] **Add**: Unit tests for IPC state management
- [ ] **Add**: Integration test suite for modular deployment
- [ ] **Add**: Charger connection health monitoring with alerts

#### 📈 Observability
- [ ] **Add**: Prometheus metrics export endpoint
  - Track: collector connection state, charger transactions, API response times
- [ ] **Add**: Structured logging with correlation IDs across services
- [ ] **Improve**: Dashboard logs view with filtering/searching

#### 📚 Documentation
- [ ] **Add**: Deployment guide (AWS EC2, local Docker, Kubernetes)
- [ ] **Add**: API documentation (OpenAPI/Swagger)
- [ ] **Add**: Troubleshooting runbook (FAQ + common errors)

#### ⏱️ Timeline
- Weeks 1-2: Fix charger issue + tests
- Weeks 3-4: Metrics + logging improvements
- Weeks 5-6: Documentation + release v0.2.0

---

### [v0.3.0] - Smart Charging (Q4 2026)

**Goal**: Implement AI-driven charging decisions based on solar production forecasts.

#### 🤖 Intelligence
- [ ] **Add**: Weather-based PV generation forecast integration
  - Import solar radiation predictions (OpenWeather, DWD)
  - Calculate expected PV output for next 24h
- [ ] **Add**: Smart charging recommendation engine
  - Predict grid demand patterns
  - Suggest optimal charging windows
  - Set charging profiles based on forecast + battery SoC
- [ ] **Add**: User preference profiles (eco/normal/fast modes)
  - Remember user charging habits
  - Auto-adjust based on historical data

#### 🔋 Battery Integration
- [ ] **Support**: Huawei battery (LG Resu, CATL)
  - Read battery SoC, capacity, discharge rates
  - Include in charging decision logic
  - Set charge/discharge schedules

#### 📊 Analytics
- [ ] **Add**: Dashboard charts
  - Daily self-consumption rate (%)
  - Savings vs. grid import (€)
  - Charging efficiency per session
- [ ] **Add**: Export reports (CSV, PDF)

#### ⚙️ Settings & Configuration (NEW FEATURE)
- [ ] **Add**: Configuration menu in dashboard
  - Settings icon/button in UI header
  - Modal/sidebar for user preferences
- [ ] **Add**: Electricity pricing parameters
  - `gridPricePerKwh`: Price paid for grid import (€/kWh)
  - `feedinTariff`: Compensation for surplus export (€/kWh)
  - `currency`: Currency symbol (€, $, etc.) for display
  - Persist configuration to `storage/data/user-config.json`
- [ ] **Add**: Cost tracking with configurable rates
  - Calculate daily/weekly/monthly/yearly spend vs. savings
  - Track cost of grid imports
  - Track revenue from surplus exports
  - Display net balance (savings/cost) in dashboard
- [ ] **Add**: Configuration validation
  - Ensure values are positive numbers
  - Warn if prices seem unreasonable (e.g., > €1/kWh)
  - Default fallback values if not configured
- [ ] **Add**: Cost analytics dashboard widget
  - Display "Today's Cost": grid imports cost - surplus revenue
  - Show cumulative "Weekly Savings", "Monthly Savings", "Yearly Savings"
  - Breakdown by source: PV self-consumption vs. grid import
  - Chart: Daily cost trend over time

#### 🎯 Implementation Details
- **Data Storage**: Create `storage/data/user-config.json`
  ```json
  {
    "gridPricePerKwh": 0.25,
    "feedinTariff": 0.12,
    "currency": "€",
    "lastUpdated": "2026-06-19T16:00:00Z"
  }
  ```
- **Calculation Logic**: Add to `backend/utils/stats.ts`
  - `calculateDailyCost(inverterData, config)` → €/day
  - `calculateWeeklySavings(history, config)` → total for week
  - `calculateMonthlySavings(history, config)` → total for month
  - `calculateYearlySavings(history, config)` → total for year
- **Frontend Widget**: New React component `CostAnalyticsWidget.tsx`
  - Display cost/savings in real-time
  - Show 7-day, 30-day, 365-day trends
  - Update every time `live-state-collector.json` changes

#### ⏱️ Timeline
- Weeks 1-2: Settings menu + config storage (API + UI)
- Weeks 3-4: Cost calculation logic + tests
- Weeks 5-6: Analytics widget + charts
- Weeks 7-8: Reports export (CSV/PDF)
- Release v0.3.0 (end Q4)

---

### [v0.4.0] - Grid Interaction (Q1 2027)

**Goal**: Support grid services participation (demand response, frequency support).

#### 🌐 Grid Features
- [ ] **Add**: Demand response protocol support (DR, OpenADR 2.0b)
- [ ] **Add**: Frequency support mode (charger helps stabilize grid at 49.8-50.2 Hz)
- [ ] **Add**: Time-of-use (ToU) electricity rates integration
  - Fetch rates from utility provider
  - Adjust charging based on price signals

#### 💰 Revenue Streams
- [ ] **Track**: Money earned from grid services participation
  - DR compensation
  - Frequency support rewards
  - ToU bill reduction
- [ ] **Add**: Dashboard widget showing estimated monthly revenue

#### ⏱️ Timeline
- Weeks 1-4: OpenADR 2.0b protocol implementation
- Weeks 5-6: Frequency support mode
- Weeks 7-8: Revenue tracking
- Release v0.4.0

---

### [v1.0.0] - Production Ready (Q2 2027)

**Goal**: Stable, secure, scalable system ready for commercial deployment.

#### 🔒 Security & Compliance
- [ ] **Add**: OAuth 2.0 / OpenID Connect authentication
- [ ] **Add**: Role-based access control (RBAC)
  - Admin, User, Guest roles
  - Fine-grained permission control
- [ ] **Add**: HTTPS with self-signed or Let's Encrypt certificates
- [ ] **Add**: Input validation + SQL injection prevention (if DB is used)
- [ ] **Add**: Audit logging (who did what, when)
- [ ] **Compliance**: GDPR data privacy (data retention policies, export/delete)

#### 📈 Scalability
- [ ] **Replace**: IPC file-based state → Redis cluster
- [ ] **Replace**: Single-instance API → Load-balanced API tier (3+ instances)
- [ ] **Add**: Database (PostgreSQL) for historical data
  - Time-series data: Prometheus/InfluxDB
  - User data: PostgreSQL
- [ ] **Add**: Message queue (RabbitMQ/Kafka) for event streaming

#### 🚀 Deployment
- [ ] **Add**: Kubernetes manifests (Helm charts)
- [ ] **Add**: CI/CD pipeline (GitHub Actions)
  - Lint, test, build, push to registry, deploy
  - Automatic staging → production promotion
- [ ] **Add**: Multi-region deployment support (EU, US, APAC)

#### 📱 User Experience
- [ ] **Add**: Mobile app (React Native / Flutter)
- [ ] **Add**: Push notifications for alerts
- [ ] **Add**: Siri / Google Assistant voice control
- [ ] **Add**: Dark mode

#### ⏱️ Timeline
- Weeks 1-4: Security + RBAC + HTTPS
- Weeks 5-8: Database + Redis migration
- Weeks 9-12: Kubernetes + Helm + CI/CD
- Weeks 13-14: Mobile app MVP
- Release v1.0.0

---

### [v2.0.0] - Ecosystem (Q4 2027+)

**Goal**: Open ecosystem for third-party integrations.

#### 🔌 Integrations
- [ ] **Add**: Plugin architecture (WASM modules)
  - Community can write custom charging algorithms
  - Third-party integrations (home automation, EVs, utilities)
- [ ] **Add**: REST API versioning (v1, v2, v3...)
  - Stable public API for ecosystem
- [ ] **Add**: Webhook support (events → external systems)
  - Trigger actions on charger/inverter state changes

#### 💾 Data Sharing
- [ ] **Add**: Data export (API keys, webhooks)
  - Let users share telemetry with utility, researchers, etc.
- [ ] **Add**: Privacy controls (opt-in/out per data stream)

#### 🌍 Multi-Language / Regional
- [ ] **Support**: i18n (English, German, Spanish, French, Dutch)
- [ ] **Support**: Regional electricity market interfaces (REMIT data)

#### ⏱️ Timeline
- Q4 2027+: Design + build plugin system + API

---

## 🐛 Known Issues & Technical Debt

### Critical (Do ASAP)
- **[0.2.0]** Charger communication broken (root cause TBD)
  - See RECOVERY_GUIDE.md for diagnosis steps
  - Likely: port 9100 not listening OR import errors from skills migration

### High Priority
- **[0.2.0]** IPC file-based state is fragile
  - Race conditions if services write simultaneously
  - No atomic operations
  - File locking mechanism needed (or switch to Redis)
- **[0.2.0]** No integration tests for modular deployment
  - Hard to catch bugs that only happen with 3 services running
- **[0.3.0]** Modbus register map is incomplete
  - Missing some SCharger registers (power factor, efficiency)
  - Need to update after charger firmware update

### Medium Priority
- **[0.3.0]** OCPP message queueing not robust
  - If dashboard crashes while charger is sending, messages are lost
  - Need persistent queue (Redis/RabbitMQ)
- **[0.4.0]** Dashboard UI is not mobile-friendly (yet)
- **[0.4.0]** No dark mode

### Low Priority
- **[1.0.0]** Package.json has old name (`react-example` → `huawei-dashboard`) - fixed in v0.1.0
- **[2.0.0]** Modular architecture assumes all services on same machine
  - Multi-machine deployment needs Redis + distributed locking

---

## 📚 Architectural Improvements (Future)

### Replace File-Based IPC with Message Bus (v0.2.0 or v1.0.0)

**Current**:
```
Collector ──→ live-state-collector.json ←── Dashboard
Charger ──→ live-state-charger.json ←── Dashboard
Dashboard ──→ live-state-dashboard.json
```

**Target** (v1.0.0):
```
Collector ──→ MQTT/Redis Bus ←── Dashboard
Charger ──→ MQTT/Redis Bus
Dashboard ──→ MQTT/Redis Bus
```

**Why**: Atomic operations, real-time subscriptions, multi-machine support, better observability.

---

### Centralize State with Database (v1.0.0+)

**Current**:
- Real-time state: JSON files
- Historical data: InfluxDB

**Target**:
- Real-time state: Redis (in-memory)
- Persistent state: PostgreSQL (user config, audit logs)
- Historical data: InfluxDB / TimescaleDB (time-series)

**Why**: ACID compliance, easier backups, multi-instance consistency, analytics queries.

---

### API-First Design (v0.2.0+)

**Current**:
- Tight coupling between services (internal IPC)
- No versioned API contract

**Target**:
- REST API (OpenAPI 3.0) for inter-service communication
- Each service exposes stable, versioned endpoints
- Dashboard can switch charger → charger-v2 without code changes

**Why**: Loose coupling, independent scaling, easier testing.

---

## 📈 Success Metrics

### Reliability
- Uptime: > 99% (only maintenance downtime)
- Charger connection stability: > 99.5% (auto-reconnect within 60s on failures)
- Message delivery: No lost transactions (persistent queue)

### Performance
- Dashboard response time: < 200ms (p95)
- Charger OCPP message latency: < 100ms
- Collector Modbus poll rate: 1 Hz (1s per cycle)

### User Engagement
- Monthly active users: 100+ (by v1.0.0)
- Average session duration: > 5 minutes
- User retention: > 80% (month-over-month)

### Business
- User satisfaction: > 4.5 / 5 stars
- Support tickets per user: < 0.1 / month
- Community contributions: 10+ plugins by v2.0.0

---

## 🗺️ Implementation History (Reverse Chronological)

### Completed (✅)

#### v0.1.0 (2026-06-19)
- Modbus collector exponential backoff recovery
- OCPP critical race condition fixes
- AI skills library (5 comprehensive guides)
- PV alert types
- Smart probe disabled on auto-connect

#### v0.0.1 (2026-06-10)
- Initial modular architecture
- IPC via shared JSON files
- OCPP 1.6 server basics
- Modbus TCP collector
- Express API + Vite frontend
- Docker Compose (monolith + modular)
- InfluxDB integration
- Telegram alerts

#### Pre-v0.0.1 (May-June 2026)
- Monolithic architecture (all services in one process)
- Manual charger relay control (no OCPP)
- Manual MQTT integration (later replaced with IPC)
- Basic Modbus polling (no reconnection logic)

---

## 🤝 Contributing to Roadmap

To propose new features or issues:

1. **Check existing items** in this roadmap first
2. **Open a GitHub issue** with:
   - Clear description + motivation
   - Proposed version (or "Backlog" if unsure)
   - Estimated effort (small/medium/large)
3. **Link to roadmap** in the PR when ready to implement
4. **Update CHANGELOG.md** under [Unreleased] when merged

---

## 📞 Questions?

- **Architecture questions**: See `Agents.md`
- **Debugging help**: See `RECOVERY_GUIDE.md` + `SESSION_LOG_2026-06-19.md`
- **AI-assisted development**: See `_skills/` (moved to `~/.claude/skills/`)
- **Current version**: `npm run version:show`
