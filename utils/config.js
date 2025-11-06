// config.js
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chokidar from 'chokidar';
import { z } from 'zod';
import YAML from 'yaml';
import { info, error, warn } from './logger.js';

// --- Project Root Discovery ---
function findProjectRoot() {
  let currentDir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.existsSync(path.join(currentDir, 'package.json'))) {
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error('Could not find project root containing a package.json file.');
    }
    currentDir = parentDir;
  }
}

export const PROJECT_ROOT = findProjectRoot();

// --- .env File Loading ---
const envPath = path.resolve(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  info(`Loaded environment variables from ${envPath}`);
} else {
  info(`.env file not found at ${envPath}, continuing without it.`);
}

// --- Configuration File Discovery ---
export function findConfigFile() {
  const candidates = ['config.yml', 'config.yaml', 'config.json'];
  for (const name of candidates) {
    const p = path.resolve(PROJECT_ROOT, name);
    if (fs.existsSync(p)) {
      info(`Using config file: ${p}`);
      return p;
    }
  }
  const defaultPath = path.resolve(PROJECT_ROOT, 'config.yml');
  info(`No config file found. Defaulting to: ${defaultPath}`);
  return defaultPath;
}

const CONFIG_PATH = findConfigFile();
const LAST_CONFIG_PATH = path.resolve(PROJECT_ROOT, 'data', 'config', '.last.json');

// --- Sensitive Keys (for logging and snapshot masking) ---
const SENSITIVE_KEYS = [
    'ADMIN_TOKEN', 
    'SESSION_ID', 
    'SENTRY_DSN', 
    'DATABASE_URL',
    'FOOTBALL_API_KEY', 
    'CLOUDINARY_API_KEY', 
    'CLOUDINARY_API_SECRET',
    'OMDB_API_KEY',
    'OPENWEATHER_API_KEY'
];

// --- Hot Reloading Setup ---
const watcher = chokidar.watch(CONFIG_PATH, { persistent: true, ignoreInitial: true });
const reloadListeners = [];

export function hotReloadConfig(cb) {
  if (typeof cb === 'function') {
    reloadListeners.push(cb);
  }
}

// --- Configuration Schema (using Zod) ---
const ConfigSchema = z.object({
  // General
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  TIMEZONE: z.string().default('Africa/Nairobi'),
 
  // Logger Settings
  LOG_LEVEL: z.string().default('info'),
  LOG_DIR: z.string().default('Bookielogs'),
  PROD_LOG_FILENAME: z.string().default('prod.log'),
  DEV_LOG_FILENAME: z.string().default('dev.log'),
  LOG_ROTATION_FREQUENCY: z.string().default('daily'),
  LOG_ROTATION_SIZE: z.string().default('10M'),
  LOG_QUERIES: z.boolean().default(false),
  SENTRY_DSN: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.number().min(0).max(1).default(1.0),

  // Module Loader & Health Monitoring
  BOOKIES_DIR_NAME: z.string().default('carl'),
  MODULES_DIRECTORY: z.string().default('modules'),
  CARL_DIRECTORY: z.string().default('carl'),
  MODULE_CONCURRENCY_LIMIT: z.number().min(1).default(5),
  ALLOWED_MODULE_EXTENSIONS: z.array(z.string()).default(['.js', '.mjs', '.cjs']),
  MAX_MODULE_FILE_SIZE_WARN_BYTES: z.number().min(0).default(1048576),
  MAX_HANDLERS_WARNING_THRESHOLD: z.number().min(1).default(100),
  MODULE_RELOAD_DEBOUNCE_MS: z.number().min(0).default(300),
  HEALTH_CHECK_INTERVAL_MS: z.number().min(0).default(60000),
  HIGH_MEMORY_USAGE_WARN_MB: z.number().min(0).default(100),
  CRITICAL_MEMORY_USAGE_MB: z.number().min(0).default(100),
  KILL_ON_HIGH_MEMORY: z.boolean().default(false),
  MODULE_STATS_INTERVAL_MS: z.number().min(0).default(300000),
  BOT_HOOKS_KEY_SYMBOL: z.string().default('@@myBotHooksAttached'),

  // Database Settings
  DB_PATH: z.string().default('data/db'),
  DB_NAME: z.string().default('bot.db'),
  DB_BATCH_SIZE: z.number().min(1).default(100),
  DB_FLUSH_INTERVAL: z.number().min(1000).default(5000),
  DB_CACHE_MAX_BYTES: z.number().min(0).default(500 * 1024 * 1024),
  DATABASE_URL: z.string().url().optional(),

  // Listener Manager Settings
  ATTACH_WATCHER_MS: z.number().min(500).default(3000),
  SOCK_MONITOR_MS: z.number().min(500).default(1500),

  // Baileys & Bot Settings
  BAILEYS_PINO_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('error'),
  CACHE_TTL_MS: z.number().min(0).default(60 * 1000),
  CACHE_MAX_SIZE_BYTES: z.number().min(0).default(20 * 1024 * 1024),
  MEMORY_STORE_MAX_BYTES: z.number().min(0).default(500 * 1024 * 1024),
  AUTH_STATE_DIR: z.string().default('.auth'),
  SESSION_ID: z.string().optional(),
  ADMIN_TOKEN: z.string().optional(),
  BAILEYS_BROWSER: z.tuple([z.string(), z.string(), z.string()]).default(['lwskky', 'Chrome', '19.1.0']),
  AUTH_WAL_MAX_FILE_SIZE_KB: z.number().min(1).default(1024),
  AUTH_WAL_MAX_LINES: z.number().min(100).default(10000),
  AUTH_WAL_REWRITE_INTERVAL_MS: z.number().min(0).default(5 * 60 * 1000),
  RATE_LIMIT: z.array(z.object({
      window: z.number().min(100),
      limit: z.number().min(1)
  })).default([{ window: 1000, limit: 5 }, { window: 60000, limit: 20 }]),
  OUTGOING_MAX_QUEUE: z.number().min(0).default(2000),
  SEND_RETRY_ATTEMPTS: z.number().min(0).default(2),
  SEND_RETRY_BASE_MS: z.number().min(0).default(500),
  CONTACT_CACHE_TTL_MS: z.number().min(0).default(60 * 60 * 1000),
  CHAT_CACHE_TTL_MS: z.number().min(0).default(30 * 60 * 1000),
  DLQ_PATH: z.string().default('.dlq'),
  DLQ_MAX_SIZE_BYTES: z.number().min(0).default(1024 * 1024),
  DLQ_MAX_FILES: z.number().min(0).default(5),
  COMMAND_PREFIX: z.union([z.null(), z.array(z.string()).min(1), z.string()]).optional().default(null),
  SHUTDOWN_DRAIN_MS: z.number().min(0).default(5000),
  PROJECT_ROOT: z.string().default(process.cwd()),
  ALLOW_GROUP_COMMANDS: z.boolean().default(false),
 
  // API Keys
  FOOTBALL_API_KEY: z.string().optional(),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  OMDB_API_KEY: z.string().optional(),
  OPENWEATHER_API_KEY: z.string().optional(),

  // --- MODULE-SPECIFIC SETTINGS ---
  // SPAM Module (matches defaults in spam.js CFG)
  SPAM: z.object({
    SPAM_THRESHOLD: z.number().min(1).default(5),
    SPAM_WINDOW_MS: z.number().min(0).default(4000),
    SPAM_COOLDOWN_MS: z.number().min(0).default(5000),
    MAX_WARNINGS: z.number().min(1).default(3),
    WARN_EXPIRY_MS: z.number().min(0).default(7 * 24 * 60 * 60 * 1000),
    KICK_ON_SPAM: z.boolean().default(true),
    WARNING_MESSAGE: z.string().default('⚠️ {user}, stop spamming. Remaining warnings: {warnings}'),
    WARNING_TTL_MS: z.number().min(0).default(50000)
  }).optional().default({}),

  // Additions Module
  ADDITIONS: z.object({
    DEFAULT_ENABLED: z.boolean().default(true),
    DEBOUNCE_MS: z.number().min(0).default(3000),
    SEND_IN_GROUP: z.boolean().default(true),
  }).optional().default({}),

  // Antilink Module
  ANTILINK: z.object({
    DEFAULT_ENABLED: z.boolean().default(true),
    SEND_WARNING: z.boolean().default(true),
    WARNING_MESSAGE: z.string().default('🔗 {user}, links are not allowed here. Remaining warnings {warnings}'),
    WARNING_TTL_MS: z.number().min(0).default(5000),
    WHITE_LIST: z.array(z.string()).default([]),
    BATCH_SIZE: z.number().min(1).default(10),
    BATCH_DELAY_MS: z.number().min(0).default(800),
    GLOBAL_CONCURRENCY: z.number().min(1).default(2),
    DELETE_RETRY_COUNT: z.number().min(0).default(3),
    DELETE_RETRY_INITIAL_BACKOFF_MS: z.number().min(0).default(400),
    PER_CHAT_QUEUE_LIMIT: z.number().min(1).default(1000),
    DEDUPE_TTL_MS: z.number().min(0).default(5000),
    MAX_WARNINGS: z.number().min(1).default(3),
    WARN_RESET_MS: z.number().min(0).default(0),
    REMOVE_ON_MAX: z.boolean().default(true),
    EXPRESSIONS: z.array(z.string()).default([]),
    VALIDATION_TIMEOUT_MS: z.number().min(100).default(4000),
    LOG_DELETED_LINKS: z.boolean().default(true),
  }).optional().default({}),

  // Anti-Viewonce Module
  VIEWONCE_SKIP_IF_TARGET_EQUALS_SOURCE: z.boolean().default(true),
  VIEWONCE_ALLOW_GROUP_COMMANDS_DEFAULT: z.boolean().default(false),

  // Autoreact Status Module
  AUTOREACT_STATUS: z.object({
    MIN_INTERVAL_MS: z.number().min(0).default(5000),
    IGNORE_BOT_USER: z.boolean().default(false),
    REACTIONS: z.union([z.array(z.string()), z.string()]).default(['🚀', '🌎', '♻️']),
  }).optional().default({}),
  
  // Autoview Status & Read Receipts
  AUTOVIEWSTATUS: z.boolean().default(false),
  AUTOREAD_MESSAGES: z.boolean().default(false),

  // Delete Recovery Module
  DELETE_MEDIA_DIRNAME: z.string().default('media'),
  DELETE_DEBOUNCE_MS: z.number().min(0).default(3000),
  DELETE_CONCURRENCY: z.number().min(1).default(3),
  DEFAULT_SEND_DELETE: z.boolean().default(true),
  DELETE_CLEANUP_DAYS: z.number().min(1).default(3),
  DELETE_CLEANUP_INTERVAL_MS: z.number().min(0).default(6 * 60 * 60 * 1000),
  DELETE_MEDIA_SEND_DELAY_MS: z.number().min(0).default(300),
  DELETE_MAX_SEND_RETRIES: z.number().min(0).default(3),
  DELETE_INITIAL_BACKOFF_MS: z.number().min(0).default(500),

  // Filter Module
  FILTERS: z.object({
    TYPING_SIM_MS: z.number().min(0).max(15000).default(0),
    RESPONSE_MODE: z.enum(['roundrobin', 'random']).default('roundrobin'),
  }).optional().default({}),

  // Lock Module
  LOCKS: z.object({
      DEFAULT_ENABLED: z.boolean().default(true),
      SEND_WARNING: z.boolean().default(true),
      WARNING_MESSAGE: z.string().default('⚠️ {user}, that word is not allowed.'),
      WARNING_TTL_MS: z.number().min(0).default(5000),
      PER_CHAT_QUEUE_LIMIT: z.number().min(1).default(500),
      BATCH_SIZE: z.number().min(1).default(5),
      BATCH_DELAY_MS: z.number().min(0).default(500),
      GLOBAL_CONCURRENCY: z.number().min(1).default(3),
      NORMALIZE_REMOVE_DIACRITICS: z.boolean().default(false),
  }).optional().default({}),
  
  // Movie Module
  MOVIE: z.object({
    NEWSLETTER_IMAGES: z.array(z.string().url()).default([
        'https://files.thebookiebasher.win/media/tct2.jpg',
        'https://files.thebookiebasher.win/media/tct5.jpg',
        'https://files.thebookiebasher.win/media/movie.jpg'
    ])
  }).optional().default({}),

  // Scheduler Module
  SCHED_CHECK_INTERVAL_MS: z.number().min(1000).default(60000),
  SCHED_DEFAULT_TIMEZONE: z.string().default('Africa/Nairobi'),
  SCHED_SEND_RETRIES: z.number().min(0).default(3),
  SCHED_INITIAL_BACKOFF_MS: z.number().min(100).default(500),

  // Status Lock Module
  STATUS_BROADCAST_DEFAULT_ENABLED: z.boolean().default(true),
  STATUS_BROADCAST_DEFAULT_WARN: z.string().default('*⚠️WARN MESSAGE⚠️*\n\n*USER:* {user}\n*MAX WARNINGS:* {max_warns}\n*REMAINING WARNINGS:* {remaining_warns}\n*REASON:* {reason}'),
  STATUS_BROADCAST_DEFAULT_MAX_WARN: z.number().min(1).default(3),
  STATUS_BROADCAST_DEFAULT_REASON: z.string().default('Posting status broadcasts.'),
  STATUS_BROADCAST: z.object({
      DEDUPE_TTL_MS: z.number().min(1000).default(30000),
  }).optional().default({}),

  // Status Recovery Module
  STATUS_RECOVERY_DIR: z.string().default('data/status'),
  STATUS_RECOVERY_CLEANUP_INTERVAL_MS: z.number().min(60000).default(24 * 60 * 60 * 1000),
  STATUS_RECOVERY_KEEP_SECONDS: z.number().min(3600).default(24 * 60 * 60),
  STATUS_RECOVERY_RESPONDED_LIMIT: z.number().min(100).default(5000),
  STATUS_RECOVERY_RESPONDED_TRIM_KEEP: z.number().min(100).default(3000),
  STATUS_RECOVERY_MAX_DOWNLOAD_BYTES_WARN: z.number().min(1024).default(10 * 1024 * 1024),

  // Status Autosend Module
  STATUS_AUTOSEND_RESPONDED_LIMIT: z.number().min(100).default(5000),
  STATUS_AUTOSEND_RESPONDED_TRIM_KEEP: z.number().min(100).default(3000),
  STATUS_AUTOSEND_MAX_DOWNLOAD_BYTES_WARN: z.number().min(1024).default(10 * 1024 * 1024),
  
  // Warn Module
  WARN_SYSTEM: z.object({
      MAX_WARNS: z.number().min(1).default(3),
      WARN_MESSAGE: z.string().default('*⚠️WARN MESSAGE⚠️*\n\n*USER:* {user}\n*MAX WARNINGS:* {max_warns}\n*REMAINING WARNINGS:* {remaining_warns}\n*REASON:* {reason}'),
      DEFAULT_REASON: z.string().default('Breaking group rules.'),
      SHOW_TRIGGER_IN_REASON: z.boolean().default(true),
  }).optional().default({}),
  
  // Welcome Module
  WELCOME: z.object({
      DEFAULT_ENABLED: z.boolean().default(true),
      GROUP_SIZE_CACHE_TTL_MS: z.number().min(0).default(5 * 60 * 1000),
      WHATSAPP_GROUP_MAX: z.number().min(1).default(1025),
      DEBOUNCE_MS: z.number().min(0).default(2000),
  }).optional().default({})

});

let config = {};

function readConfigFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const ext = path.extname(filePath).toLowerCase();
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    if (ext === '.yml' || ext === '.yaml') {
      return YAML.parse(raw) || {};
    } else if (ext === '.json') {
      return JSON.parse(raw);
    }
  } catch (err) {
    error(`Failed to parse config file at ${filePath}:`, err);
    throw err;
  }
  return {};
}

function loadConfig() {
  // Determine if this is the first run by checking for the snapshot file's existence.
  const isFirstRun = !fs.existsSync(LAST_CONFIG_PATH);
  let prevSnapshot = {};

  // If it's not the first run, load the previous snapshot.
  if (!isFirstRun) {
    try {
      prevSnapshot = JSON.parse(fs.readFileSync(LAST_CONFIG_PATH, 'utf8'));
    } catch (e) {
      warn('Failed to read previous config snapshot. Treating as a new run:', e);
      // If the file is corrupt, we'll treat it like a first run by leaving prevSnapshot empty.
    }
  }

  const fileCfg = readConfigFile(CONFIG_PATH);

  const merged = {
    ...fileCfg,
    // load timezone from .env (preferred), or from config file if not present.
    TIMEZONE: process.env.TIMEZONE ?? process.env.TZ ?? fileCfg.TIMEZONE,
    // scheduler timezone can also be set via .env
    SCHED_DEFAULT_TIMEZONE: process.env.SCHED_DEFAULT_TIMEZONE ?? process.env.TIMEZONE ?? process.env.TZ ?? fileCfg.SCHED_DEFAULT_TIMEZONE,
    SESSION_ID: process.env.SESSION_ID ?? fileCfg.SESSION_ID,
    ADMIN_TOKEN: process.env.ADMIN_TOKEN ?? fileCfg.ADMIN_TOKEN,
    SENTRY_DSN: process.env.SENTRY_DSN ?? fileCfg.SENTRY_DSN,
    DATABASE_URL: process.env.DATABASE_URL ?? fileCfg.DATABASE_URL,
    FOOTBALL_API_KEY: process.env.FOOTBALL_API_KEY ?? fileCfg.FOOTBALL_API_KEY,
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME ?? fileCfg.CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY ?? fileCfg.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET ?? fileCfg.CLOUDINARY_API_SECRET,
    OMDB_API_KEY: process.env.OMDB_API_KEY ?? fileCfg.OMDB_API_KEY,
    OPENWEATHER_API_KEY: process.env.OPENWEATHER_API_KEY ?? fileCfg.OPENWEATHER_API_KEY,
  };

  try {
    config = ConfigSchema.parse(merged);
    if (isFirstRun) {
      info('Initial configuration loaded. A snapshot has been created for future comparisons.');
    } else {
      info('Configuration validated successfully.');
    }
  } catch (e) {
    error('Configuration validation failed:', e.errors);
    process.exit(1);
  }

  // Log where the timezone came from (env vs config file vs default)
  if (process.env.TIMEZONE || process.env.TZ || process.env.SCHED_DEFAULT_TIMEZONE) {
    info(`Timezone loaded from environment: TIMEZONE=${config.TIMEZONE}, SCHED_DEFAULT_TIMEZONE=${config.SCHED_DEFAULT_TIMEZONE}`);
  } else if (fileCfg.TIMEZONE || fileCfg.SCHED_DEFAULT_TIMEZONE) {
    info(`Timezone loaded from config file: TIMEZONE=${config.TIMEZONE}, SCHED_DEFAULT_TIMEZONE=${config.SCHED_DEFAULT_TIMEZONE}`);
  } else {
    info(`Timezone using default values: TIMEZONE=${config.TIMEZONE}, SCHED_DEFAULT_TIMEZONE=${config.SCHED_DEFAULT_TIMEZONE}`);
  }

  // Only compare and log changes on subsequent runs where a valid snapshot exists.
  if (!isFirstRun && Object.keys(prevSnapshot).length > 0) {
    const changedKeys = Object.keys(config).filter(k => {
        // For sensitive keys, we only detect if they are added or removed, not changed.
        // This is a trade-off for not storing sensitive values in the snapshot file.
        if (SENSITIVE_KEYS.includes(k)) {
            const isPresent = config[k] !== undefined && config[k] !== null;
            const wasPresent = prevSnapshot[k] !== undefined && prevSnapshot[k] !== null;
            return isPresent !== wasPresent;
        }
        // For all other keys, compare their stringified values.
        return JSON.stringify(config[k]) !== JSON.stringify(prevSnapshot[k])
    });

    if (changedKeys.length) {
      const safeLog = changedKeys.map(k => 
          `${k}=${SENSITIVE_KEYS.includes(k) ? '"***"' : JSON.stringify(config[k])}`
      ).join(', ');
      info(`Config keys changed: ${safeLog}`);
    }
    
    // Trigger listeners only if there were actual changes.
    if (changedKeys.length > 0 && reloadListeners.length > 0) {
      reloadListeners.forEach(fn => {
        try {
          fn(changedKeys);
        } catch (e) {
          warn('A hotReload listener threw an error:', e);
        }
      });
    }
  }

  // Create a sanitized config for saving to the file system.
  const sanitizedConfigForSnapshot = { ...config };
  for (const key of SENSITIVE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(sanitizedConfigForSnapshot, key) && sanitizedConfigForSnapshot[key]) {
      sanitizedConfigForSnapshot[key] = '***';
    }
  }

  try {
    fs.mkdirSync(path.dirname(LAST_CONFIG_PATH), { recursive: true });
    // Write the sanitized version to the file.
    fs.writeFileSync(LAST_CONFIG_PATH, JSON.stringify(sanitizedConfigForSnapshot, null, 2));
  } catch (err) {
    warn('Failed to save config snapshot:', err);
  }
}

loadConfig();

watcher.on('change', () => {
  info('Config file changed. Reloading...');
  try {
    loadConfig();
  } catch (e) {
    error('Error during config hot-reload:', e);
  }
});

export function getConfig() {
  return config;
}
