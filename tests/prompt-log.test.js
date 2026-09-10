/* eslint-disable playwright/no-standalone-expect */
/* global globalThis */
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const {
    attachPromptLog,
    beginPromptLog,
    extractResponseText,
    extractStreamText,
    extractText,
    humanChars,
    humanDuration,
    redact,
    renderBlock,
    flushPromptLogForTests,
    resetPromptLogSettingsForTests,
    wrapLines,
} = await import('../src/prompt-log.js');

let dataRoot;

async function logLines() {
    await flushPromptLogForTests();
    const file = path.join(dataRoot, 'logs', 'prompts.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function fakeResponse() {
    const listeners = {};
    return {
        statusCode: 200,
        sent: [],
        status(code) { this.statusCode = code; return this; },
        send(body) { this.sent.push(body); return this; },
        json(body) { this.sent.push(body); return this; },
        end() { return this; },
        on(event, handler) { listeners[event] = handler; return this; },
        emit(event) { listeners[event]?.(); },
    };
}

async function flush() {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
}

beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-log-'));
    globalThis.DATA_ROOT = dataRoot;
    resetPromptLogSettingsForTests();
});

afterEach(() => {
    resetPromptLogSettingsForTests();
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('redact', () => {
    test.each([
        'api_key', 'API_KEY', 'authorization', 'x-api-key', 'password', 'proxy_password',
        'access_token', 'refresh_token', 'client_secret', 'vertexai_auth_json', 'reverse_proxy',
    ])('replaces the %s field regardless of case', (key) => {
        expect(redact({ [key]: 'sensitive' })[key]).toBe('[redacted]');
    });

    test('redacts nested and array members', () => {
        const out = redact({ outer: { api_key: 'k' }, list: [{ password: 'p' }] });
        expect(out.outer.api_key).toBe('[redacted]');
        expect(out.list[0].password).toBe('[redacted]');
    });

    test('does not mutate the input', () => {
        const input = { api_key: 'secret', keep: 'value' };
        redact(input);
        expect(input.api_key).toBe('secret');
    });

    test('scrubs bearer tokens and sk- keys inside string values', () => {
        expect(redact({ note: 'use Bearer abcdef1234567890 now' }).note).toBe('use [redacted] now');
        expect(redact({ note: 'key sk-abcdefghij0123456789 here' }).note).toBe('key [redacted] here');
    });

    test('scrubs credentials embedded in a proxy URL', () => {
        expect(redact({ url: 'https://user:hunter2@example.com/v1' }).url)
            .toBe('https://[redacted]@example.com/v1');
    });

    test('summarizes base64 data URLs instead of storing them', () => {
        const dataUrl = `data:image/png;base64,${'A'.repeat(5000)}`;
        expect(redact({ image: dataUrl }).image).toEqual({ chars: dataUrl.length, kind: 'data-url' });
    });

    test('keeps ordinary long prompts intact', () => {
        const prompt = 'x'.repeat(50_000);
        expect(redact({ prompt }).prompt).toBe(prompt);
    });

    test('summarizes absurdly long strings', () => {
        const huge = 'y'.repeat(200_000);
        expect(redact({ blob: huge }).blob).toEqual({ chars: huge.length });
    });

    test('stops recursing past the depth limit', () => {
        let deep = { api_key: 'k' };
        for (let i = 0; i < 20; i++) deep = { nested: deep };
        expect(() => redact(deep)).not.toThrow();
    });

    test('passes through non-objects', () => {
        expect(redact(42)).toBe(42);
        expect(redact(null)).toBe(null);
    });
});

describe('text extraction', () => {
    test.each([
        ['plain string', 'hello', 'hello'],
        ['array of strings', ['a', 'b'], 'a\nb'],
        ['array of parts', [{ text: 'a' }, { text: 'b' }], 'a\nb'],
        ['mixed parts', ['a', { text: 'b' }, { image: 'x' }], 'a\nb'],
        ['object', { text: 'a' }, ''],
        ['null', null, ''],
    ])('extractText handles %s', (_label, input, expected) => {
        expect(extractText(input)).toBe(expected);
    });

    test.each([
        ['OpenAI chat', { choices: [{ message: { content: 'hi' } }] }, 'hi'],
        ['legacy completion', { choices: [{ text: 'hi' }] }, 'hi'],
        ['Claude', { content: [{ text: 'hi' }] }, 'hi'],
        ['Gemini', { candidates: [{ content: { parts: [{ text: 'hi' }] } }] }, 'hi'],
        ['Kobold', { results: [{ text: 'hi' }] }, 'hi'],
        ['empty object', {}, ''],
        ['non-object', 'nope', ''],
    ])('extractResponseText handles %s', (_label, input, expected) => {
        expect(extractResponseText(input)).toBe(expected);
    });

    test('extractStreamText assembles OpenAI deltas and ignores [DONE]', () => {
        const raw = [
            'data: {"choices":[{"delta":{"content":"He"}}]}',
            'data: {"choices":[{"delta":{"content":"llo"}}]}',
            'data: [DONE]',
        ].join('\n');
        expect(extractStreamText(raw)).toBe('Hello');
    });

    test('extractStreamText handles Claude deltas', () => {
        expect(extractStreamText('data: {"delta":{"text":"hi"}}')).toBe('hi');
    });

    test('extractStreamText skips partial or non-JSON chunks', () => {
        expect(extractStreamText('data: {"choices":[{"delta"')).toBe('');
        expect(extractStreamText('')).toBe('');
    });
});

describe('formatting helpers', () => {
    test.each([
        [999, '999 chars'],
        [1000, '1.0k chars'],
        [12345, '12.3k chars'],
    ])('humanChars(%i)', (input, expected) => {
        expect(humanChars(input)).toBe(expected);
    });

    test.each([
        [999, '999ms'],
        [1000, '1.0s'],
    ])('humanDuration(%i)', (input, expected) => {
        expect(humanDuration(input)).toBe(expected);
    });

    test('wrapLines indents every non-empty line and preserves blank lines', () => {
        const out = wrapLines('one\n\ntwo', '  ');
        expect(out).toEqual(['  one', '', '  two']);
    });

    test('renderBlock truncates and reports the full size', () => {
        const block = renderBlock('z'.repeat(2000));
        expect(block).toContain('2.0k chars total');
    });

    test('renderBlock returns empty for blank input', () => {
        expect(renderBlock('   ')).toBe('');
        expect(renderBlock(null)).toBe('');
    });
});

describe('beginPromptLog', () => {
    test('writes a request record and attaches the log to the request', async () => {
        const request = {};
        const log = beginPromptLog(request, { api: 'openai', model: 'gpt', messages: [{ role: 'user', content: 'hi' }] });

        expect(log).not.toBeNull();
        expect(request.promptLog).toBe(log);

        const [record] = await logLines();
        expect(record.kind).toBe('request');
        expect(record.api).toBe('openai');
    });

    test('redacts credentials in the recorded body', async () => {
        beginPromptLog({}, { api: 'openai', body: { api_key: 'secret', messages: [] } });
        expect((await logLines())[0].body.api_key).toBe('[redacted]');
    });

    test('redacts credentials nested past the redact() depth limit', async () => {
        let deep = { api_key: 'secret' };
        for (let i = 0; i < 20; i++) deep = { nested: deep };
        beginPromptLog({}, { api: 'openai', body: deep });

        let body = (await logLines())[0].body;
        while (body?.nested) body = body.nested;
        expect(body.api_key).toBe('[redacted]');
    });

    test('never throws on a malformed request', () => {
        expect(() => beginPromptLog(null, { api: 'openai' })).not.toThrow();
    });
});

describe('attachPromptLog', () => {
    test('a successful send is logged as a response', async () => {
        const request = {};
        const response = fakeResponse();
        attachPromptLog(request, response, { api: 'openai', messages: [] });

        response.send({ choices: [{ message: { content: 'hi' } }] });

        const records = await logLines();
        expect(records.at(-1).kind).toBe('response');
        expect(records.at(-1).status).toBe(200);
    });

    test('an error status is logged as an error', async () => {
        const response = fakeResponse();
        attachPromptLog({}, response, { api: 'openai', messages: [] });

        response.status(429).send({ message: 'slow down' });

        expect((await logLines()).at(-1).kind).toBe('error');
        expect((await logLines()).at(-1).status).toBe(429);
    });

    test('an error body sent with status 200 is still logged as an error', async () => {
        const response = fakeResponse();
        attachPromptLog({}, response, { api: 'openai', messages: [] });

        response.send({ error: { message: 'upstream refused' } });

        expect((await logLines()).at(-1).kind).toBe('error');
    });

    test('the response is only recorded once', async () => {
        const response = fakeResponse();
        attachPromptLog({}, response, { api: 'openai', messages: [] });

        response.send({ choices: [] });
        response.send({ choices: [] });
        response.end();

        expect((await logLines()).filter(r => r.kind === 'response')).toHaveLength(1);
    });

    test('the original response method still runs', () => {
        const response = fakeResponse();
        attachPromptLog({}, response, { api: 'openai', messages: [] });

        response.send('payload');

        expect(response.sent).toEqual(['payload']);
    });

    test('a close with no response at all is logged as an error', async () => {
        const response = fakeResponse();
        attachPromptLog({}, response, { api: 'openai', messages: [] });

        response.emit('close');
        await flush();

        expect((await logLines()).at(-1).kind).toBe('error');
    });
});

describe('stream tapping', () => {
    test('a tap records streamed text and finishes the exchange', async () => {
        const request = {};
        attachPromptLog(request, fakeResponse(), { api: 'openai', stream: true, messages: [] });

        const tap = request.promptLog.tapStream();
        tap.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n');
        tap.end();
        tap.resume();

        await flush();

        const record = (await logLines()).at(-1);
        expect(record.kind).toBe('response');
        expect(record.bytes).toBeGreaterThan(0);
    });

    test('only the first tap is handed out', () => {
        const request = {};
        attachPromptLog(request, fakeResponse(), { api: 'openai', stream: true, messages: [] });

        expect(request.promptLog.tapStream()).not.toBeNull();
        expect(request.promptLog.tapStream()).toBeNull();
    });

    test('a client abort after bytes arrived counts as a response, not an error', async () => {
        const request = {};
        const response = fakeResponse();
        attachPromptLog(request, response, { api: 'openai', stream: true, messages: [] });

        const tap = request.promptLog.tapStream();
        tap.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n');
        tap.resume();
        await flush();

        response.emit('close');
        await flush();

        expect((await logLines()).at(-1).kind).toBe('response');
    });
});

describe('file sink', () => {
    test('rotates once the size limit is passed and prunes old files', async () => {
        process.env.SILLYTAVERN_LOGGING_PROMPTFILE_MAXFILESIZE = '8kb';
        process.env.SILLYTAVERN_LOGGING_PROMPTFILE_MAXFILES = '2';
        resetPromptLogSettingsForTests();

        try {
            for (let i = 0; i < 12; i++) {
                beginPromptLog({}, { api: 'openai', body: { blob: 'q'.repeat(4000) } });
                await flushPromptLogForTests();
            }

            const files = fs.readdirSync(path.join(dataRoot, 'logs'));
            const rotated = files.filter(f => /^prompts-.+\.jsonl$/.test(f));

            expect(files).toContain('prompts.jsonl');
            expect(rotated.length).toBeGreaterThan(0);
            expect(rotated.length).toBeLessThanOrEqual(2);
        } finally {
            delete process.env.SILLYTAVERN_LOGGING_PROMPTFILE_MAXFILESIZE;
            delete process.env.SILLYTAVERN_LOGGING_PROMPTFILE_MAXFILES;
        }
    });

    test('a write failure disables the sink instead of throwing', () => {
        fs.mkdirSync(path.join(dataRoot, 'logs'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, 'logs', 'prompts.jsonl'), '');
        fs.chmodSync(path.join(dataRoot, 'logs', 'prompts.jsonl'), 0o400);

        expect(() => beginPromptLog({}, { api: 'openai', messages: [] })).not.toThrow();
    });
});
