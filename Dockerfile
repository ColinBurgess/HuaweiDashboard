# ==========================================
# ETAPA 1: Compilación del Frontend (Builder)
# ==========================================
FROM node:22-slim AS builder

WORKDIR /app

# Install pnpm (pinned version for reproducibility)
RUN npm install -g pnpm@9

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build


# ==========================================
# ETAPA 2: Imagen de Producción (Final)
# ==========================================
FROM node:22-slim

WORKDIR /app

# Install pnpm in final image (pinned version for reproducibility)
RUN npm install -g pnpm@9

# Copiar manifiestos de dependencias
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copiar dependencias y directorios compilados
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/backend ./backend
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/metadata.json ./metadata.json

# Crear las carpetas de almacenamiento como ROOT (para evitar el Permission Denied)
# y cambiarles los permisos al usuario 'node' (es instantáneo porque están vacías)
RUN mkdir -p storage/data storage/history storage/logs && \
    chown -R node:node storage

# Cambiar finalmente al usuario no-root por seguridad
USER node

EXPOSE 3001 9100

CMD ["pnpm", "start"]