# Contexto para Agentes AI - HuaweiDashboard

Este archivo sirve como guía de transferencia para que cualquier nuevo agente de IA pueda entender rápidamente la arquitectura y el estado actual del proyecto.

## Arquitectura del Proyecto
El sistema ha evolucionado de un monolito a una arquitectura **Modular (Microservicios)**. Se puede ejecutar en ambos modos, pero el desarrollo actual se centra en el modo modular.

### Servicios Principales
1.  **Inverter Service (`collector`)**: Lee datos vía Modbus TCP del inversor Huawei.
2.  **Charger Service (`charger`)**: Servidor OCPP 1.6 que gestiona el cargador de coche.
3.  **Dashboard Service (`dashboard`)**: Servidor API Express y Frontend Vite.

### Comunicación Inter-procesos (IPC)
No utilizamos Redis ni colas de mensajes. La comunicación se realiza a través de archivos de estado compartidos en disco para evitar condiciones de carrera:
-   **Mecánica**: Cada servicio es "dueño" de su propio archivo:
    -   `storage/data/live-state-collector.json` (Datos Inversor)
    -   `storage/data/live-state-charger.json` (Estado Cargador)
    -   `storage/data/live-state-dashboard.json` (Comandos de Usuario)
-   **Sincronización**: Cada servicio carga TODOS estos archivos cada 1s (`loadLiveState`), los combina en memoria y guarda su parte proporcional.

## Detalles Técnicos Clave
-   **Puertos**:
    -   `3001`: Dashboard UI / API.
    -   `9100`: Servidor OCPP (WebSocket).
-   **Variables de Entorno**:
    -   `START_MONOLITH=true`: Ejecuta todo en un solo proceso.
    -   `SERVICE_ROLE`: Define el rol del servicio en modo modular (`collector`, `charger`, `dashboard`).
-   **Logs**:
    -   Ubicación: `storage/logs/`.
    -   `combined.jsonl`: Archivo unificado que el Dashboard "tails" para mostrar en la UI.
-   **Salud del Sistema**:
    -   Cada servicio actualiza un latido en `inverterData.services[role]`.
    -   El Dashboard muestra el estado ONLINE/OFFLINE basado en estos latidos.

## Comandos Útiles
-   **Despliegue Modular**: `docker compose --profile modular up -d --build`
-   **Despliegue Monolito**: `docker compose --profile monolith up -d --build`
-   **Logs de un servicio**: `docker logs huawei-charger-service --tail 50`

## Estado Actual (19 Junio 2026)
-   [x] Migración a servicios completada.
-   [x] Sincronización de excedente solar hacia el cargador corregida.
-   [x] Sistema de logs unificado implementado.
-   [x] Panel de salud de servicios (Health Monitor) operativo.
-   [x] **Resuelto**: Problema de colisión de archivos mediante propiedad estricta de campos (`live-state-*.json`).
-   [x] **NUEVO (19 Jun)**: Sistema de reconexión automática con exponential backoff en collector.
    - Detecta 3+ timeouts consecutivos → fuerza disconnect + reconnect inmediato
    - Exponential backoff: 5s → 10s → 20s... máx 2 minutos
    - Watchdog cada 30s: si offline >60s, fuerza intento de reconexión
    - Reset automático cuando conecta exitosamente
-   [x] **NUEVO (19 Jun)**: Skills especializados en `_skills/` para debugging y desarrollo futuro.
    - [HUAWEI-IPC-STATE-MANAGEMENT.md](_skills/HUAWEI-IPC-STATE-MANAGEMENT.md) → Comunicación inter-procesos
    - [HUAWEI-MODBUS-COLLECTOR.md](_skills/HUAWEI-MODBUS-COLLECTOR.md) → Polling y reconnexión
    - [HUAWEI-OCPP-CHARGER.md](_skills/HUAWEI-OCPP-CHARGER.md) → Protocolo OCPP y modos
    - [HUAWEI-DOCKER-DEPLOYMENT.md](_skills/HUAWEI-DOCKER-DEPLOYMENT.md) → Containerización
    - [HUAWEI-DEBUGGING-CHECKLIST.md](_skills/HUAWEI-DEBUGGING-CHECKLIST.md) → Troubleshooting sistemático

## Lecciones Aprendidas (Log de Errores)
1.  **Guerra de Archivos**: No usar un único archivo compartido para todos los servicios. Si todos escriben en el mismo sitio, se sobrescriben unos a otros con datos obsoletos.
2.  **Propiedad de Campos**: Cada servicio debe ser el "dueño" único de sus campos al guardar en disco. El Inversor no debe guardar el estado del Cargador, y viceversa.
3.  **TS Lint en Docker**: Un error de sintaxis o un duplicado en `server.ts` detiene todo el despliegue modular debido al paso de `npm run lint` en el Dockerfile. Siempre verificar duplicados tras refactorizaciones grandes.
4.  **Carga Selectiva**: Al cargar estados de otros, un servicio debe ignorar su propio archivo en disco para evitar que su memoria viva sea "pisada" por un estado antiguo persistido.
5.  **Instancias Simultáneas y Modbus**: **CRÍTICO** - No ejecutar la aplicación simultáneamente en dos máquinas/contextos si ambas intentan conectar al mismo inversor. Modbus TCP es single-connection; si hay dos instancias del collector service compitiendo, la conexión se cierra intermitentemente. Esto causa falsos problemas de "socket closes immediately". Verificar siempre: (a) Docker en servidor está corriendo, (b) Desarrollo local está detenido, o viceversa. Usar `docker compose ps` y revisar qué instancias están activas antes de hacer debugging de Modbus.

## Arquitectura Futura (Sugerencias)
-   **OpenAPI / Internals API**: Sustituir el sistema de archivos compartidos por una API REST interna o gRPC para comandos (ej: Dashboard -> Charger).
-   **Message Broker (MQTT/Redis)**: Usar un bus de datos para la telemetría en tiempo real (Inverter -> Dashboard) en lugar de polling de archivos cada 1s.
-   **Estado Centralizado**: Considerar Redis para el estado vivo si la complejidad de los archivos `live-state-*.json` aumenta.

## Skills para Agentes IA (NEW)

Para facilitar futuras sesiones de desarrollo y debugging, se han creado skills especializados en `_skills/`:

| Skill | Propósito |
|-------|-----------|
| [HUAWEI-IPC-STATE-MANAGEMENT.md](_skills/HUAWEI-IPC-STATE-MANAGEMENT.md) | Entender cómo funciona la comunicación entre servicios via archivos JSON, reglas de propiedad de campos, patrones seguros. |
| [HUAWEI-MODBUS-COLLECTOR.md](_skills/HUAWEI-MODBUS-COLLECTOR.md) | Todo sobre el polling Modbus, el nuevo sistema de reconexión con exponential backoff, watchdog, manejo de timeouts. |
| [HUAWEI-OCPP-CHARGER.md](_skills/HUAWEI-OCPP-CHARGER.md) | Protocolo OCPP 1.6, modos inteligentes (FAST/GREEN/HYBRID), SetChargingProfile, integración con datos del inversor. |
| [HUAWEI-DOCKER-DEPLOYMENT.md](_skills/HUAWEI-DOCKER-DEPLOYMENT.md) | Despliegue monolito vs modular, Docker Compose, multi-stage builds, configuración de volúmenes. |
| [HUAWEI-DEBUGGING-CHECKLIST.md](_skills/HUAWEI-DEBUGGING-CHECKLIST.md) | Guía sistemática para troubleshooting: 7 problemas críticos, flujo de debugging, comandos esenciales. |

**Cómo usar**: Los agentes de IA cargarán automáticamente estos skills cuando trabajen en este repositorio. Pueden usarse como referencia directa en prompts:

```
"Según HUAWEI-MODBUS-COLLECTOR.md, ¿por qué el collector se queda offline?"
"Usando la tabla de propiedad de campos en HUAWEI-IPC-STATE-MANAGEMENT.md, ¿cuál servicio debe escribir X campo?"
```
