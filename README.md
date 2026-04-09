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

Abre el archivo `server.ts` y asegúrate de que la configuración de red coincide con tu inversor:

```typescript
// server.ts (Líneas 20-22)
const MODBUS_HOST = '192.168.1.140'; // IP de tu inversor o Dongle
const MODBUS_PORT = 502;             // Puerto Modbus (por defecto 502 o 6607)
const SLAVE_ID = 1;                  // ID del esclavo (suele ser 1)
```

> **Nota**: Si tu inversor usa el puerto 6607 (común en conexiones directas al AP del inversor), cámbialo en el código.

## Ejecución

Para iniciar la aplicación en modo desarrollo:

```bash
npm run dev
```

La aplicación estará disponible en: [http://localhost:3000](http://localhost:3000)

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
