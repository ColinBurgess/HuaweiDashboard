FROM node:20-slim

WORKDIR /app

# Instalar dependencias de sistema necesarias para algunas librerías si fuera el caso
# (Para Modbus y WebSockets usualmente node:slim es suficiente)

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar todas las dependencias (incluyendo tsx y typescript)
RUN npm install

# Copiar el resto del código fuente
COPY . .

# Verificar tipos y sintaxis (evita errores de referencia en el navegador)
RUN npm run lint

# Construir el frontend para producción (genera la carpeta dist/)
RUN npm run build

# Exponer los puertos del dashboard y del servidor OCPP
EXPOSE 3001 9100

# Variables de entorno por defecto
ENV NODE_ENV=production
ENV PORT=3001

# Comando para arrancar el servidor
CMD ["npm", "start"]
