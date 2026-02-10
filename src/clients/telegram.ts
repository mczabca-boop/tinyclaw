#!/usr/bin/env node
/**
 * Telegram Client for TinyClaw
 * Writes incoming Telegram messages to queue and reads responses.
 * Does NOT call Claude directly - that's handled by queue-processor.
 */

import TelegramBot, { Message as TelegramMessage } from 'node-telegram-bot-api';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const SCRIPT_DIR = path.resolve(__dirname, '../..');
const QUEUE_INCOMING = path.join(SCRIPT_DIR, '.tinyclaw/queue/incoming');
const QUEUE_OUTGOING = path.join(SCRIPT_DIR, '.tinyclaw/queue/outgoing');
const LOG_FILE = path.join(SCRIPT_DIR, '.tinyclaw/logs/telegram.log');
const RESET_FLAG = path.join(SCRIPT_DIR, '.tinyclaw/reset_flag');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_ALLOWED_ID = process.env.TELEGRAM_ALLOWED_ID;

if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === 'your_token_here') {
    console.error('ERROR: TELEGRAM_TOKEN is not set in .env file');
    process.exit(1);
}

if (!TELEGRAM_ALLOWED_ID) {
    console.error('ERROR: TELEGRAM_ALLOWED_ID is not set in .env file');
    process.exit(1);
}

// Ensure directories exist
[QUEUE_INCOMING, QUEUE_OUTGOING, path.dirname(LOG_FILE)].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

interface PendingMessage {
    chatId: number | string;
    timestamp: number;
}

interface QueueData {
    channel: string;
    sender: string;
    senderId: string;
    message: string;
    timestamp: number;
    messageId: string;
}

interface ResponseData {
    channel: string;
    sender: string;
    message: string;
    originalMessage: string;
    timestamp: number;
    messageId: string;
}

const pendingMessages = new Map<string, PendingMessage>();

function log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    console.log(logMessage.trim());
    fs.appendFileSync(LOG_FILE, logMessage);
}

function splitMessage(text: string, maxLength = 4000): string[] {
    if (text.length <= maxLength) {
        return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }

        let splitIndex = remaining.lastIndexOf('\n', maxLength);
        if (splitIndex <= 0) {
            splitIndex = remaining.lastIndexOf(' ', maxLength);
        }
        if (splitIndex <= 0) {
            splitIndex = maxLength;
        }

        chunks.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).replace(/^\n/, '');
    }

    return chunks;
}

function getSenderName(msg: TelegramMessage): string {
    if (msg.from?.username) {
        return msg.from.username;
    }

    const displayName = [msg.from?.first_name, msg.from?.last_name]
        .filter(Boolean)
        .join(' ')
        .trim();

    return displayName || String(msg.chat.id);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

log('INFO', 'Starting Telegram client...');
log('INFO', `Allowlisted Telegram chat ID: ${TELEGRAM_ALLOWED_ID}`);

bot.on('message', async (msg: TelegramMessage) => {
    try {
        const chatId = msg.chat.id;
        const rawText = msg.text;

        if (!rawText || rawText.trim().length === 0) {
            return;
        }

        const text = rawText.trim();
        if (String(chatId) !== TELEGRAM_ALLOWED_ID) {
            log('WARN', `Blocked unauthorized chat ID: ${chatId}`);
            await bot.sendMessage(chatId, 'Access denied: unauthorized user.');
            return;
        }

        const sender = getSenderName(msg);
        log('INFO', `Message from ${sender}: ${text.substring(0, 50)}...`);

        if (text.match(/^[!/]reset$/i)) {
            fs.writeFileSync(RESET_FLAG, 'reset');
            await bot.sendMessage(chatId, 'Conversation reset! Next message will start fresh.');
            log('INFO', 'Reset command received');
            return;
        }

        const messageId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
        const queueData: QueueData = {
            channel: 'telegram',
            sender: sender,
            senderId: String(chatId),
            message: text,
            timestamp: Date.now(),
            messageId: messageId,
        };

        const queueFile = path.join(QUEUE_INCOMING, `telegram_${messageId}.json`);
        fs.writeFileSync(queueFile, JSON.stringify(queueData, null, 2));
        log('INFO', `Queued message ${messageId}`);

        pendingMessages.set(messageId, {
            chatId: chatId,
            timestamp: Date.now(),
        });

        const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
        for (const [id, data] of pendingMessages.entries()) {
            if (data.timestamp < fiveMinutesAgo) {
                pendingMessages.delete(id);
            }
        }
    } catch (error) {
        log('ERROR', `Message handling error: ${(error as Error).message}`);
    }
});

let isCheckingOutgoing = false;

async function checkOutgoingQueue(): Promise<void> {
    if (isCheckingOutgoing) {
        return;
    }

    isCheckingOutgoing = true;

    try {
        const files = fs.readdirSync(QUEUE_OUTGOING)
            .filter(f => f.startsWith('telegram_') && f.endsWith('.json'));

        for (const file of files) {
            const filePath = path.join(QUEUE_OUTGOING, file);

            try {
                const responseData: ResponseData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                const { messageId, message: responseText, sender } = responseData;
                const pending = pendingMessages.get(messageId);

                if (!pending) {
                    log('WARN', `No pending message for ${messageId}, cleaning up`);
                    fs.unlinkSync(filePath);
                    continue;
                }

                const chunks = splitMessage(responseText);
                for (const chunk of chunks) {
                    await bot.sendMessage(pending.chatId, chunk);
                }

                log('INFO', `Sent response to ${sender} (${responseText.length} chars, ${chunks.length} message(s))`);
                pendingMessages.delete(messageId);
                fs.unlinkSync(filePath);
            } catch (error) {
                log('ERROR', `Error processing response file ${file}: ${(error as Error).message}`);
            }
        }
    } catch (error) {
        log('ERROR', `Outgoing queue error: ${(error as Error).message}`);
    } finally {
        isCheckingOutgoing = false;
    }
}

setInterval(() => {
    void checkOutgoingQueue();
}, 1000);

bot.on('polling_error', (error: Error) => {
    log('ERROR', `Telegram polling error: ${error.message}`);
});

async function shutdown(signal: string): Promise<void> {
    log('INFO', `Shutting down Telegram client (${signal})...`);
    try {
        await bot.stopPolling();
    } catch (error) {
        log('WARN', `Failed to stop polling cleanly: ${(error as Error).message}`);
    }
    process.exit(0);
}

process.on('SIGINT', () => {
    void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
});
