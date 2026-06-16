import { startInverterService } from './services/inverter-collector.js';
import { startChargerService } from './services/ocpp-charger.js';
import { startDashboardService } from './services/ui-api.js';
import { restorePersistedChargerState, persistChargerStateIfChanged } from './ipc/state-manager.js';
import { isTelegramEnabled } from './services/telegram.js';
import { initializeLogging } from './utils/logger.js';

/**
 * Main orchestrator for HuaweiDashboard backend
 * Starts services based on SERVICE_ROLE or monolith mode
 */
async function main() {
  // Initialize centralized logging
  initializeLogging();

  const serviceRole = process.env.SERVICE_ROLE as 'collector' | 'charger' | 'dashboard' | undefined;
  const startMonolith = process.env.START_MONOLITH === 'true';

  // Determine execution mode
  const isMonolith = startMonolith || !serviceRole;
  const mode = isMonolith ? 'MONOLITH' : 'MODULAR';

  console.log(`\n🚀 HuaweiDashboard starting in ${mode} mode`);
  if (!isMonolith) console.log(`📌 Service role: ${serviceRole}`);

  // Restore persisted charger state
  restorePersistedChargerState();

  try {
    if (isMonolith) {
      // Start all services in a single process
      console.log('⚙️ Starting all services (Monolith mode)...');
      await Promise.all([
        startInverterService(),
        startChargerService(),
        startDashboardService(),
      ]);
    } else {
      // Start only the service for this role
      console.log(`⚙️ Starting ${serviceRole} service...`);
      if (serviceRole === 'collector') {
        await startInverterService();
      } else if (serviceRole === 'charger') {
        await startChargerService();
      } else if (serviceRole === 'dashboard') {
        await startDashboardService();
      }
    }

    console.log(`✅ Backend started successfully`);
    if (isTelegramEnabled()) console.log('📱 Telegram alerts enabled');
  } catch (err) {
    console.error('❌ Failed to start backend:', err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 SIGINT received, shutting down gracefully...');
  persistChargerStateIfChanged();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 SIGTERM received, shutting down gracefully...');
  persistChargerStateIfChanged();
  process.exit(0);
});

// Start the application
main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
