#!/usr/bin/env tsx
/**
 * Test script for Telegram alert functions
 *
 * Tests that all alert types can be sent via Telegram bot.
 * Useful for verifying the bot is configured correctly.
 *
 * Usage:
 *   pnpm tsx backend/scripts/test_telegram_alerts.ts
 *
 * Or in Docker (if services are running):
 *   docker compose exec inverter-collector pnpm tsx backend/scripts/test_telegram_alerts.ts
 */

import 'dotenv/config';
import {
  alertInverterDisconnected,
  alertInverterReconnected,
  alertPvDisconnected,
  alertPvReconnected,
  alertPvStringLoss,
  isTelegramEnabled
} from '../services/telegram.js';

async function runTests() {
  console.log('\n📱 Testing Telegram Alerts...\n');

  if (!isTelegramEnabled()) {
    console.error('❌ Telegram is not configured.');
    console.error('   Check your .env file has:');
    console.error('   - TELEGRAM_BOT_TOKEN');
    console.error('   - TELEGRAM_CHAT_ID');
    console.error('   - TELEGRAM_ALERTS_ENABLED=true');
    process.exit(1);
  }

  console.log('✅ Telegram is configured. Running alert tests...\n');

  const tests = [
    { name: 'Inverter Disconnected', fn: alertInverterDisconnected },
    { name: 'Inverter Reconnected', fn: alertInverterReconnected },
    { name: 'PV Connection Lost', fn: alertPvDisconnected },
    { name: 'PV Connection Restored', fn: alertPvReconnected },
    { name: 'PV String Loss Detected', fn: alertPvStringLoss }
  ];

  for (const test of tests) {
    try {
      console.log(`🔔 Sending: ${test.name}...`);
      await test.fn();
      console.log(`✅ Success: ${test.name}\n`);
      // Small delay between alerts to avoid throttling
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (err) {
      console.error(`❌ Failed: ${test.name}`);
      console.error(`   Error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  console.log('📊 Test run complete. Check your Telegram for incoming messages.');
  console.log('   If no messages appeared, verify:');
  console.log('   - Bot token is valid');
  console.log('   - Chat ID is correct');
  console.log('   - Your Telegram bot accepts messages from this account\n');
}

runTests().catch(err => {
  console.error('Test script error:', err);
  process.exit(1);
});
