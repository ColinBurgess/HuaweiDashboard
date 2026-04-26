# Huawei SUN2000 Inverter Dashboard

Dashboard residencial para monitorizar un inversor Huawei SUN2000 y controlar un cargador EV vía OCPP 1.6 desde una única aplicación Node.js + React.

El proyecto combina tres funciones principales:

- Telemetría en tiempo real del inversor vía Modbus TCP.
- Control inteligente del cargador EV con modos FAST, GREEN y HYBRID.
- Persistencia local de histórico, logs y estado del cargador entre reinicios.

## Estado actual

Actualmente el proyecto se ejecuta como un proceso único que levanta:

- API HTTP para el frontend.
- Servidor OCPP WebSocket para el cargador.
- Cliente Modbus TCP para el inversor.
- Emisión de datos en tiempo real al frontend mediante Socket.io.

No está desacoplado aún en servicios separados de inversor, cargador y frontend. El README refleja el estado actual del monolito, no una arquitectura futura.

## Capacidades principales

- Monitorización en tiempo real de producción solar, red, batería, temperatura y consumo doméstico.
- Visualización del flujo energético y gráfico de potencia vs consumo.
- Histórico diario persistente en `history/YYYY-MM-DD.jsonl`.
- Logs de sesión persistentes en `logs/YYYY-MM-DDTHH-MM-SSZ.jsonl`.
- Persistencia de estado del cargador en `charger-state.json`.
- Control EV con modos FAST, GREEN y HYBRID.
- Reconciliación automática tras reinicios o reconexiones OCPP.
- Protección anti-loop ante `StopTransaction(reason=Other)` repetidos.
- Soporte de límites OCPP tanto en amperios como en vatios según lo que soporte el cargador.
- Precarga en la UI del histórico del día actual para que la vista Live no parezca vacía tras reiniciar.
- Manejo endurecido de reconexiones OCPP para evitar que sockets obsoletos desarmen el control inteligente.

## Requisitos previos

- Node.js 18 o superior.
- Inversor Huawei SUN2000 con Modbus TCP habilitado y accesible en red local.
- Cargador EV compatible con OCPP 1.6.
- Acceso a red local hacia el inversor y el cargador.

## Instalación

```bash
npm install
```

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
npm run dev
```

Esto arranca el backend principal desde `server.ts`, incluyendo:

- frontend servido por Vite en modo middleware,
- API HTTP,
- Socket.io,
- servidor OCPP,
- polling Modbus.

Endpoints principales mientras está en marcha:

- Dashboard: `http://localhost:3001`
- OCPP: `ws://0.0.0.0:9100/ocpp/<chargePointId>`

### Build frontend

```bash
npm run build
```

Genera el bundle del frontend en `dist/`.

### Validación TypeScript

```bash
npm run lint
```

### Producción

El script `npm start` existe en `package.json`, pero la ruta documentada históricamente (`dist/server.cjs`) no representa de forma fiable el empaquetado actual del backend. A día de hoy, el modo operativo validado para trabajar con el proyecto es `npm run dev`.

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
server.ts            Backend principal: Modbus + OCPP + API + Socket.io
ocpp_server.ts       Script auxiliar/experimental relacionado con OCPP
diag_charger.ts      Herramienta auxiliar de diagnóstico
scan_charger.ts      Herramienta auxiliar de descubrimiento/prueba
scan_devices.ts      Herramienta auxiliar de red/dispositivos
src/
  App.tsx            Frontend principal React
  main.tsx           Entrada del frontend
  index.css          Estilos globales
  lib/utils.ts       Utilidades frontend
history/             Histórico diario JSONL
logs/                Logs de sesión JSONL
dist/                Bundle frontend generado por Vite
charger-state.json   Estado persistido del cargador
.env.example         Configuración base mínima
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

## Tecnologías

- Frontend: React 19, Vite, Recharts, Lucide React, Socket.io client.
- Backend: Node.js, Express, Socket.io, ws, JSModbus.
- Tooling: TypeScript, tsx, Tailwind CSS 4.

## Observaciones

- El proyecto ha crecido iterativamente y todavía mezcla responsabilidades de frontend, OCPP y Modbus en un único proceso.
- La documentación intenta reflejar el comportamiento actual observado en el código, no una arquitectura objetivo futura.

Uso residencial para monitorización solar y control EV.
