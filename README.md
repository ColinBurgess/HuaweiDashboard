# Huawei SUN2000 Inverter Dashboard

Dashboard de monitorización en tiempo real para inversores **Huawei SUN2000** con control inteligente de carga de vehículo eléctrico vía **OCPP 1.6**.

## Características principales

- **Monitorización en tiempo real** del inversor vía Modbus TCP: producción PV, consumo doméstico, batería, red eléctrica.
- **Control de cargador EV** mediante servidor OCPP 1.6 local, con tres modos de carga.
- **Carga verde (GREEN)**: carga exclusivamente con excedente solar, ajustando el límite dinámicamente cada 30 segundos.
- **Carga híbrida (HYBRID)**: igual que GREEN pero con un mínimo garantizado de amperios incluso sin excedente.
- **Carga rápida (FAST)**: carga a máxima potencia sin restricciones solares.
- **Histórico diario** de producción, consumo y balance de red guardado en archivos JSONL.
- **Log de sesión** persistente en tiempo real, accesible desde el propio dashboard.
- **Persistencia de estado** del cargador entre reinicios de la aplicación.

---

## Requisitos previos

- **Node.js** v18 o superior.
- **Inversor Huawei SUN2000** con Modbus TCP habilitado y accesible en red local (habitualmente requiere dongle SDongleA-05).
- **Cargador EV** compatible con OCPP 1.6 (probado con equipos que soportan `W` como unidad de límite de carga).

---

## Instalación

```bash
npm install
```

---

## Configuración

Crea un archivo `.env` en la raíz del proyecto. Variables disponibles:

### General

| Variable | Default | Descripción |
|---|---|---|
| `APP_PORT` | `3001` | Puerto HTTP del dashboard |
| `MODBUS_HOST` | `192.168.1.140` | IP del inversor o del dongle |
| `MODBUS_PORTS` | `502,6607` | Puertos Modbus a probar en orden (rotación automática ante fallos) |

> Algunos inversores usan el puerto `502`, otros el `6607` (cuando el Mac se conecta al AP Wi-Fi del propio inversor).

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
| `GREEN_GRID_VOLTAGE` | `230` | Tensión de red en voltios (para conversión A↔W) |
| `GREEN_MAX_CHARGING_AMPS` | `32` | Límite máximo de carga en amperios |
| `GREEN_HYSTERESIS_WATTS` | `200` | Diferencia mínima en vatios para actualizar el perfil de carga (evita oscilaciones) |
| `HYBRID_MIN_CHARGING_AMPS` | `6` | Amperios mínimos garantizados en modo HYBRID cuando ya está cargando |
| `HYBRID_START_MIN_CHARGING_AMPS` | `8` | Amperios mínimos al arrancar una sesión en modo HYBRID (antes de que el cargador reporte potencia) |

### Smart Charging Probe (OCPP)

| Variable | Default | Descripción |
|---|---|---|
| `OCPP_SMART_PROBE_RATE_UNIT` | `auto` | Unidad preferida para perfiles: `A`, `W` o `auto` (detecta automáticamente según la configuración del cargador) |
| `OCPP_SMART_PROBE_STACK_LEVEL` | `2` | Stack level para perfiles `ChargePointMaxProfile` |
| `OCPP_SMART_PROBE_CP_MAX_AMPS` | `8` | Amperios del perfil `ChargePointMaxProfile` en probes |
| `OCPP_SMART_PROBE_TX_AMPS` | `10` | Amperios del perfil `TxProfile` en probes |

---

## Ejecución

### Modo desarrollo (Vite + servidor en caliente)

```bash
npm run dev
```

Levanta simultáneamente:
- Dashboard en `http://localhost:3001`
- Servidor OCPP en `ws://0.0.0.0:9100/ocpp/<chargePointId>`

### Modo producción

```bash
npm run build
npm start
```

---

## Modos de carga del vehículo eléctrico

### FAST
Carga a la potencia máxima disponible (`GREEN_MAX_CHARGING_AMPS`). No aplica ninguna restricción solar. El perfil se envía una sola vez al iniciar.

### GREEN
Control dinámico basado exclusivamente en el excedente solar:

```
surplusW = gridPower + chargerCurrentPower
targetAmps = surplusW / GREEN_GRID_VOLTAGE
```

- `gridPower` es el valor neto de la red (positivo = exportación, negativo = importación).
- Si el excedente es inferior a `6 A` (1380 W a 230 V), se detiene la carga.
- El ciclo de control se ejecuta cada 30 segundos.
- La histéresis de `GREEN_HYSTERESIS_WATTS` evita ajustes continuos por pequeñas fluctuaciones.

### HYBRID
Igual que GREEN pero nunca baja del mínimo configurado, garantizando que el coche siempre cargue aunque no haya excedente:

- Al iniciar sesión (cargador no activo o potencia = 0): mínimo = `HYBRID_START_MIN_CHARGING_AMPS` (default 8 A).
- Sesión activa en curso: mínimo = `HYBRID_MIN_CHARGING_AMPS` (default 6 A).
- El exceso de excedente solar se aprovecha por encima del mínimo hasta `GREEN_MAX_CHARGING_AMPS`.

---

## Reconciliación y persistencia del estado del cargador

El backend mantiene en memoria el estado de control del cargador y lo persiste automáticamente en `charger-state.json` ante cualquier cambio relevante (usando escritura atómica vía fichero temporal).

**Campos persistidos:**
- `chargingMode` (FAST / GREEN / HYBRID)
- `startRequested` (si el usuario ha pedido iniciar carga)
- `appliedCurrentLimitA` y `lastRequestedCurrentLimitA`
- `transactionId` (si existe transacción activa)

Al arrancar, el backend restaura estos valores y, cuando el cargador vuelve a conectar por OCPP, ejecuta automáticamente una reconciliación (`reconcileChargerControlState`) para reanudar la política de control sin intervención del usuario.

**Eventos que disparan reconciliación:**
- `BootNotification` del cargador
- `WebSocket` de OCPP abierto
- `StatusNotification` con recuperación de estado `Unavailable`
- `StopTransaction` sin petición explícita de parada desde la API (auto-rearm)
- Cambio de modo vía API

### Protección anti-loop (cooldown)

Si el cargador emite `StopTransaction(reason=Other)` de forma consecutiva (≥ 3 veces), el backend activa un **cooldown de 60 segundos** durante el cual no reintenta el arranque. El contador se resetea en cuanto se recibe un `StopTransaction` con cualquier otro motivo (Local, EVDisconnected, etc.) o al expirar el cooldown.

---

## Servidor OCPP 1.6 — Mensajes soportados

| Mensaje (charger → server) | Respuesta |
|---|---|
| `BootNotification` | `Accepted` |
| `Heartbeat` | `currentTime` |
| `Authorize` | `Accepted` |
| `StatusNotification` | `{}` |
| `MeterValues` | `{}` (extrae `Power.Active.Import` y actualiza potencia) |
| `StartTransaction` | `Accepted` + asigna `transactionId` interno |
| `StopTransaction` | `Accepted` + lógica de rearm / cooldown |
| `SecurityEventNotification` | `{}` |
| `DiagnosticsStatusNotification` | `{}` |
| `FirmwareStatusNotification` | `{}` |

| Mensaje (server → charger) | Cuándo |
|---|---|
| `RemoteStartTransaction` | Al activar carga desde la API o reconciliación |
| `RemoteStopTransaction` | Al detener carga desde la API o falta de excedente (GREEN) |
| `SetChargingProfile` | Al ajustar el límite dinámico (TxDefaultProfile) |
| `ClearChargingProfile` | Al detener en modo FAST o limpiar límite |
| `GetConfiguration` | Al conectar el cargador (snapshot completo) |
| `ChangeConfiguration` | Configura `MeterValueSampleInterval=10` y métricas de potencia/energía |
| `TriggerMessage` | Solicita `MeterValues` al conectar |

---

## API REST

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/charger/start` | Inicia carga (respeta el modo activo) |
| `POST` | `/api/charger/stop` | Detiene carga y desarma el modo inteligente |
| `POST` | `/api/charger/mode` | Cambia el modo: body `{ "mode": "FAST" \| "GREEN" \| "HYBRID" }` |
| `POST` | `/api/charger/probe-smart` | Lanza un probe manual de smart charging |
| `GET` | `/api/logs/live` | Últimas 250 entradas del log de sesión (en memoria) |
| `GET` | `/api/logs/:date` | Log de sesión completo de la fecha indicada (formato `YYYY-MM-DDTHH-MM-SSZ`) |
| `GET` | `/api/history/list` | Lista de días con histórico disponible |
| `GET` | `/api/history/:date` | Datos históricos de un día (formato `YYYY-MM-DD`) |

Los datos en tiempo real se emiten por **Socket.io** con el evento `inverter-data`.

---

## Configuración del cargador EV

Ajustes recomendados en el panel del cargador para conectarlo al servidor OCPP local:

| Parámetro | Valor |
|---|---|
| Conexión a plataforma | Activada |
| Proveedor | Custom / Other |
| Nombre de dominio / IP | IP local del equipo que ejecuta este servidor |
| Ruta | `/ocpp/CP001` |
| Puerto | `9100` |
| Protocolo | `ws://` (sin TLS) |
| Usuario / Contraseña | Vacíos |

---

## Datos leídos del inversor (Modbus TCP)

| Dato | Registro Modbus | Descripción |
|---|---|---|
| Modelo | 30000 (15 regs) | Identificación del inversor |
| Número de serie | 30015 (10 regs) | S/N del inversor |
| Tensión PV1 / PV2 | 32016 | Voltaje de cada string fotovoltaico |
| Corriente PV1 / PV2 | 32016+offset | Corriente de cada string |
| Potencia de entrada | 32064 (i32) | Potencia total DC en vatios |
| Potencia activa AC | 32080 (i32) | Potencia exportada/consumida AC |
| Temperatura | 32087 | Temperatura interna del inversor |
| Estado | 32087+2 | Código de estado del inversor |
| Producción diaria | 32106 (u32) | kWh producidos hoy |
| Producción total | 32114 (u32) | kWh producidos en total |
| Tensión de red | 32066 | Tensión AC de red |
| Frecuencia de red | 32066+3 | Frecuencia AC |
| Potencia de red | 37113 (i32) | Balance neto (+ exporta, − importa) |
| Potencia de batería | 37001 (i32) | Flujo de batería (+ carga, − descarga) |
| SOC de batería | 37004 | Estado de carga de la batería (%) |

**Cálculo de consumo doméstico:**
```
houseLoad = activePower - gridPower + batteryPower - evChargePower
```

---

## Histórico

Cada 2 segundos se escribe una muestra en `history/YYYY-MM-DD.jsonl` con los campos:

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

Solo se escriben muestras si todos los bloques Modbus críticos (PV, potencia activa, red) se leyeron correctamente.

---

## Logs de sesión

Cada arranque del servidor crea un nuevo archivo en `logs/` con el nombre `YYYY-MM-DDTHH-MM-SSZ.jsonl`. Cada línea es un objeto JSON:

```json
{ "time": "...", "level": "info", "source": "server", "message": "..." }
```

Los últimos 250 registros de la sesión activa también se emiten en tiempo real por Socket.io (`server-log`) y están disponibles vía `GET /api/logs/live`.

---

## Estructura del proyecto

```
server.ts          # Backend: Modbus, OCPP, API REST, Socket.io
src/
  App.tsx          # Frontend React (dashboard visual)
  main.tsx         # Punto de entrada React
  index.css        # Estilos globales
  lib/utils.ts     # Utilidades de clases CSS (cn)
history/           # Histórico diario JSONL (auto-generado)
logs/              # Logs de sesión JSONL (auto-generado)
charger-state.json # Estado persistido del cargador (auto-generado)
```

---

## Tecnologías

- **Frontend**: React 19, Tailwind CSS 4, Recharts, Lucide React, Socket.io client
- **Backend**: Node.js, Express, Socket.io, ws (WebSocket nativo), JSModbus
- **Build**: Vite, TypeScript, tsx

---

*Uso residencial — monitorización solar + control de carga EV.*
