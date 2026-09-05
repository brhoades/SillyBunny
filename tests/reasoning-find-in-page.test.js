import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const styleSource = readFileSync(
    fileURLToPath(new URL('../public/style.css', import.meta.url)),
    'utf8',
).replace(/\r\n/g, '\n');

const reasoningSource = readFileSync(
    fileURLToPath(new URL('../public/scripts/reasoning.js', import.meta.url)),
    'utf8',
).replace(/\r\n/g, '\n');

describe('collapsed reasoning is excluded from browser find-in-page', () => {
    test('collapsed reasoning content is display:none, not merely visually hidden', () => {
        const ruleMatch = styleSource.match(
            /\.mes_reasoning_details:not\(\[open\]\) \.mes_reasoning,[\s\S]*?\{([\s\S]*?)\}/,
        );

        expect(ruleMatch).not.toBeNull();
        expect(ruleMatch[1]).toMatch(/display:\s*none/);
    });

    test('collapse state is driven by the open attribute so the selector tracks it', () => {
        expect(reasoningSource).toMatch(/messageReasoningDetailsDom\.open/);
    });

    test('editing a collapsed block still opens it, so the rule cannot hide the editor', () => {
        expect(reasoningSource).toMatch(/\.mes_reasoning_details'\)\.attr\('open', ''\)/);
    });
});
