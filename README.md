# ☀️ Huawei SUN2000 & EV Dashboard 🚗

![Dashboard Banner](./frontend/assets/banner_readme.png)

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen)](https://nodejs.org/)
[![Docker Support](https://img.shields.io/badge/Docker-Supported-blue)](https://www.docker.com/)
[![React 19](https://img.shields.io/badge/React-19-cyan)](https://react.dev/)
[![Tailwind 4](https://img.shields.io/badge/Tailwind-4-blueviolet)](https://tailwindcss.com/)

**Dashboard residencial premium para monitorizar inversores Huawei SUN2000 y controlar cargadores EV vía OCPP 1.6.**

[Report Bug](https://github.com/ColinBurgess/HuaweiDashboard/issues) · [Request Feature](https://github.com/ColinBurgess/HuaweiDashboard/issues)

</div>

---

### 🚀 Funciones Principales

*   **⚡ Telemetría en tiempo real**: Monitorización del inversor vía Modbus TCP.
*   **🔋 Control Inteligente EV**: Modos `FAST`, `GREEN` (100% solar) y `HYBRID`.
*   **📊 Estadísticas Avanzadas**: Cálculo de kWh y balance energético estilo FusionSolar.
*   **📦 Arquitectura Modular**: Desacoplado en microservicios mediante Docker.
*   **🏥 System Health Monitor**: Panel de salud en tiempo real para supervisar cada servicio.
*   **📜 Logs Unificados**: Stream centralizado de logs de todos los servicios con origen identificado.
*   **🛡️ Persistencia Robusta**: Histórico, logs y estados protegidos ante reinicios.

## Arquitectura Modular

El proyecto ha evolucionado de un monolito a una arquitectura desacoplada que puede ejecutarse en servicios independientes mediante **Docker Compose**. Esto garantiza que la recogida de datos (Inversor/Cargador) sea ininterrumpida incluso si se reinicia la interfaz web.

### Componentes:
- **Inverter Collector**: Proceso dedicado al polling Modbus y registro de histórico.
- **Charger Service**: Servidor OCPP 1.6 independiente.
- **Dashboard UI**: Interfaz web (React) y API de consulta.

### Comunicación Inter-procesos (IPC)
Los servicios se comunican mediante **archivos de estado separados por servicio**:

- `storage/data/live-state-collector.json`: telemetría y estado del inversor.
- `storage/data/live-state-charger.json`: estado del cargador.
- `storage/data/live-state-dashboard.json`: comandos del usuario.

Cada proceso es el único propietario y escritor de su archivo. Aproximadamente cada segundo carga los archivos de los otros servicios, combina sus datos en memoria e ignora su propio archivo para evitar sobrescribir estado vivo con información persistida antigua. Las escrituras son atómicas y este aislamiento evita colisiones entre procesos sin depender de una base de datos externa.

## Capacidades principales

- Monitorización en tiempo real de producción solar, red, batería, temperatura y consumo doméstico.
- Visualización del flujo energético y gráfico de potencia vs consumo.
- **Módulo de Estadísticas**: Balance energético detallado (kWh) con gráficos de donuts estilo FusionSolar (Producción vs Consumo).
- **System Health Monitor**: Visualización del estado de salud, latidos (heartbeats) y detalles operativos de cada servicio modular desde el propio Dashboard.
- **Unified Log Stream**: Los logs de todos los procesos se centralizan en la UI, diferenciados por colores y etiquetas de origen (`charger`, `collector`, `dashboard`).
- Histórico diario persistente en `storage/history/YYYY-MM-DD.jsonl`.
- Logs de sesión persistentes en `storage/logs/YYYY-MM-DDTHH-MM-SSZ.jsonl`.
- Registro combinado de logs en tiempo real en `storage/logs/combined.jsonl`.
- Persistencia de estado del cargador en `storage/data/charger-state.json`.
- Control EV con modos FAST, GREEN y HYBRID.
- Reconciliación automática tras reinicios o reconexiones OCPP.
- Protección anti-loop ante `StopTransaction(reason=Other)` repetidos.
- Soporte de límites OCPP tanto en amperios como en vatios según lo que soporte el cargador.
- Precarga en la UI del histórico del día actual para que la vista Live no parezca vacía tras reiniciar.
- Manejo endurecido de reconexiones OCPP para evitar que sockets obsoletos desarmen el control inteligente.
- **Contexto para IA**: Archivo `Agents.md` con guía de arquitectura para facilitar la transferencia entre sesiones de asistentes AI.
- **Seguridad en Despliegue**: Verificación automática de tipos (Lint/TypeScript) antes de cada build de Docker.

## Requisitos previos

- Node.js 22 o superior (o 20 como mínimo).
- pnpm 9 o superior (gestor de dependencias optimizado).
- Inversor Huawei SUN2000 con Modbus TCP habilitado y accesible en red local.
- Cargador EV compatible con OCPP 1.6.
- Acceso a red local hacia el inversor y el cargador.

## Instalación

```bash
pnpm install
```

Nota: Si prefieres usar npm, puedes hacerlo (es compatible), pero recomendamos pnpm por su mayor velocidad (~2x más rápido), menor tamaño de dependencias y mejor resolución de dependencias.

## Configuración

Puedes partir de `.env.example` y ampliarlo según necesites.

Variables disponibles actualmente:

### General

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `3001` | Puerto HTTP del dashboard si no se usa `APP_PORT` |
| `APP_PORT` | `3001` | Puerto HTTP principal de la app |
| `MODBUS_HOST` | `192.168.1.140` | IP del inversor o del dongle |
| `MODBUS_PORTS` | `502,6607` | Puertos Modbus a probar en orden |
| `MODBUS_PORT` | `502,6607` | Compatibilidad con configuración antigua de un solo puerto |
| `MODBUS_HAS_BATTERY` | `false` | Si el inversor tiene batería integrada |

### Alertas por Telegram (Opcional)

El dashboard puede enviar notificaciones automáticas a Telegram para eventos críticos:

**Alertas del Inversor**:
- ⚠️ Desconexión Modbus (ej: diferencial saltado, error de red)
- ✅ Reconexión exitosa

**Alertas de Paneles Solares (PV)**:
- ⚠️ Pérdida de conexión PV (automático de entrada solar saltado)
- ✅ Restauración de conexión PV
- ⚠️ Pérdida de string solar detectada (Alarm ID: 2015)

**Configuración**:

| Variable | Descripción |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token del bot (obtenido de @BotFather) |
| `TELEGRAM_CHAT_ID` | ID del grupo o chat privado |
| `TELEGRAM_ALERTS_ENABLED` | `true` o `false` para activar/desactivar |
| `TELEGRAM_ALERT_THROTTLE_MS` | Intervalo mínimo entre alertas del mismo tipo (por defecto, 30 minutos) |
| `PV_ALERT_STARTUP_GRACE_MS` | Tiempo sin evaluar cambios tras arrancar (por defecto, 60 segundos) |
| `PV_ALERT_DISCONNECT_CONFIRM_MS` | Persistencia exigida para confirmar pérdida PV (por defecto, 3 minutos) |
| `PV_ALERT_RECONNECT_CONFIRM_MS` | Persistencia exigida para confirmar recuperación (por defecto, 1 minuto) |
| `PV_ALERT_STRING_LOSS_CONFIRM_MS` | Persistencia exigida para confirmar la alarma 2015 (por defecto, 1 minuto) |
| `PV_ALERT_STATUS_MAX_AGE_MS` | Antigüedad máxima aceptada para una lectura de estado (por defecto, 15 segundos) |

**Cómo configurar Telegram**:

1. **Crear el bot**:
   - Abre Telegram y busca a `@BotFather`
   - Escribe `/newbot` y sigue las instrucciones
   - Guarda el **token** que te proporciona

2. **Crear un grupo** (para ambos recibir alertas):
   - Crea un grupo privado en Telegram
   - Añade a tu pareja/familia que quiera recibir alertas
   - Añade el bot al grupo

3. **Obtener el Chat ID** (2 opciones):
   - **Opción A (Automática)**: Ejecuta el script helper:
     ```bash
     pnpm tsx backend/scripts/get_telegram_chat_id.ts
     ```
     Envía un mensaje al bot en Telegram y el script te mostrará tu Chat ID.

   - **Opción B (Manual)**: Invita el bot al grupo y consulta los logs del dashboard para ver el `TELEGRAM_CHAT_ID`.

4. **Actualizar .env**:
   ```env
   TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
   TELEGRAM_CHAT_ID=-1001234567890
   TELEGRAM_ALERTS_ENABLED=true
   ```

**Testing de Alertas**:

Para verificar que tu configuración de Telegram funciona correctamente, ejecuta:

```bash
# Desarrollo
pnpm tsx backend/scripts/test_telegram_alerts.ts

# Producción (en Docker)
docker compose exec inverter-collector pnpm tsx backend/scripts/test_telegram_alerts.ts
```

Este script enviará todas las alertas disponibles a tu Telegram para verificar que está todo configurado.

**Nota**: Las alertas PV se confirman durante varios ciclos, ignoran el estado nocturno de espera y descartan lecturas obsoletas. Las recuperaciones solo se notifican después de una pérdida confirmada. Además, las alertas del mismo tipo tienen por defecto un intervalo mínimo de 30 minutos.

Cada alerta confirmada genera también una entrada `[PV_ALERT_DIAGNOSTIC]` en `storage/logs/combined.jsonl`. Incluye la muestra completa de telemetría PV, estado del inversor, antigüedad de las lecturas, umbrales aplicados, instante inicial y duración de la condición. Puede localizarse con:

```bash
grep 'PV_ALERT_DIAGNOSTIC' storage/logs/combined.jsonl
```

### Servidor OCPP

| Variable | Default | Descripción |
|---|---|---|
| `OCPP_HOST` | `0.0.0.0` | Interfaz de escucha del servidor OCPP |
| `OCPP_PORT` | `9100` | Puerto WebSocket OCPP |
| `OCPP_PATH_PREFIX` | `/ocpp` | Prefijo de ruta OCPP |
| `OCPP_HEARTBEAT_INTERVAL` | `30` | Intervalo de heartbeat en segundos |

### Control de carga inteligente

| Variable | Default | Descripción |
|---|---|---|
| `GREEN_GRID_VOLTAGE` | `230` | Tensión usada para convertir entre amperios y vatios |
| `GREEN_MAX_CHARGING_AMPS` | `32` | Límite máximo de carga |
| `GREEN_HYSTERESIS_WATTS` | `200` | Cambio mínimo de potencia para reenviar perfil |
| `HYBRID_MIN_CHARGING_AMPS` | `7` | Mínimo garantizado en HYBRID cuando ya hay sesión estable |
| `HYBRID_START_MIN_CHARGING_AMPS` | `8` | Mínimo al arrancar una sesión HYBRID |

### Smart Charging Probe

| Variable | Default | Descripción |
|---|---|---|
| `OCPP_SMART_PROBE_ON_CONNECT` | `1` | Flag histórico de probe automático; hoy se deja desactivado lógicamente para no sobrescribir límites activos |
| `OCPP_SMART_PROBE_DELAY_MS` | `1500` | Retardo configurado para probes |
| `OCPP_SMART_PROBE_STACK_LEVEL` | `2` | Stack level del probe `ChargePointMaxProfile` |
| `OCPP_SMART_PROBE_CP_MAX_AMPS` | `8` | Límite en amperios del probe `ChargePointMaxProfile` |
| `OCPP_SMART_PROBE_TX_AMPS` | `10` | Límite en amperios del probe `TxProfile` |
| `OCPP_SMART_PROBE_CP_MAX_WATTS` | `2000` | Límite en vatios del probe `ChargePointMaxProfile` |
| `OCPP_SMART_PROBE_TX_WATTS` | `2300` | Límite en vatios del probe `TxProfile` |
| `OCPP_SMART_PROBE_RATE_UNIT` | `auto` | `A`, `W` o `auto` según soporte del cargador |

## Ejecución

### Desarrollo

```bash
pnpm run dev
```

Esto arranca el backend desde `server.ts`, que orquesta los servicios modulares:

- **Monolito** (por defecto): Todos los servicios en un solo proceso
- **Modular** (con `SERVICE_ROLE`): Cada servicio independiente

En monolito, el inicio incluye:
- Polling Modbus del inversor
- Servidor OCPP 1.6
- API HTTP con Socket.io
- Frontend servido por Vite en modo middleware

Endpoints principales:

- Dashboard: `http://localhost:3001`
- OCPP: `ws://0.0.0.0:9100/ocpp/<chargePointId>`

### Build frontend

```bash
pnpm run build
```

Genera el bundle del frontend en `dist/`.

### Validación TypeScript

```bash
pnpm run lint
```

### Tests automatizados

```bash
# Tests unitarios deterministas
npm test

# TypeScript y tests
npm run check
```

Las pruebas del monitor de alertas simulan el paso del tiempo sin esperas reales y cubren el anochecer, toda la noche en standby, caídas transitorias, pérdida persistente, lecturas obsoletas, recuperación estable y la alarma de pérdida de string.

### Producción (Docker)

El proyecto está optimizado para ejecutarse mediante `docker-compose` usando **perfiles** para elegir el modo de ejecución:

#### Modo Modular (Recomendado)
Separa el sistema en 3 contenedores. Permite actualizar la web sin detener la recogida de datos.
```bash
docker-compose --profile modular up -d --build
```

#### Modo Monolito
Ejecuta todo en un único contenedor (estilo tradicional).
```bash
docker-compose --profile monolith up -d --build
```

### Extra documentation

- [Watchtower deployment and automatic updates](docs/WATCHTOWER_DEPLOYMENT.md): how Watchtower works with GHCR, GitHub Actions, Docker Compose, and the HuaweiDashboard production services.

## Modos de carga EV

### FAST

- Carga a máxima potencia permitida (`GREEN_MAX_CHARGING_AMPS`).
- No aplica restricciones solares.
- Usa `SetChargingProfile` para fijar el límite alto al iniciar.

### GREEN

Solo carga con excedente solar suficiente.

Fórmula actual:

```text
surplusW = gridPower + chargerPower
targetAmps = surplusW / GREEN_GRID_VOLTAGE
```

Notas:

- `gridPower > 0` significa exportación a red.
- Si el objetivo cae por debajo de 6A, el backend detiene la carga.
- El ciclo de decisión se ejecuta cada 30 segundos.
- La histéresis evita reenviar perfiles por cambios pequeños.

### HYBRID

Parte de la misma lógica que GREEN, pero con un mínimo garantizado:

- Inicio de sesión: mínimo de 8A por defecto.
- Sesión en marcha: mínimo de 7A por defecto.
- El excedente solar se aprovecha por encima de ese mínimo hasta el máximo configurado.

Este ajuste se elevó desde 6A a 7A para evitar sesiones inestables observadas en campo.

## Persistencia y reconciliación del cargador

El backend persiste automáticamente en `charger-state.json`:

- `chargingMode`
- `startRequested`
- `appliedCurrentLimitA`
- `lastRequestedCurrentLimitA`
- `transactionId`

Al reiniciar:

- restaura el estado persistido,
- lo expone de nuevo al frontend,
- y cuando el cargador reconecta intenta reconciliar el control pendiente.

Eventos que disparan reconciliación:

- apertura del WebSocket OCPP,
- `BootNotification`,
- recuperación desde `Unavailable`,
- `StopTransaction` no iniciado explícitamente por la API,
- cambio de modo vía API,
- `start` vía API en modos inteligentes.

### Protección anti-loop

- Si se reciben 3 `StopTransaction(reason=Other)` consecutivos, se activa un cooldown de 60 segundos.
- Si el motivo es `Local`, se evita el rearm inmediato y se deja la decisión al ciclo periódico de smart charging.
- Las reconexiones OCPP ahora ignoran sockets obsoletos para no perder el estado del socket activo.

## OCPP 1.6 soportado

### Mensajes recibidos del cargador

| Mensaje | Comportamiento |
|---|---|
| `BootNotification` | Acepta y devuelve heartbeat interval |
| `Heartbeat` | Devuelve `currentTime` |
| `Authorize` | Acepta `idTag` |
| `StatusNotification` | Actualiza estado del cargador |
| `MeterValues` | Actualiza potencia y puede inferir estado de sesión/cable |
| `StartTransaction` | Acepta y asigna `transactionId` interno |
| `StopTransaction` | Acepta y decide rearm/cooldown según el motivo |
| `SecurityEventNotification` | Ack vacío |
| `DiagnosticsStatusNotification` | Ack vacío |
| `FirmwareStatusNotification` | Ack vacío |

### Mensajes enviados al cargador

| Mensaje | Uso |
|---|---|
| `RemoteStartTransaction` | Arranque remoto |
| `RemoteStopTransaction` | Parada remota |
| `SetChargingProfile` | Límite dinámico o probe |
| `ClearChargingProfile` | Limpieza de límite |
| `GetConfiguration` | Snapshot general o claves de smart charging |
| `ChangeConfiguration` | Configuración de telemetría |
| `TriggerMessage` | Petición puntual de `MeterValues` |

## API y tiempo real

### REST

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/charger/start` | Inicia carga respetando el modo activo |
| `POST` | `/api/charger/stop` | Detiene carga y desarma el modo inteligente |
| `POST` | `/api/charger/mode` | Cambia a `FAST`, `GREEN` o `HYBRID` |
| `POST` | `/api/charger/probe-smart` | Lanza un probe manual de smart charging |
| `GET` | `/api/logs/live` | Últimas 250 entradas del log activo |
| `GET` | `/api/logs/:date` | Log completo de una sesión |
| `GET` | `/api/history/list` | Días con histórico disponible |
| `GET` | `/api/history/:date` | Histórico diario |

### Socket.io

Eventos emitidos actualmente:

- `inverter-data`: estado agregado inversor + cargador.
- `server-log`: log en vivo del backend.

## Datos Modbus leídos del inversor

| Dato | Registro | Descripción |
|---|---|---|
| Modelo | `30000` | Identificación del inversor |
| Número de serie | `30015` | Serial |
| Tensión/corriente PV1 y PV2 | `32016` | Datos de strings solares |
| Potencia de entrada DC | `32064` | Potencia fotovoltaica total |
| Potencia activa AC | `32080` | Potencia AC |
| Temperatura y estado | `32087` | Estado operativo |
| Producción diaria | `32106` | Yield diario |
| Producción total | `32114` | Yield acumulado |
| Tensión/frecuencia de red | `32066` | Medidas AC |
| Potencia de red | `37113` | Exportación/importación neta |
| Potencia de batería | `37001` | Flujo de batería |
| SOC batería | `37004` | Estado de carga |

Cálculo actual de carga doméstica:

```text
houseLoad = activePower - gridPower + batteryPower - evChargePower
```

## Histórico y logs

### Histórico diario

Cada 2 segundos se intenta escribir una muestra en `history/YYYY-MM-DD.jsonl` si la lectura Modbus crítica fue válida.

Ejemplo:

```json
{
  "time": "2026-04-26T10:00:00.000Z",
  "power": 4200,
  "inputPower": 5100,
  "consumption": 800,
  "batterySOC": 87.5,
  "gridPower": 1100
}
```

La UI puede cargar días anteriores y, además, la vista Live precarga el histórico del día en curso al arrancar.

### Logs de sesión

Cada arranque crea un fichero nuevo en `logs/`.

Formato de cada línea:

```json
{ "time": "...", "level": "info", "source": "server", "message": "..." }
```

Los últimos 250 logs se mantienen en memoria y además se emiten en tiempo real al frontend.

## Configuración recomendada del cargador

| Parámetro | Valor sugerido |
|---|---|
| Conexión a plataforma | Activada |
| Proveedor | Custom / Other |
| Host/IP | IP local del equipo que ejecuta la app |
| Ruta | `/ocpp/CP001` |
| Puerto | `9100` |
| Protocolo | `ws://` |
| Usuario / contraseña | Vacíos si el cargador lo permite |

## Estructura actual del proyecto

```text
Agents.md                    Guía de contexto para asistentes de IA (Arquitectura/IPC/Roles)
backend/
  server.ts                  Punto de entrada principal: orquestador de servicios
  config/
    constants.ts             Constantes y configuración centralizada
  ipc/
    state-manager.ts         Gestor de estado compartido y persistencia (IPC)
  services/
    inverter-collector.ts    Polling Modbus y histórico de telemetría
    ocpp-charger.ts          Servidor OCPP 1.6 para control EV
    ui-api.ts                API HTTP + Socket.io + Interfaz web
    telegram.ts              Alertas por Telegram
  utils/
    converters.ts            Conversión de registros Modbus
    stats.ts                 Cálculo de estadísticas e InfluxDB
  scripts/
    migrate_history.ts       Utilidad de migración de histórico
    test_telegram_alerts.ts  Script de test de Telegram (documentado en README)
frontend/
  App.tsx                    Dashboard principal React
  main.tsx                   Entrada del frontend
  index.css                  Estilos globales
  lib/utils.ts               Utilidades frontend
storage/
  history/                   Histórico diario JSONL
  logs/                      Logs de sesión + combined.jsonl
  data/                      Estado persistido + Live State (IPC)
dist/                        Bundle frontend (generado por Vite)
Dockerfile                   Build multietapa con verificación de tipos
docker-compose.yml           Orquestación con soporte de perfiles
.env.example                 Configuración base mínima
```

## Scripts disponibles

| Script | Descripción |
|---|---|
| `npm run dev` | Arranca la aplicación principal |
| `npm run ocpp:dev` | Ejecuta `ocpp_server.ts` |
| `npm run build` | Compila el frontend con Vite |
| `npm run lint` | Ejecuta `tsc --noEmit` |
| `npm run clean` | Borra `dist/` |
| `npm run preview` | Preview del build frontend |

## 🛠️ Tecnologías Utilizadas

| Categoría | Tecnologías |
|---|---|
| **Frontend** | React 19, Vite, Recharts, Framer Motion, Tailwind CSS 4 |
| **Backend** | Node.js, Express, Socket.io, ws, JSModbus |
| **Infraestructura** | Docker, Docker Compose |
| **Lenguaje** | TypeScript |

## Observaciones

- El proyecto ha crecido iterativamente y todavía mezcla responsabilidades de frontend, OCPP y Modbus en un único proceso.
- La documentación intenta reflejar el comportamiento actual observado en el código, no una arquitectura objetivo futura.

Uso residencial para monitorización solar y control EV.
