import { chat, substituteParams } from '../../script.js';
import { MacroCategory, MacroRegistry, MacroValueType } from './engine/MacroRegistry.js';

/** Cheap gate so the macro engine is never re-run on messages without notes. */
const HAS_OOC = /\{\{[\s!?~#]*\/?\s*ooc\b/i;

/** Private-use markers. Invisible to markdown, showdown, encode_tags and DOMPurify. */
const OPEN = '';
const MID = '';
const CLOSE = '';
const GONE = '';

/**
 * Splits a call into its send count and its text.
 * Handles `{{ooc::2::x}}` (args split on `::`), `{{ooc:2:x}}` (one colon-tolerant arg,
 * see MacroParser.js argumentAllowingColons) and the scoped form, where the body is
 * always the last argument.
 * @param {import('./engine/MacroRegistry.js').MacroExecutionContext} ctx
 * @returns {{ count: number, text: string }}
 */
function readNote(ctx) {
    const args = Array.isArray(ctx.args) ? ctx.args : [];

    if (ctx.isScoped) {
        const head = args.at(-2);
        return {
            count: /^\s*\d+\s*$/.test(head ?? '') ? parseInt(head, 10) : 0,
            text: args.at(-1) ?? '',
        };
    }

    if (args.length > 1 && /^\s*\d+\s*$/.test(args[0])) {
        return { count: parseInt(args[0], 10), text: args.slice(1).join('::') };
    }

    const singleColon = /^\s*(\d+)\s*:\s?([\s\S]*)$/.exec(args[0] ?? '');
    if (singleColon) {
        return { count: parseInt(singleColon[1], 10), text: [singleColon[2], ...args.slice(1)].join('::') };
    }

    return { count: 0, text: args.join('::') };
}

/**
 * Rebuilds the call's own source. `rawWithBraces` covers the opening tag only
 * (MacroCstWalker.js:501), so the scoped body and closing tag are re-appended.
 * @param {import('./engine/MacroRegistry.js').MacroExecutionContext} ctx
 * @returns {string}
 */
function preserve(ctx) {
    return ctx.isScoped
        ? `${ctx.rawOriginal}${ctx.rawArgs.at(-1) ?? ''}{{/ooc}}`
        : ctx.rawOriginal;
}

/** Shared definition. Only the handler differs between save, prompt and display. */
const definition = {
    category: MacroCategory.UTILITY,
    // Not `list: true` — list macros are refused scoped content (MacroCstWalker.js #canAcceptScopedContent).
    unnamedArgs: [
        { name: 'count', optional: true, type: MacroValueType.STRING, description: 'Sends to pass the note to the LLM for. Omitted when the macro has only one argument.' },
        { name: 'text', optional: true, type: MacroValueType.STRING, description: 'The note. Supplied by the scoped body when the macro is written as a block.' },
    ],
    strictArgs: false,
    delayArgResolution: true,
    description: 'An out-of-character note. Stays in your message forever and is always visible to you. The optional leading number is how many of your own sends it is passed to the LLM for, as "[OOC: ...]", counting the send it was written in. Without a number (or with 0) it is never sent at all.',
    returns: 'Nothing, until the prompt is built.',
    displayOverride: '{{ooc::count::text}}',
    exampleUsage: [
        '{{ooc::he does this when he is interested}}',
        '{{ooc::3::keep the boar skull in play}}',
        '{{ooc::2}}multi-line note{{/ooc}}',
    ],
};

export function registerOocMacro() {
    MacroRegistry.registerMacro('ooc', { ...definition, handler: preserve });
}

/**
 * Runs the engine over `text` with `ooc` overridden. A dynamic macro wins over the
 * registered one (MacroEngine.js:180-217), so one parser serves every context.
 * @param {string} text
 * @param {import('./engine/MacroRegistry.js').MacroHandler} handler
 * @returns {string}
 */
function reparse(text, handler) {
    if (!text || !HAS_OOC.test(text)) {
        return text;
    }
    return substituteParams(text, { dynamicMacros: { ooc: { ...definition, handler } } });
}

/**
 * Number of the user's own sends that happened after a message, ignoring hidden
 * messages so this matches the coreChat the prompt is built from.
 * @param {object[]} messages
 * @param {number} index
 * @returns {number}
 */
export function sendsAfter(messages, index) {
    let count = 0;
    for (let i = index + 1; i < messages.length; i++) {
        if (!messages[i].is_system && messages[i].is_user) {
            count++;
        }
    }
    return count;
}

/**
 * Resolves notes for the prompt: live ones become `[OOC: ...]`, spent ones are removed
 * along with the line they sat on.
 * @param {string} text
 * @param {number} sends How many of the user's sends have happened since this message.
 * @returns {string}
 */
export function resolveOocNotes(text, sends) {
    const resolved = reparse(text, (ctx) => {
        const { count, text: body } = readNote(ctx);
        if (sends >= count) {
            return GONE;
        }
        return `[OOC: ${ctx.resolve(body).trim()}]`;
    });

    if (resolved === text) {
        return text;
    }

    const cleaned = resolved
        .replace(/^[ \t]*[ \t]*\r?\n?/gm, '')
        .replace(/[ \t]*/g, '');

    return cleaned.trim() ? cleaned : '';
}

/** Same count, but read off the live chat for a message being rendered. */
function sendsAfterMessage(messageId) {
    return messageId >= 0 ? sendsAfter(chat, Number(messageId)) : 0;
}

/**
 * Marks up notes before markdown conversion. The body is left inline so showdown still
 * renders the markdown inside it.
 * @param {string} mes
 * @param {boolean} isUser
 * @param {number} messageId
 * @returns {string}
 */
export function markOocNotes(mes, isUser, messageId) {
    if (!isUser || !HAS_OOC.test(mes)) {
        return mes;
    }

    const sends = sendsAfterMessage(messageId);
    const marked = reparse(mes, (call) => {
        const { count, text } = readNote(call);
        const active = sends + 1 < count;
        const block = call.isScoped || text.includes('\n');
        return `${OPEN}${block ? 'b' : 'i'}${active ? 'a' : 's'}${count}${MID}${text}${CLOSE}`;
    });

    // A note that sits on its own line reads as a block, whatever form it was written in.
    return marked.replace(
        /(^|\n)([ \t]*)i([as])(\d+)([\s\S]*?)([ \t]*)(?=\r?\n|$)/g,
        (_, lead, indent, state, count, body, trail) => `${lead}${indent}${OPEN}b${state}${count}${MID}${body}${CLOSE}${trail}`,
    );
}

/**
 * Swaps the markers for real elements once markdown is done.
 * @param {string} mes
 * @param {boolean} isUser
 * @returns {string}
 */
export function renderOocNotes(mes, isUser) {
    if (!isUser || !mes.includes(OPEN)) {
        return mes;
    }

    // Lift block notes out of the paragraph showdown wrapped them in, so their inner
    // block elements (blockquotes, lists) end up validly nested.
    const out = mes
        .replace(/<p>\s*(b[as]\d+)/g, '$1<p>')
        .replace(/\s*<\/p>/g, '</p>');

    return out.replace(/([bi])([as])(\d+)([\s\S]*?)/g, (_, form, state, count, body) => {
        const tag = form === 'b' ? 'div' : 'span';
        const classes = [form === 'b' ? 'comment-block' : 'comment', state === 'a' ? 'ooc-active' : 'ooc-spent'];
        const data = Number(count) > 0 ? ` data-ooc-count="${count}"` : '';
        return `<${tag} class="${classes.join(' ')}"${data}>${body}</${tag}>`;
    });
}

export function initOocNotes() {
    registerOocMacro();
}
