/**
 * Validates an email address against a standard RFC-style pattern.
 * Rejects empty strings, missing domain/user parts, missing TLDs, and malformed formats.
 *
 * @param {string} email
 * @returns {boolean}
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim();
  // Standard RFC-style regex requiring valid local part, @, domain label(s), and valid TLD
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  return emailRegex.test(trimmed);
}

/**
 * Masks an email address for safe public reporting in step summaries and logs.
 * Example: "john.doe@example.com" -> "j***e@example.com"
 *
 * @param {string} email
 * @returns {string}
 */
function maskEmail(email) {
  if (!email || typeof email !== 'string') return '';
  const trimmed = email.trim();
  const atIndex = trimmed.lastIndexOf('@');
  if (atIndex <= 0) return '***';

  const user = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);

  if (user.length <= 2) {
    return `${user[0]}***@${domain}`;
  }
  return `${user[0]}***${user[user.length - 1]}@${domain}`;
}

/**
 * Extracts all valid Signed-off-by trailers from a commit message.
 * Formats supported: "Signed-off-by: First Last <email@domain.com>"
 * Strictly validates trailer syntax and email format.
 *
 * @param {string} message Commit message
 * @returns {Array<{ name: string, email: string }>}
 */
function extractDcoTrailers(message) {
  if (!message || typeof message !== 'string') return [];
  const trailers = [];
  const regex = /Signed-off-by:\s*([^<\r\n]+)<([^>\r\n]+)>/gi;
  let match;
  while ((match = regex.exec(message)) !== null) {
    const name = match[1].trim();
    const rawEmail = match[2].trim();
    if (name && isValidEmail(rawEmail)) {
      trailers.push({ name, email: rawEmail.toLowerCase() });
    }
  }
  return trailers;
}

/**
 * Resolves contributor identity and strictly verifies DCO compliance against commit history.
 *
 * Attribution Contract:
 * PR Author
 * → GitHub-associated commit author matching PR author (strictly commit.author.login === prAuthor)
 * → DCO Signed-off-by trailer attributable to that commit author
 * → verified email
 *
 * Zero Git or network dependencies.
 *
 * @param {string} prAuthor PR author's GitHub login handle
 * @param {Array<Object>} commits List of commit objects (from GitHub API pulls/commits)
 * @returns {{ resolvedEmail: string|null, dcoVerified: boolean, reason: string }}
 */
function resolveIdentity(prAuthor, commits) {
  if (!prAuthor || typeof prAuthor !== 'string') {
    return {
      resolvedEmail: null,
      dcoVerified: false,
      reason: 'Missing or invalid PR author login'
    };
  }

  if (!Array.isArray(commits) || commits.length === 0) {
    return {
      resolvedEmail: null,
      dcoVerified: false,
      reason: 'No commits provided for evaluation'
    };
  }

  const normalizedPrAuthor = prAuthor.trim().toLowerCase();
  const commitEmails = [];

  for (let idx = 0; idx < commits.length; idx++) {
    const item = commits[idx];
    const sha = (item && item.sha ? item.sha.slice(0, 7) : `commit-${idx + 1}`);

    if (!item) {
      return {
        resolvedEmail: null,
        dcoVerified: false,
        reason: `Encountered empty commit entry at index ${idx}`
      };
    }

    // 1. GitHub-associated author verification (Do NOT fall back to committer)
    if (!item.author || !item.author.login) {
      return {
        resolvedEmail: null,
        dcoVerified: false,
        reason: `Commit ${sha} lacks a GitHub-associated author account`
      };
    }

    const commitAuthorLogin = item.author.login.trim().toLowerCase();
    if (commitAuthorLogin !== normalizedPrAuthor) {
      return {
        resolvedEmail: null,
        dcoVerified: false,
        reason: `Commit ${sha} author '@${item.author.login}' does not match PR author '@${prAuthor}'`
      };
    }

    // 2. Git commit author metadata
    const gitAuthor = item.commit && item.commit.author ? item.commit.author : {};
    const gitAuthorEmail = (gitAuthor.email || '').trim().toLowerCase();
    const gitAuthorName = (gitAuthor.name || '').trim().toLowerCase();

    // 3. Extract DCO trailers
    const message = item.commit ? item.commit.message : (item.message || '');
    const trailers = extractDcoTrailers(message);

    if (trailers.length === 0) {
      return {
        resolvedEmail: null,
        dcoVerified: false,
        reason: `Commit ${sha} is missing a valid DCO Signed-off-by trailer`
      };
    }

    // 4. Attributable trailer selection
    let attributableTrailer = null;

    if (trailers.length === 1) {
      const single = trailers[0];
      // Verify single trailer isn't an arbitrary mismatched third-party
      const emailMatches = gitAuthorEmail && single.email === gitAuthorEmail;
      const nameMatches = gitAuthorName && single.name.toLowerCase() === gitAuthorName;
      const isNoreply = gitAuthorEmail.includes('noreply.github.com');

      if (emailMatches || nameMatches || isNoreply) {
        attributableTrailer = single;
      } else {
        // Name and email both mismatch git author
        return {
          resolvedEmail: null,
          dcoVerified: false,
          reason: `Commit ${sha} Signed-off-by trailer '${single.email}' does not match git commit author '${gitAuthorEmail || gitAuthorName}'`
        };
      }
    } else {
      // Multiple trailers: find trailer matching the author's git email or name
      const matchingTrailers = trailers.filter(t => {
        if (gitAuthorEmail && t.email === gitAuthorEmail) return true;
        if (gitAuthorName && t.name.toLowerCase() === gitAuthorName) return true;
        return false;
      });

      if (matchingTrailers.length === 1) {
        attributableTrailer = matchingTrailers[0];
      } else if (matchingTrailers.length === 0) {
        return {
          resolvedEmail: null,
          dcoVerified: false,
          reason: `Commit ${sha} has multiple Signed-off-by trailers but none match commit author '${gitAuthorEmail || gitAuthorName}'`
        };
      } else {
        // Multiple trailers claim to match author; check if they share the exact same email
        const distinctEmails = [...new Set(matchingTrailers.map(t => t.email))];
        if (distinctEmails.length === 1) {
          attributableTrailer = matchingTrailers[0];
        } else {
          return {
            resolvedEmail: null,
            dcoVerified: false,
            reason: `Commit ${sha} has conflicting Signed-off-by trailers for author '${gitAuthorName}'`
          };
        }
      }
    }

    commitEmails.push(attributableTrailer.email);
  }

  // 5. Verify email consistency across all commits in PR
  const distinctEmails = [...new Set(commitEmails)];
  if (distinctEmails.length > 1) {
    return {
      resolvedEmail: null,
      dcoVerified: false,
      reason: `PR contains conflicting Signed-off-by emails across commits (${distinctEmails.map(maskEmail).join(', ')})`
    };
  }

  const verifiedEmail = distinctEmails[0];
  return {
    resolvedEmail: verifiedEmail,
    dcoVerified: true,
    reason: `Verified ${commits.length} commit(s) by @${prAuthor} with attributable DCO Signed-off-by trailer`
  };
}

module.exports = {
  isValidEmail,
  maskEmail,
  extractDcoTrailers,
  resolveIdentity
};
