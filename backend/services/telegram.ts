/**
 * Telegram Bot Notifications Service
 * Sends alerts to a Telegram chat when critical events occur
 */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';
const TELEGRAM_ALERTS_ENABLED = String(process.env.TELEGRAM_ALERTS_ENABLED ?? 'false').toLowerCase() === 'true';

// Throttle tracking to avoid spam
const alertThrottle = new Map<string, number>();
const THROTTLE_DURATION_MS = 5 * 60 * 1000; // 5 minutes between same alert type

export interface TelegramAlert {
  type: 'inverter_disconnected' | 'inverter_reconnected' | 'modbus_error' | 'system_info';
  title: string;
  message: string;
  severity?: 'critical' | 'warning' | 'info'; // For emoji selection
}

/**
 * Check if an alert should be throttled (sent recently)
 */
function isThrottled(alertType: string): boolean {
  const lastSentTime = alertThrottle.get(alertType);
  if (!lastSentTime) return false;
  
  const now = Date.now();
  if (now - lastSentTime > THROTTLE_DURATION_MS) {
    alertThrottle.delete(alertType);
    return false;
  }
  
  return true;
}

/**
 * Mark an alert as sent (for throttling)
 */
function recordAlertSent(alertType: string): void {
  alertThrottle.set(alertType, Date.now());
}

/**
 * Send a message to Telegram
 */
export async function sendTelegramAlert(alert: TelegramAlert): Promise<boolean> {
  if (!TELEGRAM_ALERTS_ENABLED || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return false;
  }

  // Check throttling
  if (isThrottled(alert.type)) {
    console.log(`[TELEGRAM] Alert throttled: ${alert.type}`);
    return false;
  }

  const severityEmoji = {
    critical: '🚨',
    warning: '⚠️',
    info: 'ℹ️'
  };

  const emoji = severityEmoji[alert.severity ?? 'info'];
  const text = `${emoji} **${alert.title}**\n\n${alert.message}\n\n_${new Date().toLocaleString('es-ES')}_`;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'Markdown'
        })
      }
    );

    if (!response.ok) {
      console.error(
        `[TELEGRAM] Failed to send alert: ${response.statusText}`,
        await response.text()
      );
      return false;
    }

    console.log(`[TELEGRAM] Alert sent: ${alert.type}`);
    recordAlertSent(alert.type);
    return true;
  } catch (error) {
    console.error('[TELEGRAM] Error sending alert:', error);
    return false;
  }
}

/**
 * Send inverter disconnection alert
 */
export async function alertInverterDisconnected(): Promise<void> {
  await sendTelegramAlert({
    type: 'inverter_disconnected',
    title: 'Inversor Desconectado',
    message: 'El inversor Huawei SUN2000 se ha desconectado.\n\nPosibles causas:\n• Diferencial o interruptor saltado\n• Problema de red\n• Inversor apagado',
    severity: 'critical'
  });
}

/**
 * Send inverter reconnection alert
 */
export async function alertInverterReconnected(): Promise<void> {
  await sendTelegramAlert({
    type: 'inverter_reconnected',
    title: 'Inversor Reconectado',
    message: 'El inversor Huawei SUN2000 se ha vuelto a conectar. El monitoreo está activo nuevamente.',
    severity: 'info'
  });
}

/**
 * Send Modbus error alert
 */
export async function alertModbusError(message: string): Promise<void> {
  await sendTelegramAlert({
    type: 'modbus_error',
    title: 'Error de Comunicación Modbus',
    message: `Se ha detectado un problema: ${message}`,
    severity: 'warning'
  });
}

/**
 * Send system info/debug alert
 */
export async function alertSystemInfo(title: string, message: string): Promise<void> {
  await sendTelegramAlert({
    type: 'system_info',
    title,
    message,
    severity: 'info'
  });
}

/**
 * Check if Telegram is configured
 */
export function isTelegramEnabled(): boolean {
  return TELEGRAM_ALERTS_ENABLED && !!TELEGRAM_BOT_TOKEN && !!TELEGRAM_CHAT_ID;
}
