import fs from 'fs';
import path from 'path';
import { jsonrepair } from 'jsonrepair';
import { LOG_FILE } from './config';
import { log } from './logging';
import { runCommand } from './invoke';
import { MessageData } from './types';
import {
    SessionTurn,
    parseSessionTurns,
    buildPrefetchBlock,
    parseOpenVikingSearchHits,
    summarizeOpenVikingSearchHitDistribution,
    selectOpenVikingPrefetchHits,
    buildOpenVikingSearchPrefetchBlock,
    OpenVikingSearchHitDistribution,
} from './openviking-prefetch';
import {
    buildOpenVikingSessionMapKey,
    getOpenVikingSessionId,
    upsertOpenVikingSessionId,
    deleteOpenVikingSessionId,
    OpenVikingSessionMapKey,
} from './openviking-session-map';

export const OPENVIKING_AUTOSYNC_FALLBACK_ENABLED = process.env.TINYCLAW_OPENVIKING_AUTOSYNC !== '0';
export const OPENVIKING_SESSION_NATIVE_ENABLED = process.env.TINYCLAW_OPENVIKING_SESSION_NATIVE === '1';
const OPENVIKING_PREFETCH_ENABLED = process.env.TINYCLAW_OPENVIKING_PREFETCH !== '0';
const OPENVIKING_SEARCH_NATIVE_ENABLED = process.env.TINYCLAW_OPENVIKING_SEARCH_NATIVE === '1';
const OPENVIKING_PREFETCH_TIMEOUT_MS = Number(process.env.TINYCLAW_OPENVIKING_PREFETCH_TIMEOUT_MS || 5000);
const OPENVIKING_COMMIT_TIMEOUT_MS = Number(process.env.TINYCLAW_OPENVIKING_COMMIT_TIMEOUT_MS || 15000);
const OPENVIKING_PREFETCH_MAX_CHARS = Number(process.env.TINYCLAW_OPENVIKING_PREFETCH_MAX_CHARS || 2800);
const OPENVIKING_PREFETCH_MAX_TURNS = Number(process.env.TINYCLAW_OPENVIKING_PREFETCH_MAX_TURNS || 4);
const OPENVIKING_PREFETCH_MAX_HITS = Number(process.env.TINYCLAW_OPENVIKING_PREFETCH_MAX_HITS || 8);
const OPENVIKING_SEARCH_SCORE_THRESHOLD = process.env.TINYCLAW_OPENVIKING_SEARCH_SCORE_THRESHOLD;
const OPENVIKING_SESSION_ROOT = '/tinyclaw/sessions';
const OPENVIKING_NATIVE_PREFETCH_DUMP_FILE = path.join(path.dirname(LOG_FILE), 'prefetch_dump_native_latest.txt');
const openVikingSyncChains = new Map<string, Promise<void>>();

type OpenVikingPrefetchSource = 'search_native' | 'legacy_markdown' | 'none';

type OpenVikingPrefetchResult = {
    block: string;
    source: OpenVikingPrefetchSource;
    diagnostics: string[];
    fallbackReason?: string;
    distribution?: OpenVikingSearchHitDistribution;
};

type OpenVikingLegacyPrefetchResult = {
    block: string;
    diagnostics: string[];
};

export type OpenVikingTurnState = {
    message: string;
    openVikingSessionId: string | null;
    nativeSessionWriteFailed: boolean;
};

/** Parse JSON with automatic repair for malformed content (e.g. bad escapes). */
function safeParseJSON<T = unknown>(raw: string, label?: string): T {
    try {
        return JSON.parse(raw);
    } catch {
        log('WARN', `Invalid JSON${label ? ` in ${label}` : ''}, attempting auto-repair`);
        return JSON.parse(jsonrepair(raw));
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    return {};
}

function asList(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    return [];
}

function maybeDistributionSummary(distribution?: OpenVikingSearchHitDistribution): string {
    if (!distribution) return 'memory=0,resource=0,skill=0';
    return `memory=${distribution.memory},resource=${distribution.resource},skill=${distribution.skill}`;
}

function parseOpenVikingGrepMemoryHits(payload: unknown): Array<{
    type: 'memory';
    uri: string;
    abstract: string;
    score: number;
}> {
    const root = asRecord(payload);
    const resultNode = asRecord(root.result ?? root.data ?? root);
    const matches = asList(resultNode.matches);
    const dedup = new Map<string, { type: 'memory'; uri: string; abstract: string; score: number }>();

    for (const match of matches) {
        const node = asRecord(match);
        const uri = String(node.uri ?? node.path ?? '').trim();
        if (!uri) continue;
        const content = String(node.content ?? node.text ?? node.snippet ?? '').replace(/\s+/g, ' ').trim();
        const abstract = content || '(no abstract provided)';
        if (!dedup.has(uri)) {
            dedup.set(uri, { type: 'memory', uri, abstract, score: 0 });
        }
    }

    return Array.from(dedup.values());
}

function writeNativePrefetchDump(
    agentId: string,
    query: string,
    sessionId: string | undefined,
    prefetch: OpenVikingPrefetchResult
): void {
    if (prefetch.source !== 'search_native' || !prefetch.block) return;
    const lines: string[] = [
        '# OpenViking Native Prefetch Dump (latest)',
        '',
        `- captured_at: ${new Date().toISOString()}`,
        `- agent_id: ${agentId}`,
        `- session_id: ${sessionId || 'none'}`,
        `- source: ${prefetch.source}`,
        `- distribution: ${maybeDistributionSummary(prefetch.distribution)}`,
        `- diagnostics: ${prefetch.diagnostics.join(' | ') || 'none'}`,
        '',
        '## Query',
        '',
        query,
        '',
        '## Injected Block',
        '',
        prefetch.block,
        '',
    ];
    fs.writeFileSync(OPENVIKING_NATIVE_PREFETCH_DUMP_FILE, lines.join('\n'), 'utf8');
}

function stripInjectedOpenVikingContext(text: string): string {
    const withEndMarker = /\n*------\n*\n*\[OpenViking Retrieved Context\][\s\S]*?\[End OpenViking Context\]\s*/g;
    const withoutEndMarker = /\n*------\n*\n*\[OpenViking Retrieved Context\][\s\S]*$/g;
    return text
        .replace(withEndMarker, '\n')
        .replace(withoutEndMarker, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function getOpenVikingToolPath(workspacePath: string, agentId: string): string | null {
    const toolPath = path.join(workspacePath, agentId, '.tinyclaw', 'tools', 'openviking', 'openviking-tool.js');
    if (!fs.existsSync(toolPath)) return null;
    return toolPath;
}

function getOpenVikingRuntimeDir(workspacePath: string, agentId: string): string {
    return path.join(workspacePath, agentId, '.tinyclaw', 'runtime', 'openviking');
}

function getActiveSessionFile(workspacePath: string, agentId: string): string {
    return path.join(getOpenVikingRuntimeDir(workspacePath, agentId), 'active-session.md');
}

function ensureActiveSessionFile(workspacePath: string, agentId: string): string {
    const runtimeDir = getOpenVikingRuntimeDir(workspacePath, agentId);
    const sessionFile = getActiveSessionFile(workspacePath, agentId);
    if (!fs.existsSync(runtimeDir)) {
        fs.mkdirSync(runtimeDir, { recursive: true });
    }
    if (!fs.existsSync(sessionFile)) {
        const header = [
            `# TinyClaw Session (@${agentId})`,
            '',
            `- started_at: ${new Date().toISOString()}`,
            ''
        ].join('\n');
        fs.writeFileSync(sessionFile, header);
    }
    return sessionFile;
}

function enqueueOpenVikingSync(agentId: string, task: () => Promise<void>): void {
    const current = openVikingSyncChains.get(agentId) || Promise.resolve();
    const next = current
        .then(task)
        .catch((error) => {
            log('WARN', `OpenViking sync failed for @${agentId}: ${(error as Error).message}`);
        });
    openVikingSyncChains.set(agentId, next);
    next.finally(() => {
        if (openVikingSyncChains.get(agentId) === next) {
            openVikingSyncChains.delete(agentId);
        }
    });
}

async function writeSessionFileToOpenViking(
    workspacePath: string,
    agentId: string,
    localFile: string,
    targetPath: string
): Promise<void> {
    if (!OPENVIKING_AUTOSYNC_FALLBACK_ENABLED) return;
    const toolPath = getOpenVikingToolPath(workspacePath, agentId);
    if (!toolPath) return;
    await runCommand('node', [toolPath, 'write-file', targetPath, localFile], path.join(workspacePath, agentId));
}

async function finalizeOpenVikingSession(workspacePath: string, agentId: string): Promise<void> {
    const sessionFile = getActiveSessionFile(workspacePath, agentId);
    if (!fs.existsSync(sessionFile)) return;

    const currentContent = fs.readFileSync(sessionFile, 'utf8').trim();
    if (!currentContent) return;

    const endedAt = new Date().toISOString();
    const sessionCloseNote = `\n\n- ended_at: ${endedAt}\n`;
    fs.appendFileSync(sessionFile, sessionCloseNote);

    const safeTimestamp = endedAt.replace(/[:.]/g, '-');
    await writeSessionFileToOpenViking(
        workspacePath,
        agentId,
        sessionFile,
        `${OPENVIKING_SESSION_ROOT}/${agentId}/closed/${safeTimestamp}.md`
    );

    fs.rmSync(sessionFile, { force: true });
}

async function appendTurnAndSyncOpenViking(
    workspacePath: string,
    agentId: string,
    messageId: string,
    userMessage: string,
    assistantResponse: string,
    isInternal: boolean
): Promise<void> {
    const sessionFile = ensureActiveSessionFile(workspacePath, agentId);
    const turnTime = new Date().toISOString();
    const injectedMarker = '[OpenViking Retrieved Context]';
    if (userMessage.includes(injectedMarker) || assistantResponse.includes(injectedMarker)) {
        log(
            'WARN',
            `OpenViking writeback guard hit for @${agentId} message_id=${messageId}: injected context marker detected before sync`
        );
    }
    const cleanUserMessage = stripInjectedOpenVikingContext(userMessage);
    const cleanAssistantResponse = stripInjectedOpenVikingContext(assistantResponse);
    const turnBlock = [
        '------',
        '',
        `## Turn ${turnTime}`,
        '',
        `- message_id: ${messageId}`,
        `- source: ${isInternal ? 'internal' : 'external'}`,
        '',
        '### User',
        '',
        cleanUserMessage,
        '',
        '### Assistant',
        '',
        cleanAssistantResponse,
        ''
    ].join('\n');
    fs.appendFileSync(sessionFile, turnBlock);

    await writeSessionFileToOpenViking(
        workspacePath,
        agentId,
        sessionFile,
        `${OPENVIKING_SESSION_ROOT}/${agentId}/active.md`
    );
}

export function resolveOpenVikingSessionMapKey(messageData: MessageData, agentId: string): OpenVikingSessionMapKey {
    const senderId = messageData.senderId || messageData.sender || 'unknown-sender';
    return buildOpenVikingSessionMapKey(messageData.channel, senderId, agentId);
}

async function runOpenVikingToolJson(
    workspacePath: string,
    agentId: string,
    args: string[],
    timeoutMs: number = OPENVIKING_PREFETCH_TIMEOUT_MS
): Promise<unknown> {
    const toolPath = getOpenVikingToolPath(workspacePath, agentId);
    if (!toolPath) {
        throw new Error(`OpenViking tool missing for @${agentId}`);
    }
    const commandArgs = args.includes('--json') ? args : [...args, '--json'];
    const output = await runCommand(
        'node',
        [toolPath, ...commandArgs],
        path.join(workspacePath, agentId),
        timeoutMs
    );
    const trimmed = output.trim();
    if (!trimmed) return {};
    return safeParseJSON(trimmed, `openviking-tool:${args[0] || 'unknown'}`);
}

function extractOpenVikingSessionId(payload: unknown): string {
    const root = (payload && typeof payload === 'object' && !Array.isArray(payload))
        ? payload as Record<string, unknown>
        : {};
    const resultNode = (root.result && typeof root.result === 'object' && !Array.isArray(root.result))
        ? root.result as Record<string, unknown>
        : {};
    const dataNode = (root.data && typeof root.data === 'object' && !Array.isArray(root.data))
        ? root.data as Record<string, unknown>
        : {};

    const candidates = [
        root.id, root.session_id, root.sessionId,
        resultNode.id, resultNode.session_id, resultNode.sessionId,
        dataNode.id, dataNode.session_id, dataNode.sessionId,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }
    return '';
}

async function ensureOpenVikingNativeSession(
    workspacePath: string,
    agentId: string,
    sessionKey: OpenVikingSessionMapKey
): Promise<{ sessionId: string; isNew: boolean }> {
    const existingSessionId = getOpenVikingSessionId(sessionKey);
    if (existingSessionId) {
        return { sessionId: existingSessionId, isNew: false };
    }

    const created = await runOpenVikingToolJson(
        workspacePath,
        agentId,
        [
            'session-create',
            '--agent-id', sessionKey.agentId,
            '--channel', sessionKey.channel,
            '--sender-id', sessionKey.senderId,
        ],
        OPENVIKING_PREFETCH_TIMEOUT_MS
    );
    const createdSessionId = extractOpenVikingSessionId(created);
    if (!createdSessionId) {
        throw new Error('OpenViking session create returned no session id');
    }
    upsertOpenVikingSessionId(sessionKey, createdSessionId);
    return { sessionId: createdSessionId, isNew: true };
}

async function appendNativeOpenVikingSessionMessage(
    workspacePath: string,
    agentId: string,
    sessionId: string,
    role: 'user' | 'assistant',
    content: string
): Promise<void> {
    const sanitizedContent = stripInjectedOpenVikingContext(content);
    const startedAt = Date.now();
    await runOpenVikingToolJson(
        workspacePath,
        agentId,
        ['session-message', sessionId, role, sanitizedContent],
        OPENVIKING_PREFETCH_TIMEOUT_MS
    );
    const elapsedMs = Date.now() - startedAt;
    log('INFO', `OpenViking session write success for @${agentId}: session_id=${sessionId} role=${role} elapsed_ms=${elapsedMs}`);
}

async function commitNativeOpenVikingSession(
    workspacePath: string,
    agentId: string,
    sessionId: string
): Promise<void> {
    const startedAt = Date.now();
    await runOpenVikingToolJson(
        workspacePath,
        agentId,
        ['session-commit', sessionId],
        OPENVIKING_COMMIT_TIMEOUT_MS
    );
    const elapsedMs = Date.now() - startedAt;
    log('INFO', `OpenViking session commit success for @${agentId}: session_id=${sessionId} elapsed_ms=${elapsedMs}`);
}

async function fetchLegacyOpenVikingPrefetchContext(
    workspacePath: string,
    agentId: string,
    query: string
): Promise<OpenVikingLegacyPrefetchResult> {
    const toolPath = getOpenVikingToolPath(workspacePath, agentId);
    if (!toolPath) return { block: '', diagnostics: ['tool_missing'] };

    const readTargets = [
        `${OPENVIKING_SESSION_ROOT}/${agentId}/active.md`,
        `${OPENVIKING_SESSION_ROOT}/${agentId}/closed`,
    ];

    const allTurns: SessionTurn[] = [];
    const diagnostics: string[] = [];
    const workdir = path.join(workspacePath, agentId);
    const searchLimit = Math.max(OPENVIKING_PREFETCH_MAX_TURNS * 6, 12);
    const candidateUris: Array<{ uri: string; score: number }> = [];

    for (const target of readTargets) {
        try {
            const found = await runCommand(
                'node',
                [toolPath, 'find-uris', query, target, '--limit', String(searchLimit)],
                workdir,
                OPENVIKING_PREFETCH_TIMEOUT_MS
            );
            const lines = found
                .trim()
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line && !line.startsWith('[openviking-tool]'));
            let matched = 0;
            for (const line of lines) {
                const tabIdx = line.indexOf('\t');
                if (tabIdx <= 0) continue;
                const score = Number(line.slice(0, tabIdx));
                const uri = line.slice(tabIdx + 1).trim();
                if (!uri) continue;
                matched += 1;
                candidateUris.push({ uri, score: Number.isFinite(score) ? score : 0 });
            }
            diagnostics.push(`${target}:find=${matched}`);
        } catch {
            diagnostics.push(`${target}:find_error`);
        }
    }

    const rankedUris: string[] = [];
    const seenUris = new Set<string>();
    for (const candidate of candidateUris) {
        if (seenUris.has(candidate.uri)) continue;
        seenUris.add(candidate.uri);
        rankedUris.push(candidate.uri);
        if (rankedUris.length >= searchLimit) break;
    }
    diagnostics.push(`find_total=${rankedUris.length}`);

    for (const uri of rankedUris) {
        try {
            const output = await runCommand(
                'node',
                [toolPath, 'read', uri],
                workdir,
                OPENVIKING_PREFETCH_TIMEOUT_MS
            );
            const content = output.trim();
            if (!content || content.startsWith('[openviking-tool]')) continue;
            const parsed = parseSessionTurns(content);
            if (parsed.length > 0) {
                allTurns.push(...parsed);
            }
        } catch {
            // Best-effort
        }
    }

    if (!allTurns.length) {
        for (const target of readTargets) {
            try {
                const output = await runCommand(
                    'node',
                    [toolPath, 'read', target],
                    workdir,
                    OPENVIKING_PREFETCH_TIMEOUT_MS
                );
                const content = output.trim();
                if (!content || content.startsWith('[openviking-tool]')) {
                    diagnostics.push(`${target}:fallback_empty`);
                    continue;
                }
                const parsed = parseSessionTurns(content);
                diagnostics.push(`${target}:fallback_chars=${content.length},turns=${parsed.length}`);
                allTurns.push(...parsed);
            } catch {
                diagnostics.push(`${target}:fallback_error`);
            }
        }
    }

    const dedup = new Map<string, SessionTurn>();
    for (const turn of allTurns) {
        const key = turn.messageId
            ? `${turn.messageId}|${turn.timestamp}`
            : `${turn.timestamp}|${turn.user}|${turn.assistant}`;
        dedup.set(key, turn);
    }
    const turns = Array.from(dedup.values());
    if (!turns.length) {
        return { block: '', diagnostics };
    }

    const selected = turns.slice(0, OPENVIKING_PREFETCH_MAX_TURNS);
    return {
        block: buildPrefetchBlock(selected, OPENVIKING_PREFETCH_MAX_CHARS),
        diagnostics,
    };
}

async function fetchOpenVikingPrefetchContext(
    workspacePath: string,
    agentId: string,
    query: string,
    sessionId?: string
): Promise<OpenVikingPrefetchResult> {
    if (!OPENVIKING_PREFETCH_ENABLED) {
        return { block: '', source: 'none', diagnostics: ['prefetch_disabled'] };
    }

    const toolPath = getOpenVikingToolPath(workspacePath, agentId);
    if (!toolPath) {
        return { block: '', source: 'none', diagnostics: ['tool_missing'] };
    }

    const diagnostics: string[] = [];
    if (OPENVIKING_SEARCH_NATIVE_ENABLED) {
        const searchLimit = Math.max(OPENVIKING_PREFETCH_MAX_HITS * 2, 12);
        const prefetchBudgetMs = Math.max(OPENVIKING_PREFETCH_TIMEOUT_MS, 1000);
        const prefetchStartedAt = Date.now();
        const getRemainingBudgetMs = (): number => prefetchBudgetMs - (Date.now() - prefetchStartedAt);

        const buildNativeHitResult = (
            stage: string,
            hits: Array<{ type: 'memory' | 'resource' | 'skill'; uri: string; abstract: string; score: number }>
        ): OpenVikingPrefetchResult => {
            const selected = selectOpenVikingPrefetchHits(hits, OPENVIKING_PREFETCH_MAX_HITS);
            const distribution = summarizeOpenVikingSearchHitDistribution(selected);
            return {
                block: buildOpenVikingSearchPrefetchBlock(hits, OPENVIKING_PREFETCH_MAX_CHARS, OPENVIKING_PREFETCH_MAX_HITS),
                source: 'search_native',
                diagnostics: [
                    `native_stage=${stage}`,
                    `native_hits=${hits.length}`,
                    sessionId ? 'session_id_present=1' : 'session_id_present=0',
                    `native_budget_ms=${prefetchBudgetMs}`,
                ],
                distribution,
            };
        };

        const runNativeStage = async (
            stage: string,
            args: string[],
            parser: (payload: unknown) => Array<{ type: 'memory' | 'resource' | 'skill'; uri: string; abstract: string; score: number }>,
            stageTimeoutCapMs?: number
        ): Promise<OpenVikingPrefetchResult | null> => {
            const remaining = getRemainingBudgetMs();
            if (remaining <= 250) {
                diagnostics.push(`${stage}:skipped_budget_exhausted`);
                return null;
            }
            const timeoutMs = Math.max(
                250,
                Math.min(
                    remaining,
                    OPENVIKING_PREFETCH_TIMEOUT_MS,
                    stageTimeoutCapMs ?? OPENVIKING_PREFETCH_TIMEOUT_MS
                )
            );
            const startedAt = Date.now();
            try {
                const response = await runOpenVikingToolJson(workspacePath, agentId, args, timeoutMs);
                const hits = parser(response);
                const elapsedMs = Date.now() - startedAt;
                if (!hits.length) {
                    diagnostics.push(`${stage}:empty elapsed_ms=${elapsedMs}`);
                    return null;
                }
                diagnostics.push(`${stage}:hits=${hits.length} elapsed_ms=${elapsedMs}`);
                return buildNativeHitResult(stage, hits);
            } catch (error) {
                const elapsedMs = Date.now() - startedAt;
                diagnostics.push(`${stage}:error=${(error as Error).message} elapsed_ms=${elapsedMs}`);
                return null;
            }
        };

        const searchWithSessionArgs = ['search', query, '--limit', String(searchLimit)];
        if (OPENVIKING_SEARCH_SCORE_THRESHOLD !== undefined) {
            searchWithSessionArgs.push('--score-threshold', OPENVIKING_SEARCH_SCORE_THRESHOLD);
        }
        if (sessionId) {
            searchWithSessionArgs.push('--session-id', sessionId);
            const staged = await runNativeStage('search_session', searchWithSessionArgs, parseOpenVikingSearchHits, 2200);
            if (staged) return staged;
        } else {
            diagnostics.push('search_session:skipped_no_session');
        }

        const searchWithoutSessionArgs = ['search', query, '--limit', String(searchLimit)];
        if (OPENVIKING_SEARCH_SCORE_THRESHOLD !== undefined) {
            searchWithoutSessionArgs.push('--score-threshold', OPENVIKING_SEARCH_SCORE_THRESHOLD);
        }
        const stagedSearch = await runNativeStage('search_plain', searchWithoutSessionArgs, parseOpenVikingSearchHits, 1700);
        if (stagedSearch) return stagedSearch;

        const findMemoryArgs = ['find-uris', query, 'viking://user/memories', '--limit', String(searchLimit)];
        if (OPENVIKING_SEARCH_SCORE_THRESHOLD !== undefined) {
            findMemoryArgs.push('--score-threshold', OPENVIKING_SEARCH_SCORE_THRESHOLD);
        }
        const stagedMemory = await runNativeStage('find_memory', findMemoryArgs, parseOpenVikingSearchHits, 1200);
        if (stagedMemory) return stagedMemory;

        const findResourceArgs = ['find-uris', query, `${OPENVIKING_SESSION_ROOT}/${agentId}`, '--limit', String(searchLimit)];
        if (OPENVIKING_SEARCH_SCORE_THRESHOLD !== undefined) {
            findResourceArgs.push('--score-threshold', OPENVIKING_SEARCH_SCORE_THRESHOLD);
        }
        const stagedResource = await runNativeStage('find_resource', findResourceArgs, parseOpenVikingSearchHits, 900);
        if (stagedResource) return stagedResource;

        const grepMemoryArgs = ['grep', query, '--uri', 'viking://user/memories', '--case-insensitive'];
        const stagedGrep = await runNativeStage('grep_memory', grepMemoryArgs, parseOpenVikingGrepMemoryHits, 700);
        if (stagedGrep) return stagedGrep;

        diagnostics.push('native_chain_exhausted');
    } else {
        diagnostics.push('native_search_disabled');
    }

    const legacy = await fetchLegacyOpenVikingPrefetchContext(workspacePath, agentId, query);
    const fallbackReason = OPENVIKING_SEARCH_NATIVE_ENABLED
        ? 'native_search_no_hits_or_error'
        : 'native_search_flag_disabled';
    return {
        block: legacy.block,
        source: legacy.block ? 'legacy_markdown' : 'none',
        diagnostics: [...diagnostics, ...legacy.diagnostics],
        fallbackReason,
    };
}

export async function prepareOpenVikingBeforeInvoke(params: {
    workspacePath: string;
    agentId: string;
    messageData: MessageData;
    message: string;
    isInternal: boolean;
    shouldReset: boolean;
}): Promise<OpenVikingTurnState> {
    const { workspacePath, agentId, messageData, isInternal, shouldReset } = params;
    let { message } = params;
    const sessionMapKey = !isInternal ? resolveOpenVikingSessionMapKey(messageData, agentId) : null;
    let openVikingSessionId: string | null = null;
    let nativeSessionWriteFailed = false;
    const userMessageForSession = message;

    if (shouldReset) {
        if (!isInternal && OPENVIKING_SESSION_NATIVE_ENABLED && sessionMapKey) {
            const existingSessionId = getOpenVikingSessionId(sessionMapKey);
            if (existingSessionId) {
                try {
                    await commitNativeOpenVikingSession(workspacePath, agentId, existingSessionId);
                } catch (error) {
                    log('WARN', `OpenViking session commit failed for @${agentId}: session_id=${existingSessionId} error=${(error as Error).message}`);
                } finally {
                    deleteOpenVikingSessionId(sessionMapKey);
                    log('INFO', `OpenViking session map cleared for @${agentId}: session_id=${existingSessionId}`);
                }
            } else {
                log('INFO', `OpenViking reset consumed for @${agentId}: no native session mapping found`);
            }
        }

        if (OPENVIKING_AUTOSYNC_FALLBACK_ENABLED) {
            enqueueOpenVikingSync(agentId, async () => {
                await finalizeOpenVikingSession(workspacePath, agentId);
                log('INFO', `OpenViking legacy markdown session finalized for @${agentId}`);
            });
        }
    }

    if (!isInternal && OPENVIKING_SESSION_NATIVE_ENABLED && sessionMapKey) {
        try {
            const ensured = await ensureOpenVikingNativeSession(workspacePath, agentId, sessionMapKey);
            openVikingSessionId = ensured.sessionId;
            log('INFO', `OpenViking session resolved for @${agentId}: session_id=${openVikingSessionId} status=${ensured.isNew ? 'created' : 'reused'}`);
        } catch (error) {
            nativeSessionWriteFailed = true;
            log('WARN', `OpenViking session setup failed for @${agentId}: ${(error as Error).message}`);
        }
    }

    if (!isInternal) {
        try {
            const prefetch = await fetchOpenVikingPrefetchContext(
                workspacePath,
                agentId,
                message,
                openVikingSessionId || undefined
            );
            if (prefetch.block) {
                writeNativePrefetchDump(agentId, message, openVikingSessionId || undefined, prefetch);
                message += `\n\n------\n\n${prefetch.block}\n[End OpenViking Context]`;
                const distributionSummary = maybeDistributionSummary(prefetch.distribution);
                log('INFO', `OpenViking prefetch hit for @${agentId}: source=${prefetch.source} distribution=${distributionSummary} injected_chars=${prefetch.block.length}`);
                if (prefetch.fallbackReason) {
                    log('INFO', `OpenViking prefetch fallback for @${agentId}: reason=${prefetch.fallbackReason} diagnostics=${prefetch.diagnostics.join(' | ')}`);
                }
            } else {
                log('INFO', `OpenViking prefetch miss for @${agentId}: source=${prefetch.source} diagnostics=${prefetch.diagnostics.join(' | ')}`);
            }
        } catch (error) {
            log('WARN', `OpenViking prefetch skipped for @${agentId}: ${(error as Error).message}`);
        }
    }

    if (!isInternal && OPENVIKING_SESSION_NATIVE_ENABLED) {
        if (openVikingSessionId) {
            try {
                await appendNativeOpenVikingSessionMessage(
                    workspacePath,
                    agentId,
                    openVikingSessionId,
                    'user',
                    userMessageForSession
                );
            } catch (error) {
                nativeSessionWriteFailed = true;
                log('WARN', `OpenViking session write failed for @${agentId}: session_id=${openVikingSessionId} role=user error=${(error as Error).message}`);
            }
        } else {
            nativeSessionWriteFailed = true;
            log('WARN', `OpenViking session write skipped for @${agentId}: session_id_unavailable`);
        }
    }

    return { message, openVikingSessionId, nativeSessionWriteFailed };
}

export async function finalizeOpenVikingAfterInvoke(params: {
    workspacePath: string;
    agentId: string;
    messageId: string;
    message: string;
    response: string;
    isInternal: boolean;
    openVikingSessionId: string | null;
    nativeSessionWriteFailed: boolean;
}): Promise<void> {
    const {
        workspacePath,
        agentId,
        messageId,
        message,
        response,
        isInternal,
        openVikingSessionId,
    } = params;
    let { nativeSessionWriteFailed } = params;

    if (!isInternal && OPENVIKING_SESSION_NATIVE_ENABLED && openVikingSessionId) {
        try {
            await appendNativeOpenVikingSessionMessage(
                workspacePath,
                agentId,
                openVikingSessionId,
                'assistant',
                response
            );
        } catch (error) {
            nativeSessionWriteFailed = true;
            log('WARN', `OpenViking session write failed for @${agentId}: session_id=${openVikingSessionId} role=assistant error=${(error as Error).message}`);
        }
    }

    const shouldUseLegacyWriteback = OPENVIKING_AUTOSYNC_FALLBACK_ENABLED && (
        isInternal
        || !OPENVIKING_SESSION_NATIVE_ENABLED
        || nativeSessionWriteFailed
        || !openVikingSessionId
    );

    if (shouldUseLegacyWriteback) {
        const fallbackReasons: string[] = [];
        if (isInternal) fallbackReasons.push('internal_message');
        if (!OPENVIKING_SESSION_NATIVE_ENABLED) fallbackReasons.push('session_native_disabled');
        if (OPENVIKING_SESSION_NATIVE_ENABLED && !openVikingSessionId) fallbackReasons.push('session_id_unavailable');
        if (nativeSessionWriteFailed) fallbackReasons.push('native_session_write_failed');
        log('INFO', `OpenViking legacy writeback fallback for @${agentId}: reasons=${fallbackReasons.join(',') || 'unknown'}`);
        enqueueOpenVikingSync(agentId, async () => {
            await appendTurnAndSyncOpenViking(workspacePath, agentId, messageId, message, response, isInternal);
        });
    } else if (!isInternal && OPENVIKING_SESSION_NATIVE_ENABLED && openVikingSessionId) {
        log('INFO', `OpenViking native write path complete for @${agentId}: session_id=${openVikingSessionId}`);
    }
}
