/**
 * Service and Application Version Management
 * Centralized versioning for the dashboard and all microservices
 *
 * Update these versions when you make significant changes to each service.
 * Format: MAJOR.MINOR.PATCH (SemVer)
 */

import packageJson from '../../package.json' assert { type: 'json' };

export const APP_VERSION = packageJson.version;

/**
 * Individual microservice versions
 * Increment when making breaking changes or significant features
 */
export const SERVICE_VERSIONS = {
  // Modbus TCP polling and telemetry persistence
  collector: '1.2.0',

  // OCPP 1.6 charger server and smart charging
  charger: '1.0.1',

  // Express API, WebSocket, and dashboard UI
  dashboard: '1.0.0',
} as const;

export type ServiceRole = keyof typeof SERVICE_VERSIONS;

/**
 * Get version for current service role
 */
export function getServiceVersion(role?: string): string {
  if (!role) return APP_VERSION;
  return SERVICE_VERSIONS[role as ServiceRole] ?? APP_VERSION;
}

/**
 * Get all version info
 */
export interface VersionInfo {
  app: string;
  services: Record<ServiceRole, string>;
  buildDate: string;
  environment: string;
}

export function getVersionInfo(): VersionInfo {
  return {
    app: APP_VERSION,
    services: { ...SERVICE_VERSIONS },
    buildDate: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  };
}
