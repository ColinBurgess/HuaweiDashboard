# Huawei SUN2000 Inverter Dashboard

Esta aplicación permite monitorizar en tiempo real un inversor **Huawei SUN2000-6KTL** (y modelos compatibles) utilizando el protocolo **Modbus TCP**.

## Requisitos Previos

- **Node.js**: Versión 18 o superior.
- **Inversor Huawei**: Debe tener habilitado Modbus TCP y estar en la misma red local.
- **Dongle SDongleA-05**: Generalmente necesario para la conexión Modbus TCP en modelos residenciales.

## Instalación Local

1. **Descargar el código fuente**: Extrae el contenido del ZIP en una carpeta.
2. **Instalar dependencias**:
   ```bash
   npm install
   ```

## Configuración

La aplicación admite variables de entorno para evitar cambios en el código. Puedes partir de `.env.example` y crear un archivo `.env` en la raíz del proyecto:

```env
APP_PORT=3001
MODBUS_HOST=192.168.1.140
MODBUS_PORTS=502,6607
```

- `APP_PORT`: puerto HTTP del dashboard.
- `MODBUS_HOST`: IP del inversor o del dongle.
- `MODBUS_PORTS`: lista de puertos Modbus a probar automáticamente.

> **Nota**: Algunos equipos Huawei usan `502`, otros `6607` (por ejemplo, en AP directo del inversor).

## Ejecución

Para iniciar la aplicación en modo desarrollo:

```bash
npm run dev
```

La aplicación estará disponible en: [http://localhost:3001](http://localhost:3001)

## OCPP Local (Modo Contingencia)

Este repositorio incluye un servidor OCPP 1.6 local para operar el cargador cuando FusionSolar no esté disponible.

El comando principal `npm run dev` ahora levanta:

- Dashboard en `http://localhost:3001`
- Endpoint OCPP local en `ws://0.0.0.0:9100/ocpp/<chargePointId>`

También puedes ejecutar solo el servidor OCPP con:

```bash
npm run ocpp:dev
```

Por defecto escucha en:

- `ws://0.0.0.0:9100/ocpp/<chargePointId>`

Variables opcionales:

- `OCPP_HOST` (default: `0.0.0.0`)
- `OCPP_PORT` (default: `9100`)
- `OCPP_PATH_PREFIX` (default: `/ocpp`)
- `OCPP_HEARTBEAT_INTERVAL` (default: `30`)

### Parámetros recomendados en el cargador

- Conexión a plataforma: `Activada`
- Proveedor: `Custom/Other`
- Nombre de dominio: `IP local del Mac` (ejemplo: `192.168.1.138`)
- Ruta: `/ocpp/CP001`
- Puerto: `9100`
- Usuario/Contraseña: vacíos (si el equipo lo permite)

### Qué soporta este servidor

- `BootNotification` (Accepted)
- `Heartbeat`
- `Authorize` (Accepted)
- `StatusNotification`
- `MeterValues`
- `StartTransaction` (Accepted)
- `StopTransaction` (Accepted)
- `SecurityEventNotification`

## Estructura del Proyecto

- `server.ts`: Servidor backend que gestiona la conexión Modbus y emite datos vía WebSockets.
- `src/App.tsx`: Frontend en React con el dashboard visual.
- `src/lib/utils.ts`: Utilidades de estilo.
- `package.json`: Scripts y dependencias.

## Tecnologías Utilizadas

- **Frontend**: React 19, Tailwind CSS 4, Lucide React, Recharts.
- **Backend**: Express, Socket.io, JSModbus.
- **Herramientas**: Vite, TypeScript, tsx.

---

*Desarrollado para monitorización residencial de energía solar.*
