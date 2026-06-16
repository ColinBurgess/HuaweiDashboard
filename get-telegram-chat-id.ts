#!/usr/bin/env node

/**
 * Helper script to get your Telegram Chat ID for bot alerts
 *
 * Usage:
 *   1. Send a message to your bot on Telegram (@sun2000Monitorbot)
 *   2. Run: pnpm run get-chat-id
 *   3. Copy the Chat ID and add to .env: TELEGRAM_CHAT_ID=<id>
 */

import fetch from 'node-fetch';

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('❌ Error: TELEGRAM_BOT_TOKEN not set in .env');
  process.exit(1);
}

async function getChatId() {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
    const data = (await response.json()) as { ok: boolean; result: Array<{ message?: { chat: { id: number } } }> };

    if (!data.ok) {
      console.error('❌ Failed to fetch updates from Telegram API');
      console.error('Make sure TELEGRAM_BOT_TOKEN is correct');
      process.exit(1);
    }

    const updates = data.result || [];
    if (updates.length === 0) {
      console.log('❌ No messages found. Steps:');
      console.log('   1. Open Telegram and search for @sun2000Monitorbot');
      console.log('   2. Send a message to the bot (any message works)');
      console.log('   3. Run this script again: pnpm run get-chat-id');
      process.exit(1);
    }

    const lastMessage = updates[updates.length - 1];
    if (!lastMessage.message) {
      console.error('❌ No message found in last update');
      process.exit(1);
    }

    const chatId = lastMessage.message.chat.id;
    console.log('\n✅ Found your Chat ID:');
    console.log(`\n   TELEGRAM_CHAT_ID=${chatId}\n`);
    console.log('📝 Add this to your .env file');
    console.log('   Then set: TELEGRAM_ALERTS_ENABLED=true\n');
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

getChatId();
