import morgan from 'morgan';
import { getIpAddress } from '../express-common.js';
import { color, getConfigValue } from '../util.js';

const MODES = new Set(['errors', 'api', 'all']);

/**
 * Picks the chalk style for a status code. Zero means the response was torn down
 * before headers went out, which is the client-hangup case.
 * @param {number} status
 */
function statusColor(status) {
    if (!status) return color.magenta;
    if (status >= 500) return color.red;
    if (status >= 400) return color.yellow;
    if (status >= 300) return color.cyan;
    return color.green;
}

/**
 * Console levels are looked up at call time so the wrappers installed by
 * setupLogLevel() still gate this output.
 * @param {number} status
 * @param {boolean} aborted
 * @returns {(line: string) => void}
 */
function logAtLevel(status, aborted) {
    if (status >= 500) return line => console.error(line);
    if (aborted || !status || status >= 400) return line => console.warn(line);
    return line => console.info(line);
}

function shouldLog(mode, url, status, aborted) {
    if (mode === 'all') return true;
    if (aborted || !status || status >= 400) return true;
    return mode === 'api' && url.startsWith('/api/');
}

function describeClient(request) {
    try {
        return getIpAddress(request, true) || '-';
    } catch {
        // The socket can already be gone when a request is logged on abort.
        return '-';
    }
}

/**
 * Creates middleware for logging every request that reaches the app.
 * @returns {import('express').RequestHandler}
 */
export default function requestLoggerMiddleware() {
    if (!getConfigValue('logging.requestLog.enabled', false, 'boolean')) {
        return function (_request, _response, next) {
            next();
        };
    }

    const configuredMode = String(getConfigValue('logging.requestLog.mode', 'errors'));
    const mode = MODES.has(configuredMode) ? configuredMode : 'errors';

    if (!MODES.has(configuredMode)) {
        console.warn(color.yellow(`Unknown logging.requestLog.mode "${configuredMode}"; falling back to "errors".`));
    }

    // Morgan skips its own writer when the format function returns null, so the
    // format function both renders and dispatches. A morgan stream only receives
    // the finished string, which would mean parsing the status back out to choose
    // a log level.
    return morgan(function (tokens, request, response) {
        const status = response.headersSent ? response.statusCode : 0;
        const url = tokens.url(request, response) || request.originalUrl || '';
        const aborted = !response.writableFinished; // socket closed

        if (!shouldLog(mode, url, status, aborted)) {
            return null;
        }

        const paint = aborted ? color.magenta : statusColor(status);
        const handle = request.user?.profile?.handle || '-';
        const length = tokens.res(request, response, 'content-length') || '-';
        const elapsed = tokens['response-time'](request, response, 3) || '-';

        logAtLevel(status, aborted)([
            color.dim(tokens.date(request, response, 'iso')),
            color.cyan(describeClient(request)),
            color.dim(handle),
            color.bold(tokens.method(request, response)),
            url,
            color.dim(`HTTP/${tokens['http-version'](request, response)}`),
            color.dim('->'),
            paint(aborted ? `${status || '---'} aborted` : status),
            color.dim(length),
            color.dim('-'),
            `${paint(elapsed)} ms`,
        ].join(' '));

        return null;
    });
}
