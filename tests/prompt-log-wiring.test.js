/* eslint-disable playwright/no-standalone-expect */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative) => readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    'utf8',
).replace(/\r\n/g, '\n');

const util = read('../src/util.js');
const chatCompletions = read('../src/endpoints/backends/chat-completions.js');
const textCompletions = read('../src/endpoints/backends/text-completions.js');
const kobold = read('../src/endpoints/backends/kobold.js');
const config = read('../default/config.yaml');

describe('prompt log wiring', () => {
    test('forwardFetchResponse splices the stream tap without changing its signature', () => {
        expect(util).toMatch(/export async function forwardFetchResponse\(from, to, request = null, onDisconnect = null\)/);
        expect(util).toMatch(/request\?\.promptLog\?\.tapStream\?\.\(\)/);
        expect(util).toMatch(/promptLogTap\.pipe\(to\)/);
    });

    test.each([
        ['chat completions', chatCompletions],
        ['text completions', textCompletions],
        ['kobold', kobold],
    ])('%s attaches a prompt log to its generate handler', (_label, source) => {
        expect(source).toMatch(/import \{ attachPromptLog \} from '\.\.\/\.\.\/prompt-log\.js';/);
        expect(source).toMatch(/attachPromptLog\(request, /);
    });

    test('every provider records its upstream body through the shared verbose logger', () => {
        expect(chatCompletions).toMatch(/request\.promptLog\?\.upstream\(provider, payload\);/);
    });

    test('the upstream record is not gated on the client log_prompts flag', () => {
        const body = chatCompletions.slice(chatCompletions.indexOf('function logVerboseGenerationRequest'));
        const upstreamAt = body.indexOf('promptLog?.upstream(');
        const gateAt = body.indexOf('if (!request.body.log_prompts)');

        expect(upstreamAt).toBeGreaterThan(-1);
        expect(gateAt).toBeGreaterThan(-1);
        expect(upstreamAt).toBeLessThan(gateAt);
    });

    test('the client log_prompts debug dump is preserved', () => {
        expect(chatCompletions).toMatch(/if \(!request\.body\.log_prompts\) \{/);
    });

    test('config exposes the prompt logging keys', () => {
        expect(config).toMatch(/^ {2}promptConsole: header$/m);
        expect(config).toMatch(/^ {2}promptPreviewChars: 600$/m);
        expect(config).toMatch(/^ {2}promptFile:$/m);
        expect(config).toMatch(/^ {4}maxFileSize: 32mb$/m);
    });
});
