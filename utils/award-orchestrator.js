const fs = require('fs');
const path = require('path');
const { evaluateBadges, normalizeLabels, normalizeFiles } = require('./badge-evaluator');
const { resolveIdentity, maskEmail } = require('./identity-resolver');

/**
 * Parses command line arguments formatted as --key=value or --key value
 * @param {string[]} args
 * @returns {Record<string, string>}
 */
function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const equalsIdx = arg.indexOf('=');
      if (equalsIdx !== -1) {
        const key = arg.slice(2, equalsIdx);
        const value = arg.slice(equalsIdx + 1);
        parsed[key] = value;
      } else {
        const key = arg.slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          parsed[key] = next;
          i++;
        } else {
          parsed[key] = 'true';
        }
      }
    }
  }
  return parsed;
}

/**
 * Builds GitHub Actions step summary markdown
 */
function buildSummaryMarkdown({
  repo,
  prAuthor,
  resolvedEmail,
  maskedEmail,
  dcoVerified,
  dcoReason,
  allEligibleBadges,
  alreadyAwardedBadges,
  pendingAwards
}) {
  const lines = [];
  lines.push(`## 🎖️ Contributor Badge Evaluation Summary`);
  lines.push('');
  lines.push(`- **Target Repository**: \`${repo}\``);
  lines.push(`- **PR Author**: \`@${prAuthor || 'unknown'}\``);

  if (resolvedEmail) {
    lines.push(`- **Recipient Identity**: \`${maskedEmail}\` (${dcoVerified ? '✅ DCO Verified' : '⚠️ DCO Unverified'})`);
  } else {
    lines.push(`- **Recipient Identity**: ⚠️ Unresolved email`);
  }
  lines.push(`- **Attribution Note**: ${dcoReason}`);
  lines.push('');

  if (allEligibleBadges.length === 0) {
    lines.push(`> [!NOTE]`);
    lines.push(`> No qualifying badge criteria matched for this pull request.`);
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`| Badge | Slug | Status | Tracking Label | Qualification Reason |`);
  lines.push(`| :--- | :--- | :--- | :--- | :--- |`);

  for (const badge of allEligibleBadges) {
    const isAlreadyAwarded = alreadyAwardedBadges.some(b => b.slug === badge.slug);
    const trackingLabel = `\`badge-awarded:${badge.slug}\``;

    let status = '🚀 **Pending Dispatch**';
    if (isAlreadyAwarded) {
      status = '✅ **Already Awarded**';
    } else if (!dcoVerified) {
      status = '⚠️ **DCO Blocked**';
    }

    lines.push(`| **${badge.name}** | \`${badge.slug}\` | ${status} | ${trackingLabel} | ${badge.reason} |`);
  }

  lines.push('');

  if (pendingAwards.length > 0) {
    lines.push(`### Planned Dispatches (${pendingAwards.length})`);
    lines.push('');
    for (const award of pendingAwards) {
      lines.push(`- **${award.name}** (\`${award.slug}\`) $\\rightarrow$ Tracking Label: \`${award.trackingLabel}\``);
    }
    lines.push('');
  } else if (alreadyAwardedBadges.length > 0 && allEligibleBadges.length === alreadyAwardedBadges.length) {
    lines.push(`> [!NOTE]`);
    lines.push(`> All eligible badges for this PR have already been awarded and labeled. Zero duplicate dispatches needed.`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Orchestrates badge evaluation and award filtering.
 *
 * @param {Object} options
 * @param {Object} options.prMetadata PR metadata object or file content
 * @param {Array<string|{name: string}>} [options.existingLabels] Existing labels on PR
 * @param {string} [options.repoOverride] Explicit repository override
 * @returns {Object} Structured evaluation result
 */
function orchestrateAwards({ prMetadata = {}, existingLabels = [], repoOverride = '' }) {
  // Extract repository
  const repo = (
    repoOverride ||
    prMetadata.repository ||
    prMetadata.repo ||
    (prMetadata.pr && prMetadata.pr.base && prMetadata.pr.base.repo && prMetadata.pr.base.repo.full_name) ||
    ''
  ).trim();

  // Extract author
  const prAuthor = (
    prMetadata.prAuthor ||
    (prMetadata.pr && prMetadata.pr.user && prMetadata.pr.user.login) ||
    ''
  ).trim();

  // Extract labels on PR
  const rawPrLabels = prMetadata.labels || (prMetadata.pr && prMetadata.pr.labels) || [];
  const normalizedPrLabels = normalizeLabels(rawPrLabels);

  // Extract files
  const rawFiles = prMetadata.changedFiles || prMetadata.files || [];
  const normalizedFiles = normalizeFiles(rawFiles);

  // Extract commits
  const commits = prMetadata.commits || [];

  // Evaluate badge eligibility
  const { eligibleBadges } = evaluateBadges({
    repository: repo,
    labels: normalizedPrLabels,
    changedFiles: normalizedFiles
  });

  // Resolve identity and DCO
  const identity = resolveIdentity(prAuthor, commits);
  const maskedRecipientEmail = maskEmail(identity.resolvedEmail);

  // Extract existing tracking labels
  const allExistingLabels = normalizeLabels(existingLabels.length > 0 ? existingLabels : rawPrLabels);
  const existingTrackingPrefix = 'badge-awarded:';
  const alreadyAwardedSlugs = new Set(
    allExistingLabels
      .filter(lbl => lbl.startsWith(existingTrackingPrefix))
      .map(lbl => lbl.slice(existingTrackingPrefix.length))
  );

  const alreadyAwardedBadges = eligibleBadges.filter(b => alreadyAwardedSlugs.has(b.slug));
  const unawardedBadges = eligibleBadges.filter(b => !alreadyAwardedSlugs.has(b.slug));

  // Only dispatch if DCO is verified and email was resolved
  const pendingAwards = [];
  if (identity.dcoVerified && identity.resolvedEmail) {
    for (const badge of unawardedBadges) {
      pendingAwards.push({
        slug: badge.slug,
        name: badge.name,
        ruleId: badge.ruleId,
        reason: badge.reason,
        trackingLabel: `badge-awarded:${badge.slug}`,
        slackCommand: `/award-badge ${identity.resolvedEmail} ${badge.slug}`
      });
    }
  }

  const summaryMarkdown = buildSummaryMarkdown({
    repo,
    prAuthor,
    resolvedEmail: identity.resolvedEmail,
    maskedEmail: maskedRecipientEmail,
    dcoVerified: identity.dcoVerified,
    dcoReason: identity.reason,
    allEligibleBadges: eligibleBadges,
    alreadyAwardedBadges,
    pendingAwards
  });

  return {
    repo,
    prAuthor,
    recipientEmail: identity.resolvedEmail,
    maskedEmail: maskedRecipientEmail,
    dcoVerified: identity.dcoVerified,
    dcoReason: identity.reason,
    allEligibleBadges: eligibleBadges,
    alreadyAwardedBadges,
    unawardedBadges,
    pendingAwards,
    summaryMarkdown
  };
}

/**
 * CLI execution entrypoint
 */
function runCli() {
  const args = parseArgs(process.argv.slice(2));

  let prMetadata = {};
  if (args.metadata) {
    const raw = fs.readFileSync(path.resolve(args.metadata), 'utf-8');
    prMetadata = JSON.parse(raw);
  }

  let existingLabels = [];
  if (args['existing-labels']) {
    const raw = fs.readFileSync(path.resolve(args['existing-labels']), 'utf-8');
    existingLabels = JSON.parse(raw);
  }

  const repoOverride = args.repo || '';
  const result = orchestrateAwards({ prMetadata, existingLabels, repoOverride });

  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), JSON.stringify(result, null, 2), 'utf-8');
  } else {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  orchestrateAwards,
  parseArgs,
  buildSummaryMarkdown
};
