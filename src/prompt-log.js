import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { randomBytes } from 'node:crypto';
import bytes from 'bytes';
import { color, getConfigValue } from './util.js';

/** Max bytes of a streamed response kept in memory for the console preview. */
const STREAM_TAP_LIMIT = 256 * 1024;

/**
 * Upper bound for a single logged string. Generous on purpose: prompts are the point of
 * this log, so this only exists to stop a pathological field from filling the disk.
 */
const MAX_LOGGED_STRING = 128 * 1024;

let settings = null;

function getSettings() {
    if (!settings) {
        settings = {
            // SillyBunny: defaults to 'header' since a wrapped preview evicts fast from the ring-buffer log.
            consoleMode: String(getConfigValue('logging.promptConsole', 'header')),
            previewChars: getConfigValue('logging.promptPreviewChars', 600, 'number'),
            fileEnabled: getConfigValue('logging.promptFile.enabled', true, 'boolean'),
            directory: String(getConfigValue('logging.promptFile.directory', 'logs')),
            maxFileSize: bytes.parse(String(getConfigValue('logging.promptFile.maxFileSize', '32mb'))) || 32 * 1024 * 1024,
            maxFiles: getConfigValue('logging.promptFile.maxFiles', 10, 'number'),
        };
    }
    return settings;
}

let stream = null;
let streamBytes = 0;
let sinkDisabled = false;

const logDir = () => path.join(globalThis.DATA_ROOT, getSettings().directory);
const logPath = () => path.join(logDir(), 'prompts.jsonl');

function openStream() {
    fs.mkdirSync(logDir(), { recursive: true });
    streamBytes = fs.existsSync(logPath()) ? fs.statSync(logPath()).size : 0;
    const opened = fs.createWriteStream(logPath(), { flags: 'a' });
    // Only the live stream may disable the sink. A rotated-out handle can still emit an
    // error afterwards, and letting that through would silently drop the new file's records.
    opened.on('error', (error) => {
        if (stream !== opened) return;
        disableSink(error);
    });
    stream = opened;
}

function disableSink(error) {
    if (sinkDisabled) return;
    sinkDisabled = true;
    stream = null;
    console.error('Prompt log disabled after write failure:', error);
}

function rotate() {
    const { maxFiles } = getSettings();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    stream.end();
    stream = null;
    fs.renameSync(logPath(), path.join(logDir(), `prompts-${stamp}-${randomBytes(2).toString('hex')}.jsonl`));

    const rotated = fs.readdirSync(logDir()).filter(f => /^prompts-.+\.jsonl$/.test(f)).sort();
    for (const file of rotated.slice(0, Math.max(0, rotated.length - maxFiles))) {
        fs.unlinkSync(path.join(logDir(), file));
    }
    openStream();
}

function write(record) {
    const { fileEnabled, maxFileSize } = getSettings();
    if (!fileEnabled || sinkDisabled) return;

    try {
        if (!stream) openStream();
        const line = JSON.stringify(record) + '\n';
        streamBytes += Buffer.byteLength(line);
        stream.write(line);
        if (streamBytes >= maxFileSize) rotate();
    } catch (error) {
        disableSink(error);
    }
}

/**
 * Waits for queued records to reach the filesystem. Test-only: the sink is a write
 * stream, so records are not readable the instant `write()` returns.
 * @returns {Promise<void>} Resolves once pending writes have flushed
 */
export function flushPromptLogForTests() {
    return new Promise((resolve) => {
        if (!stream) {
            resolve();
            return;
        }
        if (stream.writableEnded) {
            resolve();
            return;
        }
        // An empty chunk queues behind the pending writes, so its callback marks the drain.
        stream.write(Buffer.alloc(0), () => resolve());
    });
}

/**
 * Resets memoized config and sink state. Test-only: settings are read once per process,
 * so a test that changes config must reset before the next read.
 * @returns {void}
 */
export function resetPromptLogSettingsForTests() {
    if (stream) {
        try {
            stream.removeAllListeners('error');
            stream.on('error', () => { /* discard errors from the retired handle */ });
            stream.end();
        } catch {
            // Nothing useful to do if the handle is already gone.
        }
    }
    settings = null;
    stream = null;
    streamBytes = 0;
    sinkDisabled = false;
}

const REDACTED_KEYS = new Set([
    'proxy_password', 'password', 'api_key', 'apikey', 'authorization', 'x-api-key',
    'access_token', 'refresh_token', 'client_secret', 'vertexai_auth_json', 'service_account',
    // SillyBunny sources carry these too.
    'reverse_proxy', 'proxy_url', 'custom_url', 'api_key_openai', 'api_key_claude', 'token',
]);

/** Credential shapes that appear inside string values rather than as their own key. */
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi;
const SECRET_VALUE_PATTERNS = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    /\bsk-[A-Za-z0-9_-]{16,}/g,
];
const DATA_URL_PATTERN = /^data:[^;,]*;base64,/i;

/**
 * Scrubs credentials that live inside a string value.
 * @param {string} value Raw string
 * @returns {string} Scrubbed string
 */
function redactString(value) {
    let out = value.replace(URL_USERINFO_PATTERN, '$1[redacted]@');
    for (const pattern of SECRET_VALUE_PATTERNS) {
        out = out.replace(pattern, '[redacted]');
    }
    return out;
}

/**
 * Deep-copies a body with credential-bearing fields replaced. Anything that cannot be
 * walked (cycles, exotic values) is passed through as-is. Base64 payloads and absurdly
 * long strings are summarized so inline images cannot fill the log.
 * @param {any} value Value to redact
 * @param {number} [depth] Current recursion depth
 * @returns {any} Redacted copy
 */
export function redact(value, depth = 0) {
    if (typeof value === 'string') {
        if (DATA_URL_PATTERN.test(value)) return { chars: value.length, kind: 'data-url' };
        if (value.length > MAX_LOGGED_STRING) return { chars: value.length };
        return redactString(value);
    }
    if (depth > 12 || !value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));

    const out = {};
    for (const [key, item] of Object.entries(value)) {
        out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(item, depth + 1);
    }
    return out;
}

const terminalWidth = () => Math.max(48, Math.min(process.stdout.columns || 100, 120));

/**
 * Formats a character count for display.
 * @param {number} count Character count
 * @returns {string} Human-readable count
 */
export function humanChars(count) {
    return count >= 1000 ? `${(count / 1000).toFixed(1)}k chars` : `${count} chars`;
}

/**
 * Formats a duration for display.
 * @param {number} ms Duration in milliseconds
 * @returns {string} Human-readable duration
 */
export function humanDuration(ms) {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/**
 * Word-wraps text to the terminal width and indents every line. Wrapping is skipped when
 * stdout is not a TTY, where a fixed width would only add noise to piped or captured logs.
 * @param {string} text Text to wrap
 * @param {string} indent Indent prefix
 * @returns {string[]} Wrapped lines
 */
export function wrapLines(text, indent) {
    if (!process.stdout.isTTY) {
        return text.split('\n').map(line => (line.trim() ? indent + line : ''));
    }

    const width = terminalWidth() - indent.length;
    const out = [];

    for (const paragraph of text.split('\n')) {
        if (!paragraph.trim()) {
            out.push('');
            continue;
        }
        let line = '';
        for (const word of paragraph.split(/\s+/)) {
            if (line && line.length + 1 + word.length > width) {
                out.push(indent + line);
                line = word;
            } else {
                line = line ? `${line} ${word}` : word;
            }
        }
        if (line) out.push(indent + line);
    }

    return out;
}

/**
 * Renders a truncated, indented preview block.
 * @param {any} text Text to render
 * @returns {string} Preview block, or an empty string when there is nothing to show
 */
export function renderBlock(text) {
    const { previewChars } = getSettings();
    const full = String(text ?? '').trim();
    if (!full) return '';

    const lines = wrapLines(full.slice(0, previewChars), '    ');
    if (full.length > previewChars) {
        lines.push(color.dim(`    … ${humanChars(full.length)} total`));
    }
    return lines.join('\n');
}

/**
 * Flattens a message content field into plain text.
 * @param {any} content Message content: string, or an array of content parts
 * @returns {string} Text content
 */
export function extractText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).filter(Boolean).join('\n');
    }
    return '';
}

function lastUserTurn(messages) {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') return extractText(messages[i]?.content);
    }
    return '';
}

/**
 * Best-effort text extraction from a parsed non-streamed completion response.
 * @param {any} body Response body
 * @returns {string} Response text
 */
export function extractResponseText(body) {
    if (!body || typeof body !== 'object') return '';
    const choice = body.choices?.[0];
    return extractText(choice?.message?.content)
        || choice?.text
        || extractText(body.content)
        || extractText(body.candidates?.[0]?.content?.parts)
        || extractText(body.message?.content)
        || extractText(body.results?.[0]?.text)
        || body.response
        || body.text
        || '';
}

/**
 * Best-effort text extraction from a raw SSE stream. Falls back to an empty
 * string when nothing recognizable is found; never throws.
 * @param {string} raw Accumulated stream body
 * @returns {string} Response text
 */
export function extractStreamText(raw) {
    let text = '';

    for (const line of String(raw ?? '').split('\n')) {
        const trimmed = line.trim();
        const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
        if (!payload || payload === '[DONE]' || !payload.startsWith('{')) continue;

        try {
            const data = JSON.parse(payload);
            const choice = data.choices?.[0];
            text += extractText(choice?.delta?.content)
                || choice?.text
                || data.delta?.text
                || extractText(data.candidates?.[0]?.content?.parts)
                || extractText(data.message?.content)
                || data.response
                || '';
        } catch {
            // Partial or non-JSON chunk, skip it.
        }
    }

    return text;
}

/**
 * Detects an error payload returned with a success status. Several providers reply
 * `response.send({ error: ... })` while leaving the status at 200.
 * @param {any} body Response body
 * @returns {boolean} True when the body reports an error
 */
function hasErrorPayload(body) {
    return Boolean(body && typeof body === 'object' && !Array.isArray(body) && body.error);
}

class PromptLog {
    constructor({ handle, api, model, stream: isStream, messages, prompt, body }) {
        const { consoleMode } = getSettings();

        this.id = randomBytes(3).toString('hex');
        this.startedAt = process.hrtime.bigint();
        this.ttfbMs = null;
        this.done = false;
        this.api = api;
        this.streamed = Boolean(isStream);
        this.tapped = '';
        this.tappedBytes = 0;
        this.hasTap = false;

        const promptText = prompt ?? lastUserTurn(messages);
        const size = typeof prompt === 'string' ? prompt.length : JSON.stringify(messages ?? '').length;

        write({
            ts: new Date().toISOString(),
            id: this.id,
            kind: 'request',
            user: handle,
            api,
            model,
            stream: this.streamed,
            body: redact(body ?? { messages, prompt }),
        });

        if (consoleMode === 'none') return;

        const parts = [api, model, this.streamed ? 'stream' : null].filter(Boolean).join(' · ');
        const counts = [Array.isArray(messages) ? `${messages.length} msgs` : null, humanChars(size)].filter(Boolean).join(' · ');
        console.info(`${color.cyan('→')} ${color.bold(parts)}\n  ${color.dim(`${counts} · #${this.id}`)}`);

        if (consoleMode !== 'header') {
            const block = renderBlock(promptText);
            if (block) console.info(`\n${block}\n`);
        }
    }

    get elapsedMs() {
        return Number(process.hrtime.bigint() - this.startedAt) / 1e6;
    }

    /**
     * Records the provider-specific body actually sent upstream. File only.
     * Tool-call recursion can call this several times; the records share one id.
     * @param {string} label Provider label
     * @param {any} body Converted request body
     */
    upstream(label, body) {
        write({ ts: new Date().toISOString(), id: this.id, kind: 'upstream', label, body: redact(body) });
    }

    /** Marks the moment the upstream response headers arrived. */
    markFirstByte() {
        if (this.ttfbMs === null) this.ttfbMs = this.elapsedMs;
    }

    /**
     * Wraps a forwarded stream so its text can be previewed once it completes.
     * Returns null when the exchange already has a tap or has finished, so that a
     * request forwarding more than once only measures the first response.
     * @returns {import('node:stream').PassThrough|null} Stream to splice into the pipe
     */
    tapStream() {
        if (this.hasTap || this.done) return null;
        this.hasTap = true;

        const tap = new PassThrough();

        tap.on('data', (chunk) => {
            this.markFirstByte();
            this.tappedBytes += chunk.length;
            if (this.tapped.length < STREAM_TAP_LIMIT) this.tapped += chunk.toString('utf-8');
        });
        tap.once('end', () => this.finish({ status: 200 }));

        return tap;
    }

    /**
     * Closes out the exchange with a successful response.
     * @param {object} options Response details
     * @param {number} [options.status] HTTP status
     * @param {any} [options.body] Parsed response body
     */
    finish({ status = 200, body = undefined } = {}) {
        if (this.done) return;
        this.done = true;
        this.markFirstByte();

        const ms = this.elapsedMs;
        const text = this.streamed ? extractStreamText(this.tapped) : extractResponseText(body);

        write({
            ts: new Date().toISOString(),
            id: this.id,
            kind: 'response',
            status,
            ms: Math.round(ms),
            ttfbMs: Math.round(this.ttfbMs),
            bytes: this.streamed ? this.tappedBytes : undefined,
            body: this.streamed ? undefined : redact(body),
        });

        const { consoleMode } = getSettings();
        if (consoleMode === 'none') return;

        const timings = [this.streamed ? `ttfb ${humanDuration(this.ttfbMs)}` : null, humanDuration(ms)].filter(Boolean).join(' · ');
        console.info(`${color.green('←')} ${status} ${color.dim(`· ${timings} · #${this.id}`)}`);

        if (consoleMode !== 'header') {
            const block = renderBlock(text);
            if (block) console.info(`\n${block}\n`);
        }
    }

    /**
     * Closes out the exchange with a failure. Console errors stay at the call site.
     * @param {object} options Failure details
     * @param {number|string} [options.status] HTTP status or error code
     * @param {any} [options.error] Error message or object
     * @param {any} [options.body] Upstream error body
     */
    fail({ status = undefined, error = undefined, body = undefined } = {}) {
        if (this.done) return;
        this.done = true;

        write({
            ts: new Date().toISOString(),
            id: this.id,
            kind: 'error',
            status,
            ms: Math.round(this.elapsedMs),
            error: error instanceof Error ? error.stack : error,
            body: redact(body),
        });
    }

    /** Finalizes an exchange that ended without an explicit outcome (abort, early return). */
    close(status) {
        if (this.done) return;

        // A streamed response that produced bytes finished normally; the client just
        // closed the socket before the tap drained.
        if (this.streamed && this.tappedBytes > 0) {
            this.finish({ status: status ?? 200 });
            return;
        }

        this.fail({ status, error: 'Request ended without a logged response' });
    }
}

/**
 * Starts logging a generation request. Returns null when logging is fully disabled.
 * @param {import('express').Request} request Express request
 * @param {object} options Request details
 * @param {string} options.api API/source name
 * @param {string} [options.model] Model name
 * @param {boolean} [options.stream] Whether the response is streamed
 * @param {any[]} [options.messages] Chat messages
 * @param {string} [options.prompt] Raw text prompt
 * @param {any} [options.body] Full inbound body to record
 * @returns {PromptLog|null} Log handle
 */
export function beginPromptLog(request, { api, model, stream: isStream, messages, prompt, body }) {
    const { consoleMode, fileEnabled } = getSettings();
    if (consoleMode === 'none' && !fileEnabled) return null;

    try {
        const log = new PromptLog({
            handle: request?.user?.profile?.handle,
            api,
            model,
            stream: isStream,
            messages,
            prompt,
            body,
        });
        request.promptLog = log;
        return log;
    } catch (error) {
        console.error('Failed to start prompt log:', error);
        return null;
    }
}

/** Marks a response whose terminating methods have already been wrapped. */
const PROMPT_LOG_PATCHED = Symbol('promptLogPatched');

/**
 * Starts a prompt log and closes it out by wrapping the response's terminating methods.
 * @param {import('express').Request} request Express request
 * @param {import('express').Response} response Express response
 * @param {object} options Request details, as accepted by `beginPromptLog`
 * @returns {object|null} Log handle
 */
export function attachPromptLog(request, response, options) {
    const log = beginPromptLog(request, options);
    if (!log || !response || response[PROMPT_LOG_PATCHED]) return log;
    response[PROMPT_LOG_PATCHED] = true;

    const settle = (body) => {
        if (log.done) return;
        const status = Number(response.statusCode) || 200;
        if (status >= 400 || hasErrorPayload(body)) {
            log.fail({ status, body });
            return;
        }
        log.finish({ status, body });
    };

    for (const method of ['send', 'json', 'end']) {
        const original = response[method];
        if (typeof original !== 'function') continue;

        response[method] = function (...args) {
            try {
                settle(args[0]);
            } catch (error) {
                console.error('Prompt log failed to record a response:', error);
            }
            return original.apply(this, args);
        };
    }

    response.on?.('close', () => {
        // Let a streaming tap flush before deciding the outcome; forwardFetchResponse
        // destroys the upstream body on close, so the tap's end may never fire.
        setImmediate(() => log.close(response.statusCode));
    });

    return log;
}
