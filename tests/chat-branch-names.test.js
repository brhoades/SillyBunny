/* eslint-disable playwright/no-standalone-expect */
import { describe, expect, test } from '@jest/globals';

import { buildBranchName } from '../public/scripts/chat-branch-names.js';

describe('episode-style branch naming', () => {
    test.each([
        ['underscore separator, first take', 'Foobar_S01E04', 1, 'Foobar_S01E04.1'],
        ['space separator, unpadded season/episode', 'Foobar S4E1', 1, 'Foobar S4E1.1'],
        ['season letter qualifier', 'Foobar S2bE1', 1, 'Foobar S2bE1.1'],
        ['episode letter qualifier', 'Foobar S1E5a', 1, 'Foobar S1E5a.1'],
        ['padded take increments and keeps its width', 'Foobar_S20E02.04', 1, 'Foobar_S20E02.05'],
        ['unpadded take increments', 'Foobar S4E1.1', 1, 'Foobar S4E1.2'],
        ['multi-digit take leaves episode padding alone', 'Foobar S4E09.10', 1, 'Foobar S4E09.11'],
        ['carry preserves the padded width', 'Foobar S1E1.09', 1, 'Foobar S1E1.10'],
        ['carry on an unpadded take', 'Foobar S1E1.9', 1, 'Foobar S1E1.10'],
        ['collision retry increments further', 'Foobar S1E1.1', 3, 'Foobar S1E1.4'],
        ['take width grows rather than truncating', 'Foobar S123E456.99', 1, 'Foobar S123E456.100'],
        ['season/episode token at start of name', 'S01E04', 1, 'S01E04.1'],
        ['dash separator', 'Foobar-S01E04', 1, 'Foobar-S01E04.1'],
        ['dot separator', 'Foobar.S01E04', 1, 'Foobar.S01E04.1'],
        ['case insensitive', 'foobar s01e04', 1, 'foobar s01e04.1'],
        ['last season/episode token wins', 'Foo S1E1 Bar S2E2', 1, 'Foo S1E1 Bar S2E2.1'],
    ])('%s', (_label, name, index, expected) => {
        expect(buildBranchName(name, index)).toBe(expected);
    });

    test('the season/episode segment is copied verbatim, never reformatted', () => {
        expect(buildBranchName('Foobar S04E09', 1)).toBe('Foobar S04E09.1');
        expect(buildBranchName('Foobar S4E9', 1)).toBe('Foobar S4E9.1');
    });
});

describe('names without a season/episode token fall back to upstream branch naming', () => {
    test.each([
        ['no token at all', 'Foobar', 1, 'Foobar - Branch #1'],
        ['season only', 'Foobar S01', 1, 'Foobar S01 - Branch #1'],
        ['episode only', 'Foobar E04', 1, 'Foobar E04 - Branch #1'],
        ['no separator before the token', 'FoobarS01E04', 1, 'FoobarS01E04 - Branch #1'],
        ['trailing text after the token', 'Foobar S01E04 extra', 1, 'Foobar S01E04 extra - Branch #1'],
        ['non-numeric take', 'Foobar S01E04.abc', 1, 'Foobar S01E04.abc - Branch #1'],
        ['missing season number', 'Foobar SE1', 1, 'Foobar SE1 - Branch #1'],
        ['missing episode number', 'Foobar S1E', 1, 'Foobar S1E - Branch #1'],
        ['double take suffix', 'Foobar S01E04.1.2', 1, 'Foobar S01E04.1.2 - Branch #1'],
    ])('%s', (_label, name, index, expected) => {
        expect(buildBranchName(name, index)).toBe(expected);
    });

    test('existing branch suffix is stripped before renumbering', () => {
        expect(buildBranchName('Foobar S01E04 - Branch #2', 1)).toBe('Foobar S01E04 - Branch #1');
    });

    test('legacy branch prefix is stripped', () => {
        expect(buildBranchName('Branch #2 - Foobar', 1)).toBe('Foobar - Branch #1');
    });
});
