// Dependency-free so it's unit-testable without loading script.js.

const episodeNameRegex = /^(.*(?:^|[^A-Za-z0-9])S\d+[A-Za-z]*E\d+[A-Za-z]*)(?:\.(\d+))?$/i;

const branchSuffixRegex = / - Branch #\d+$/;
const legacyBranchPrefixRegex = /^Branch #\d+ - /;

/**
 * Builds the name for the nth branch of a chat.
 * Episode-titled chats (`S4E01`) branch into takes (`S4E01.1`); everything else
 * falls back to upstream's `- Branch #N`.
 * @param {string} name Base chat name.
 * @param {number} i One-based branch index supplied by `getUniqueName`.
 * @returns {string} The branch name.
 */
export function buildBranchName(name, i) {
    const episode = episodeNameRegex.exec(name);
    if (episode) {
        const existingTake = episode[2];
        const width = existingTake?.length ?? 0;
        const nextTake = Number(existingTake ?? 0) + i;
        return `${episode[1]}.${String(nextTake).padStart(width, '0')}`;
    }

    const cleanName = name.replace(branchSuffixRegex, '').replace(legacyBranchPrefixRegex, '');
    return `${cleanName} - Branch #${i}`;
}
