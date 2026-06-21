/**
 * Centralized Logging Module
 * Writes logs to both console and a shared JSON file for real-time dashboard access
 */

import fs from 'fs';
import path from 'path';
import { LOGS_DIR } from '../config/constants.js';

const COMBINED_LOG_FILE = path.resolve(LOGS_DIR, 'combined.jsonl');
const MAX_COMBINED_SIZE = 10 * 1024 * 1024; // 10MB - rotate when exceeded

// Save original console methods before we override them
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
};

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  time: string;
  level: LogLevel;
  source: string;
  message: string;
}

/**
 * Get the service source name
 */
function getSourceName(): string {
  const role = process.env.SERVICE_ROLE || 'monolith';
  if (role === 'monolith') {
    return 'server';
  }
  return role;
}

/**
 * Write a log entry to the combined log file
 */
function writeToFile(entry: LogEntry) {
  try {
    // Ensure logs directory exists
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    // Check if file size exceeds limit, rotate if needed
    if (fs.existsSync(COMBINED_LOG_FILE)) {
      const stats = fs.statSync(COMBINED_LOG_FILE);
      if (stats.size > MAX_COMBINED_SIZE) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const rotatedName = path.resolve(LOGS_DIR, `combined-${timestamp}.jsonl`);
        fs.renameSync(COMBINED_LOG_FILE, rotatedName);
      }
    }

    // Append log entry to combined.jsonl
    fs.appendFileSync(COMBINED_LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    // Use original console to avoid recursion
    originalConsole.error('Failed to write log:', err);
  }
}

/**
 * Central log function
 */
export function log(message: string, level: LogLevel = 'info') {
  const timestamp = new Date().toISOString();
  const source = getSourceName();

  const entry: LogEntry = {
    time: timestamp,
    level,
    source,
    message,
  };

  // Format for console output
  const levelEmoji = {
    info: 'ℹ️ ',
    warn: '⚠️ ',
    error: '❌',
    debug: '🐛',
  }[level];

  const consoleMessage = `[${timestamp}] [${source}] ${message}`;

  // Output to console using ORIGINAL methods to avoid recursion
  if (level === 'error') {
    originalConsole.error(levelEmoji + ' ' + consoleMessage);
  } else if (level === 'warn') {
    originalConsole.warn(levelEmoji + ' ' + consoleMessage);
  } else if (level === 'debug') {
    originalConsole.log(levelEmoji + ' ' + consoleMessage);
  } else {
    originalConsole.log(consoleMessage);
  }

  // Write to file
  writeToFile(entry);
}

/**
 * Convenience functions
 */
export const logger = {
  info: (msg: string) => log(msg, 'info'),
  warn: (msg: string) => log(msg, 'warn'),
  error: (msg: string) => log(msg, 'error'),
  debug: (msg: string) => log(msg, 'debug'),
};

/**
 * Initialize logging by overriding console methods
 * This captures all console.log/error/warn calls and routes them through the logger
 */
export function initializeLogging() {
  console.log = (...args) => {
    const message = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');
    log(message, 'info');
  };

  console.error = (...args) => {
    const message = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');
    log(message, 'error');
  };

  console.warn = (...args) => {
    const message = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');
    log(message, 'warn');
  };
}
