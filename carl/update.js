import fs from 'fs/promises';
import path from 'path';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { DateTime } from 'luxon';
import { info, warn, error } from '../utils/logger.js';
import { db } from '../utils/database.js';
import { isSudo, listSudo, normalizeToJid, userJidFromCtx } from '../utils/sudo.js';
import { getBotJid } from '../utils/bot-state.js';
import { startManagedListener, stopManagedListener } from '../utils/listenerManager.js';

const exec = promisify(execCb);

export const name = 'update';
export const version = '2.1.5';
export const priority = 50;
export const commands = ['update', 'autoupdate'];

let botRef = null;
let schedulerInterval = null;
let schedulerRunning = false;
const API_URL = 'https://i-tct.com/build';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const snapshotPath = path.join(projectRoot, 'data', 'tmp', '.update.json');
// Path to removed plugins JSON (used by plugin.js)
const removedPluginsPath = path.join(projectRoot, 'data', 'tmp', '.removed.json');

// --- Database Section ---
async function ensureSchema() {
    try {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS update_settings (
                setting_key TEXT PRIMARY KEY,
                enabled INTEGER DEFAULT 0,
                last_checked_at INTEGER,
                next_check_at INTEGER
            );
        `);
        const row = await db.get("SELECT * FROM update_settings WHERE setting_key = 'autoupdate'");
        if (!row) {
            await db.run("INSERT INTO update_settings (setting_key) VALUES ('autoupdate')");
        }
        info(`[${name}] DB schema ensured.`);
    } catch (e) {
        error(e, `[${name}] DB schema initialization failed`);
        throw e;
    }
}

async function getAutoUpdateSettings() {
    try {
        const row = await db.get("SELECT * FROM update_settings WHERE setting_key = 'autoupdate'");
        return {
            enabled: !!row?.enabled,
            lastCheckedAt: row?.last_checked_at || null,
            nextCheckAt: row?.next_check_at || null,
        };
    } catch (e) {
        error(e, `[${name}] Failed to get autoupdate settings`);
        return { enabled: false, lastCheckedAt: null, nextCheckAt: null };
    }
}

async function setAutoUpdateStatus(enabled) {
    try {
        const nextCheck = enabled ? DateTime.now().plus({ hours: 24 }).toSeconds() : null;
        await db.run(
            "UPDATE update_settings SET enabled = ?, next_check_at = ? WHERE setting_key = 'autoupdate'",
            [enabled ? 1 : 0, nextCheck]
        );
        if (enabled) await updateCheckTimestamps();
        return true;
    } catch (e) {
        error(e, `[${name}] Failed to set autoupdate status`);
        return false;
    }
}

async function updateCheckTimestamps() {
    try {
         const now = Math.floor(Date.now() / 1000);
         const nextCheck = DateTime.now().plus({ hours: 24 }).toSeconds();
         await db.run(
             "UPDATE update_settings SET last_checked_at = ?, next_check_at = ? WHERE setting_key = 'autoupdate'",
             [now, Math.floor(nextCheck)]
         );
    } catch (e) {
        error(e, `[${name}] Failed to update check timestamps`);
    }
}

// --- Core Update Logic ---
async function safeSend(destination, text) {
    if (!destination) {
        warn(`[${name}] safeSend called with no destination.`);
        return;
    }
    try {
        // --- FIX ---
        // Used optional chaining (?.) on botRef.
        // If botRef is null or undefined, the expression will safely
        // evaluate to undefined instead of throwing an error.
        const api = botRef?.sendMessage || botRef?.sock?.sendMessage;
        
        if (api) {
            await api(destination, { text });
        } else {
            // Log a more informative error instead of crashing
            error(`[${name}] No send API available. botRef is likely null or not initialized. Cannot send to ${destination}`);
        }
    } catch (e) {
        error(e, `[${name}] Failed to send message to ${destination}`);
    }
}

async function fetchBuildInfo() {
    try {
        const response = await fetch(API_URL);
        if (!response.ok) throw new Error(`API request failed: ${response.status}`);
        return await response.json();
    } catch (e) {
        error(e, `[${name}] Failed to fetch build info`);
        return null;
    }
}

async function getLocalSnapshot() {
    try {
        const data = await fs.readFile(snapshotPath, 'utf-8');
        return JSON.parse(data);
    } catch (e) {
        return null;
    }
}

async function saveLocalSnapshot(data) {
    try {
        await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
        await fs.writeFile(snapshotPath, JSON.stringify(data, null, 2));
    } catch (e) {
        error(e, `[${name}] Failed to save local snapshot`);
    }
}

async function createInitialSnapshotIfNeeded() {
    const snapshot = await getLocalSnapshot();
    if (!snapshot) {
        info(`[${name}] No local snapshot found. Creating one on first run...`);
        const remoteBuild = await fetchBuildInfo();
        if (remoteBuild) {
            await saveLocalSnapshot(remoteBuild);
            info(`[${name}] Initial snapshot created successfully.`);
        } else {
            warn(`[${name}] Could not create initial snapshot. Update checks may be inaccurate.`);
        }
    }
}

function getDestinationPath(file) {
    const rootFiles = ['bot.js', 'start.cjs', 'package.json', 'qrcode.js'];
    if (file.origin === 'carl') return path.join(projectRoot, 'carl', file.name);
    if (file.origin === 'modules') return path.join(projectRoot, 'modules', file.name);
    if (rootFiles.includes(file.name)) return path.join(projectRoot, file.name);
    return path.join(projectRoot, 'utils', file.name);
}

/**
 * applyUpdates returns:
 * { updatedPluginFiles: [], updatedCoreFiles: [], needsReboot: bool }
 * updatedPluginFiles => array of names from 'carl' and 'modules' (basename without .js)
 * updatedCoreFiles => array of names from other origins
 *
 * IMPORTANT: We compare downloaded content with the existing file and only write if different.
 */
async function applyUpdates(filesToUpdate) {
    let needsReboot = false;
    const updatedPluginFiles = [];
    const updatedCoreFiles = [];

    for (const file of filesToUpdate) {
        if (!file || !file.download) {
            warn(`[${name}] Missing download for ${file?.name ?? '<unknown>'}; skipping.`);
            continue;
        }

        const destPath = getDestinationPath(file);
        try {
            const response = await fetch(file.download);
            if (!response.ok) {
                warn(`[${name}] Failed to download ${file.name}: ${response.status}`);
                continue;
            }

            // Downloaded content as text (JS files are text)
            const content = await response.text();

            // Compare with existing file content (if exists). If identical, skip writing.
            let existing = null;
            try {
                existing = await fs.readFile(destPath, 'utf-8');
            } catch (e) {
                // file doesn't exist or can't read — treat as new
                existing = null;
            }

            if (existing !== null && existing === content) {
                // Exactly identical content -> skip write and do not count as updated
                info(`[${name}] Skipped writing ${file.name} — content unchanged.`);
                continue;
            }

            // Otherwise write file and count it as updated
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            await fs.writeFile(destPath, content, 'utf-8');

            if (file.origin === 'carl' || file.origin === 'modules') {
                updatedPluginFiles.push(String(file.name).replace(/\.js$/, ''));
            } else {
                updatedCoreFiles.push(file.name);
            }
            info(`[${name}] Wrote update for ${file.name} -> ${destPath}`);
        } catch (e) {
            warn(e, `[${name}] Error while updating ${file.name}`);
        }
    }

    // If package.json was actually written (present in updatedCoreFiles), run yarn install
    const packageActuallyUpdated = updatedCoreFiles.includes('package.json');
    if (packageActuallyUpdated) {
        try {
            info(`[${name}] package.json changed. Running 'yarn install'...`);
            await exec('yarn install', { cwd: projectRoot });
            info(`[${name}] Dependencies installed successfully.`);
        } catch (e) {
            error(e, `[${name}] 'yarn install' failed.`);
            // Even if install fails, core was changed — keep reboot flag true.
        }
    }

    // Reboot only needed if any core files were actually updated
    if (updatedCoreFiles.length > 0) needsReboot = true;

    return { updatedPluginFiles, updatedCoreFiles, needsReboot };
}

// --- Removed plugins handling (read .removed.json produced by plugin.js) ---
async function getRemovedPluginsSet() {
    try {
        const raw = await fs.readFile(removedPluginsPath, 'utf-8').catch(() => null);
        if (!raw) return new Set();
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) return new Set();

        const names = data.map(item => {
            if (!item) return null;
            if (typeof item === 'string') return item;
            if (typeof item === 'object' && item.name) return item.name;
            return null;
        }).filter(Boolean).map(n => String(n).toLowerCase().replace(/\.js$/, ''));

        return new Set(names);
    } catch (e) {
        warn(e, `[${name}] Could not read removed plugins file; proceeding without exclusions.`);
        return new Set();
    }
}

// --- Scheduler ---
async function _schedulerTick() {
    if (schedulerRunning) return;
    schedulerRunning = true;

    try {
        const settings = await getAutoUpdateSettings();
        if (!settings.enabled) return;

        const now = DateTime.now();
        const nextCheck = settings.nextCheckAt ? DateTime.fromSeconds(settings.nextCheckAt) : now;

        if (now >= nextCheck) {
            info(`[${name}] Running scheduled auto-update check...`);
            await performAutomaticUpdate();
            await updateCheckTimestamps();
        }
    } catch (e) {
        error(e, `[${name}] Scheduler tick failed`);
    } finally {
        schedulerRunning = false;
    }
}

function startAutoUpdateScheduler() {
    stopAutoUpdateScheduler();
    const msToNextMinute = 60000 - (Date.now() % 60000);
    setTimeout(() => {
        _schedulerTick().catch(()=>{});
        schedulerInterval = setInterval(() => _schedulerTick().catch(()=>{}), 60 * 1000);
    }, msToNextMinute);
    info(`[${name}] Auto-update scheduler started.`);
}

function stopAutoUpdateScheduler() {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
    }
}

// --- Command Handlers ---
async function findStoredMatchFromFindings(findings = []) {
    try {
        const stored = await listSudo();
        if (!Array.isArray(stored) || stored.length === 0) return null;
        const storedSet = new Set(stored.map(String));
        for (const f of findings || []) {
            if (!f || typeof f.jid !== 'string') continue;
            const norm = normalizeToJid(f.jid);
            if (norm && storedSet.has(norm)) return norm;
            if (storedSet.has(f.jid)) return f.jid;
        }
        return null;
    } catch (e) { return null; }
}

async function handleManualUpdateCheck(destination) {
    await safeSend(destination, '🔄 Checking for updates...');
    const remoteBuild = await fetchBuildInfo();
    if (!remoteBuild) {
        await safeSend(destination, '🔄 Could not check for updates. Please try again later.');
        return;
    }
    const localSnapshot = await getLocalSnapshot();
    if (!localSnapshot || remoteBuild.lastModified !== localSnapshot.lastModified) {
        await safeSend(destination, '🔄 An update is available. Run `update now` to apply.');
    } else {
        await safeSend(destination, '🔄 Your bot is already up to date.');
    }
}

async function handleManualUpdateNow(destination) {
    await safeSend(destination, '🔄 Starting update process...');
    const remoteBuild = await fetchBuildInfo();
    const localSnapshot = await getLocalSnapshot();

    if (!remoteBuild || !localSnapshot) {
        await safeSend(destination, '🔄 Could not get update information. Aborting.');
        return;
    }

    const removedSet = await getRemovedPluginsSet();
    const localFilesMap = new Map(localSnapshot.files.map(f => [f.name, f]));
    const candidateFiles = remoteBuild.files.filter(rf => localFilesMap.get(rf.name)?.mtime !== rf.mtime);

    // compute skipped (only carl/modules) and filesToUpdate (only those not skipped)
    const skippedList = [];
    const filesToUpdate = [];
    for (const f of candidateFiles) {
        if (!f || !f.origin) {
            filesToUpdate.push(f);
            continue;
        }
        if (['carl', 'modules'].includes(f.origin)) {
            const base = String(f.name).toLowerCase().replace(/\.js$/, '');
            if (removedSet.has(base)) {
                skippedList.push(base);
                continue;
            }
        }
        filesToUpdate.push(f);
    }

    // If nothing to update, show skipped if any else say up to date
    if (filesToUpdate.length === 0) {
        await saveLocalSnapshot(remoteBuild);
        if (skippedList.length > 0) {
            const numbered = skippedList.map((n,i) => `${i+1}. ${n}`).join('\n');
            await safeSend(destination, `🔄 No applicable updates to apply.\n\nSkipped updating:\n${numbered}`);
        } else {
            await safeSend(destination, '🔄 Everything is already up to date.');
        }
        return;
    }

    // Apply updates
    const applyResult = await applyUpdates(filesToUpdate);
    if (!applyResult) {
        await safeSend(destination, '🔄 Update failed while applying updates.');
        return;
    }

    const { updatedPluginFiles, updatedCoreFiles, needsReboot } = applyResult;

    // If no actual writes occurred (downloads/writes were identical or failed), treat as "up to date"
    if (updatedPluginFiles.length === 0 && updatedCoreFiles.length === 0) {
        await saveLocalSnapshot(remoteBuild);
        if (skippedList.length > 0) {
            const numbered = skippedList.map((n,i) => `${i+1}. ${n}`).join('\n');
            await safeSend(destination, `🔄 No applicable updates were applied.\n\nSkipped updating:\n${numbered}`);
        } else {
            await safeSend(destination, '🔄 Everything is already up to date.');
        }
        return;
    }

    // Build reply: list updated plugins (<=10) and only mention core if real core updates happened
    const parts = [];

    if (updatedPluginFiles.length > 0) {
        if (updatedPluginFiles.length <= 10) {
            const numbered = updatedPluginFiles.map((n,i) => `${i+1}. ${n}`).join('\n');
            parts.push('🔄 Updated plugins:\n' + numbered);
        } else {
            parts.push('🔄 Updated plugins: More than 10 plugin files were updated.');
        }
    }

    if (updatedCoreFiles.length > 0) {
        parts.push('🔄 Updated core components.');
    }

    if (parts.length === 0) parts.push('🔄 Update completed.');

    if (updatedCoreFiles.length > 0 || needsReboot) {
        parts.push('\nPlease run the `reboot` command for the core changes to take effect.');
    }

    const reply = parts.join('\n\n');
    await safeSend(destination, reply);

    // Save snapshot regardless
    await saveLocalSnapshot(remoteBuild);
}

async function performAutomaticUpdate() {
    const remoteBuild = await fetchBuildInfo();
    const localSnapshot = await getLocalSnapshot();
    if (!remoteBuild || !localSnapshot || remoteBuild.lastModified === localSnapshot.lastModified) {
        return; // No updates, do nothing.
    }

    const removedSet = await getRemovedPluginsSet();
    const localFilesMap = new Map(localSnapshot.files.map(f => [f.name, f]));
    const candidateFiles = remoteBuild.files.filter(rf => localFilesMap.get(rf.name)?.mtime !== rf.mtime);

    if (candidateFiles.length === 0) {
       await saveLocalSnapshot(remoteBuild);
       return;
    }

    // Filter out removed plugins (only for carl/modules)
    const skippedList = [];
    const filesToUpdate = [];
    for (const f of candidateFiles) {
        if (!f || !f.origin) {
            filesToUpdate.push(f);
            continue;
        }
        if (['carl', 'modules'].includes(f.origin)) {
            const base = String(f.name || '').toLowerCase().replace(/\.js$/, '');
            if (removedSet.has(base)) {
                skippedList.push(base);
                continue;
            }
        }
        filesToUpdate.push(f);
    }

    if (filesToUpdate.length === 0) {
        info(`[${name}] Auto-update: nothing to apply after filtering ${skippedList.length} removed plugin(s).`);
        await saveLocalSnapshot(remoteBuild);
        return;
    }

    info(`[${name}] Auto-update found ${filesToUpdate.length} new files (skipped ${skippedList.length} removed). Applying...`);
    const applyResult = await applyUpdates(filesToUpdate);
    if (!applyResult) {
        warn(`[${name}] Auto-update: applyUpdates returned no result.`);
        await saveLocalSnapshot(remoteBuild);
        return;
    }

    const { updatedPluginFiles, updatedCoreFiles, needsReboot } = applyResult;

    // If nothing was actually written, treat as no-op
    if (updatedPluginFiles.length === 0 && updatedCoreFiles.length === 0) {
        info(`[${name}] Auto-update: no files were written (downloads may have been identical). Skipped ${skippedList.length} removed plugin(s).`);
        await saveLocalSnapshot(remoteBuild);
        return;
    }

    // Notify owner only if core updated, otherwise log plugin updates
    if (updatedCoreFiles.length > 0) {
        info(`[${name}] Auto-update applied core updates. Notifying owner.`);
        const botJid = getBotJid();
        if (botJid) {
            const parts = [];
            if (updatedPluginFiles.length > 0) {
                if (updatedPluginFiles.length <= 10) {
                    parts.push('Updated plugins:\n' + updatedPluginFiles.map((n,i)=>`${i+1}. ${n}`).join('\n'));
                } else {
                    parts.push('Updated plugins: More than 10 plugin files were updated.');
                }
            }
            parts.push('Updated core components.');
            await safeSend(botJid, `ℹ️ Automatic Update Notice:\n\n${parts.join('\n\n')}\n\nPlease run the \`reboot\` command to apply core changes.`);
        }
    } else {
        // only plugin updates applied - keep silent to avoid spam, but log
        info(`[${name}] Auto-update applied plugin updates: ${updatedPluginFiles.length} item(s).`);
    }

    await saveLocalSnapshot(remoteBuild);
    info(`[${name}] Auto-update applied successfully.`);
}

// --- Lifecycle & Message Handler ---
export async function initialize(bot) {
    botRef = bot;
    await ensureSchema();
    await createInitialSnapshotIfNeeded();

    startManagedListener({
        botRef, eventName: 'connection.update', moduleName: name,
        handler: (update) => {
            if (update.connection === 'open') startAutoUpdateScheduler();
            else if (update.connection === 'close') stopAutoUpdateScheduler();
        }
    });

    if (botRef.ws?.readyState === 1 || botRef.sock?.ws?.readyState === 1) {
        startAutoUpdateScheduler();
    }

    info(`[${name}] initialized.`);
}

export async function onMessage(ctx) {
    try {
        if (!ctx || !ctx.key) return;
        const chatId = ctx.key?.remoteJid;
        if (!chatId || chatId.endsWith('@g.us')) return;

        const rawText = (ctx.text || '').trim().toLowerCase();
        const tokens = rawText.split(/\s+/);
        const cmd = tokens[0];

        if (!commands.includes(cmd)) return;

        const fromMe = !!ctx.key.fromMe;
        const isSudoUser = await isSudo(botRef, ctx);
        if (!fromMe && !isSudoUser) return;

        let finalDest = fromMe ? getBotJid() : (await findStoredMatchFromFindings(userJidFromCtx(ctx).findings));
        if (!finalDest) return;

        if (cmd === 'update') {
            const subCmd = tokens[1];
            if (subCmd === 'now') await handleManualUpdateNow(finalDest);
            else await handleManualUpdateCheck(finalDest);
        } else if (cmd === 'autoupdate') {
            const subCmd = tokens[1];
            if (subCmd === 'on') {
                await setAutoUpdateStatus(true);
                await safeSend(finalDest, '🔄 Automatic updates have been ENABLED. The bot will check for updates every 24 hours.');
            } else if (subCmd === 'off') {
                await setAutoUpdateStatus(false);
                await safeSend(finalDest, '🔄 Automatic updates have been DISABLED.');
            } else {
                const settings = await getAutoUpdateSettings();
                const status = settings.enabled ? 'ENABLED' : 'DISABLED';
                const nextCheck = settings.nextCheckAt ? DateTime.fromSeconds(settings.nextCheckAt).toRelative() : 'Not scheduled';
                await safeSend(finalDest, `*Auto-Update Status*\n\nStatus: *${status}*\nNext Check: ${nextCheck}\n\nUsage: autoupdate on|off`);
            }
        }
    } catch (e) {
        error(e, `[${name}] onMessage error`);
    }
}

export async function cleanup() {
    stopAutoUpdateScheduler();
    stopManagedListener(name, 'connection.update');
    botRef = null;
    info(`[${name}] cleaned up.`);
}
