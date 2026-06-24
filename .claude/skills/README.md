# Huawei Dashboard Skills Index

This directory contains **specialized guides** (skills) designed to help AI agents and developers understand the HuaweiDashboard codebase, troubleshoot issues, and implement features correctly.

All skills use the **folder/SKILL.md structure** for auto-discovery by VS Code.

## When to Use These Skills

When an AI agent (Copilot, Claude, etc.) is helping you with this repository:

1. **Reference them in your prompts**: 
   > "Según huawei-modbus-collector skill, ¿por qué el collector..."
   > "Using the IPC skill, explain how field ownership works..."

2. **They'll be auto-loaded into context** when the agent detects this repository

3. **Use them as checklists** for debugging or implementing new features

---

## 📚 Skills Reference

### huawei-ipc-state-management/
**For understanding inter-process communication between services**

- How the file-based IPC works (live-state-*.json)
- Field ownership rules (prevents "Guerra de Archivos")
- Safe patterns for loadLiveState() and saveLiveState()
- Debugging state inconsistencies
- Future scalability options (Redis, gRPC, MQTT)

**Read this when**:
- Adding new shared state fields
- Debugging data that disappears mysteriously
- Implementing a new service
- Fixing race conditions

---

### huawei-modbus-collector/
**For everything about Modbus polling and reconnection logic**

- Service lifecycle (startup → polling → reconnection)
- Register map (what data comes from which register)
- **NEW**: Exponential backoff reconnection system
- Watchdog monitoring (automatic recovery)
- Port rotation and timeout handling
- PV status monitoring and alerts
- History persistence (JSONL daily files)
- Debugging checklist for connection issues

**Read this when**:
- Collector shows offline
- Adding new Modbus registers to monitor
- Tuning polling intervals
- Understanding the new auto-reconnection fix

---

### huawei-ocpp-charger/
**For OCPP 1.6 protocol and smart charging modes**

- OCPP message types (BootNotification, SetChargingProfile, RemoteStart, etc.)
- Smart charging modes: FAST, GREEN, HYBRID
- Charging profile structure and limits
- State persistence and reconciliation
- Anti-loop protection
- Smart probe for charger capability detection
- Integration with inverter data (solar-aware charging)
- Debugging checklist for charger issues

**Read this when**:
- Charger won't connect
- Smart charging modes not working correctly
- Understanding how solar surplus is calculated
- Implementing new OCPP features

---

### huawei-docker-deployment/
**For containerization and deployment**

- Monolith vs Modular deployment modes
- Docker Compose profiles and services
- Dockerfile multi-stage build process
- Volume management and data persistence
- Environment variables in Docker
- Common deployment tasks (logs, restart, troubleshoot)
- Scaling considerations for multiple inverters
- Port conflicts and networking issues

**Read this when**:
- Setting up Docker for the first time
- Switching deployment modes
- Troubleshooting containerized deployments
- Implementing CI/CD pipeline

---

### huawei-debugging-checklist/
**Systematic troubleshooting guide for any issue**

- General debugging workflow (is it running? → check logs → inspect state)
- 7 critical issues with root causes and fixes:
  1. Collector offline / no data
  2. Charger offline
  3. State file corruption
  4. History not recorded
  5. Dashboard shows cached/old data
  6. Charger won't start
  7. PV alerts not working
- Quick reference command guide
- When to ask for help

**Read this when**:
- System behaving unexpectedly
- Need a structured debugging approach
- Something stopped working and you don't know why

---

## 🔍 How Skills Are Organized

Each skill follows this structure:

```
[TITLE]
  ↓
Purpose (when to use this skill)
  ↓
Detailed explanation / architecture
  ↓
Code patterns & examples
  ↓
Debugging checklists
  ↓
Key files (links to relevant source)
```

---

## 🧠 For AI Agents / LLMs

These skills are designed to be **machine-readable** and provide:

1. **Precise context** for the codebase (architecture, patterns, gotchas)
2. **Checklists** for verification and troubleshooting
3. **Code examples** showing correct patterns
4. **Field ownership tables** for understanding data flow
5. **Links to source files** for deep dives

When working on this repo, you should:
- Read the relevant skill before writing code
- Follow the patterns described (exponential backoff, atomic writes, field ownership)
- Use the debugging checklist if something fails
- Reference the skill in your explanations to users

---

## 🎯 Quick Navigation

| Need Help With? | Read This Skill |
|---|---|
| Adding new Modbus register | HUAWEI-MODBUS-COLLECTOR.md |
| Understanding state sharing between services | HUAWEI-IPC-STATE-MANAGEMENT.md |
| Implementing new OCPP message | HUAWEI-OCPP-CHARGER.md |
| Deploying to production | HUAWEI-DOCKER-DEPLOYMENT.md |
| Collector is offline | HUAWEI-DEBUGGING-CHECKLIST.md → Issue #1 |
| Charger won't start | HUAWEI-DEBUGGING-CHECKLIST.md → Issue #6 |
| Data disappears mysteriously | HUAWEI-IPC-STATE-MANAGEMENT.md + Debugging Issue #3 |
| Everything broken | HUAWEI-DEBUGGING-CHECKLIST.md → General Workflow |

---

## 📖 Example Usage in Prompts

**Before changes**:
```
According to HUAWEI-IPC-STATE-MANAGEMENT.md, I need to add a new field 
`supplyMarginW` to the shared state. Which service should own it? 
How do I implement saveLiveState() correctly?
```

**After deployment**:
```
Using HUAWEI-DOCKER-DEPLOYMENT.md, help me set up the modular deployment 
and configure environment variables for my setup.
```

**During debugging**:
```
Following HUAWEI-DEBUGGING-CHECKLIST.md Issue #1, the collector is offline. 
I've verified the IP, checked firewall... what's the next step?
```

---

## 🔄 Keeping Skills Updated

As the codebase evolves, skills should be updated:

1. **New feature implemented** → Update relevant skill with pattern
2. **Bug fixed** → Document the fix in debugging section
3. **Architecture change** → Create new skill or update existing
4. **Lessons learned** → Add to appropriate skill

Skills are **living documentation** that grow with the project.

---

## 📝 Contributing New Skills

To create a new skill:

1. Identify the **domain** (e.g., "Telegram Alerting")
2. Create file: `HUAWEI-[DOMAIN].md`
3. Follow this structure:
   - Purpose statement
   - Architecture overview
   - Code patterns
   - Debugging checklist
   - Key files
4. Update this index
5. Reference from Agents.md if applicable

---

## 🔗 Related Documentation

- [Agents.md](../Agents.md) → Project architecture & historical lessons
- [README.md](../README.md) → Installation, configuration, usage
- [docker-compose.yml](../docker-compose.yml) → Deployment modes
- [backend/](../backend/) → Source code

---

**Last Updated**: 2026-06-19  
**Skills Version**: 1.0 (initial creation for Modbus reconnection fix)
