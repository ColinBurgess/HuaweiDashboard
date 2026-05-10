# Contexto para Agentes AI - HuaweiDashboard

Este archivo sirve como guía de transferencia para que cualquier nuevo agente de IA pueda entender rápidamente la arquitectura y el estado actual del proyecto.

## Arquitectura del Proyecto
El sistema ha evolucionado de un monolito a una arquitectura **Modular (Microservicios)**. Se puede ejecutar en ambos modos, pero el desarrollo actual se centra en el modo modular.

### Servicios Principales
1.  **Inverter Service (`collector`)**: Lee datos vía Modbus TCP del inversor Huawei.
2.  **Charger Service (`charger`)**: Servidor OCPP 1.6 que gestiona el cargador de coche.
3.  **Dashboard Service (`dashboard`)**: Servidor API Express y Frontend Vite.

### Comunicación Inter-procesos (IPC)
No utilizamos Redis ni colas de mensajes. La comunicación se realiza a través de un archivo de estado compartido en disco:
-   **Ruta**: `storage/data/live-state.json`
-   **Mecánica**: Cada servicio carga este archivo cada 1s (`loadLiveState`), actualiza su parte del estado en memoria, y lo guarda (`saveLiveState`).

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

## Estado Actual (10 Mayo 2026)
-   [x] Migración a servicios completada.
-   [x] Sincronización de excedente solar hacia el cargador corregida vía `live-state.json`.
-   [x] Sistema de logs unificado implementado.
-   [x] Panel de salud de servicios (Health Monitor) operativo.
