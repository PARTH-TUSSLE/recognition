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
 * Extracts all Signed-off-by trailers from a commit message.
 * Formats supported: "Signed-off-by: First Last <email@domain.com>"
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
    const email = match[2].trim().toLowerCase();
    if (email && email.includes('@')) {
      trailers.push({ name, email });
    }
  }
  return trailers;
}

/**
 * Resolves contributor identity and verifies DCO compliance against commit history.
 * Pure function: (authorLogin, commits) -> { resolvedEmail, dcoVerified, reason }
 * Zero Git or network dependencies.
 *
 * @param {string} authorLogin PR author's GitHub login handle
 * @param {Array<Object>} commits List of commit objects (from GitHub API pulls/commits)
 * @returns {{ resolvedEmail: string|null, dcoVerified: boolean, reason: string }}
 */
function resolveIdentity(authorLogin, commits) {
  if (!authorLogin || typeof authorLogin !== 'string') {
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

  const normalizedAuthor = authorLogin.trim().toLowerCase();

  // Find commits where GitHub author matches the PR author
  const authorCommits = commits.filter(item => {
    if (!item) return false;
    const commitAuthorLogin = item.author && item.author.login ? item.author.login.trim().toLowerCase() : null;
    // Fallback: check committer if author is missing
    const commitCommitterLogin = item.committer && item.committer.login ? item.committer.login.trim().toLowerCase() : null;
    return commitAuthorLogin === normalizedAuthor || (!commitAuthorLogin && commitCommitterLogin === normalizedAuthor);
  });

  if (authorCommits.length === 0) {
    return {
      resolvedEmail: null,
      dcoVerified: false,
      reason: `No commits in PR matched GitHub login '${authorLogin}'`
    };
  }

  const signedEmails = [];
  const missingDcoShas = [];

  for (const item of authorCommits) {
    const message = item.commit ? item.commit.message : (item.message || '');
    const sha = (item.sha || 'unknown').slice(0, 7);
    const trailers = extractDcoTrailers(message);

    if (trailers.length === 0) {
      missingDcoShas.push(sha);
    } else {
      // Collect valid email
      signedEmails.push(trailers[0].email);
    }
  }

  if (missingDcoShas.length > 0) {
    const firstResolvedEmail = signedEmails.length > 0 ? signedEmails[0] : null;
    return {
      resolvedEmail: firstResolvedEmail,
      dcoVerified: false,
      reason: `DCO Signed-off-by trailer missing in ${missingDcoShas.length} commit(s) by ${authorLogin} (e.g. ${missingDcoShas.slice(0, 3).join(', ')})`
    };
  }

  // Count email occurrences to find primary address
  const emailCounts = {};
  for (const email of signedEmails) {
    emailCounts[email] = (emailCounts[email] || 0) + 1;
  }

  const sortedEmails = Object.keys(emailCounts).sort((a, b) => emailCounts[b] - emailCounts[a]);
  const primaryEmail = sortedEmails[0] || null;

  return {
    resolvedEmail: primaryEmail,
    dcoVerified: true,
    reason: `Verified ${authorCommits.length} commit(s) by ${authorLogin} with valid Signed-off-by trailer`
  };
}

module.exports = {
  resolveIdentity,
  extractDcoTrailers,
  maskEmail
};
