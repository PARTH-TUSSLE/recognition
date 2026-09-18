const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { orchestrateAwards, parseArgs } = require('./award-orchestrator');

test('parseArgs parses flags and key-values', () => {
  const args = ['--metadata=foo.json', '--repo', 'layer5io/sistent', '--dry-run'];
  const parsed = parseArgs(args);
  assert.equal(parsed.metadata, 'foo.json');
  assert.equal(parsed.repo, 'layer5io/sistent');
  assert.equal(parsed['dry-run'], 'true');
});

test('orchestrateAwards produces pending award on qualifying fresh PR', () => {
  const prMetadata = {
    repository: 'layer5io/sistent',
    prAuthor: 'contributor1',
    changedFiles: ['src/components/Button/index.tsx'],
    labels: ['enhancement'],
    commits: [
      {
        author: { login: 'contributor1' },
        commit: {
          message: 'feat: add button component\n\nSigned-off-by: Contributor One <contrib@layer5.io>'
        }
      }
    ]
  };

  const result = orchestrateAwards({ prMetadata });

  assert.equal(result.dcoVerified, true);
  assert.equal(result.recipientEmail, 'contrib@layer5.io');
  assert.equal(result.allEligibleBadges.length, 1);
  assert.equal(result.allEligibleBadges[0].slug, 'sistent-contributor');
  assert.equal(result.pendingAwards.length, 1);
  assert.equal(result.pendingAwards[0].slug, 'sistent-contributor');
  assert.equal(result.pendingAwards[0].trackingLabel, 'badge-awarded:sistent-contributor');
  assert.equal(result.pendingAwards[0].slackCommand, '/award-badge contrib@layer5.io sistent-contributor');
  assert.equal(result.alreadyAwardedBadges.length, 0);
  assert.ok(result.summaryMarkdown.includes('Pending Dispatch'));
});

test('orchestrateAwards filters out already awarded badges (Idempotency)', () => {
  const prMetadata = {
    repository: 'layer5io/sistent',
    prAuthor: 'contributor1',
    changedFiles: ['src/components/Button/index.tsx'],
    labels: ['enhancement'],
    commits: [
      {
        author: { login: 'contributor1' },
        commit: {
          message: 'feat: add button\n\nSigned-off-by: Contributor One <contrib@layer5.io>'
        }
      }
    ]
  };

  const existingLabels = ['enhancement', 'badge-awarded:sistent-contributor'];
  const result = orchestrateAwards({ prMetadata, existingLabels });

  assert.equal(result.allEligibleBadges.length, 1);
  assert.equal(result.alreadyAwardedBadges.length, 1);
  assert.equal(result.alreadyAwardedBadges[0].slug, 'sistent-contributor');
  assert.equal(result.pendingAwards.length, 0, 'Must have zero pending awards when already labeled');
  assert.ok(result.summaryMarkdown.includes('Already Awarded'));
  assert.ok(result.summaryMarkdown.includes('Zero duplicate dispatches needed'));
});

test('orchestrateAwards blocks awards when DCO is unverified', () => {
  const prMetadata = {
    repository: 'meshery/meshery',
    prAuthor: 'author2',
    changedFiles: ['server/main.go'],
    labels: [],
    commits: [
      {
        author: { login: 'author2' },
        commit: {
          message: 'fix: update server initialization without dco'
        }
      }
    ]
  };

  const result = orchestrateAwards({ prMetadata });

  assert.equal(result.dcoVerified, false);
  assert.equal(result.allEligibleBadges.length, 1);
  assert.equal(result.pendingAwards.length, 0, 'Cannot award badge without verified DCO');
  assert.ok(result.summaryMarkdown.includes('DCO Blocked'));
});

test('orchestrateAwards CLI file integration works via temp files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'award-test-'));
  const metaFile = path.join(tmpDir, 'pr-meta.json');
  const labelsFile = path.join(tmpDir, 'labels.json');
  const outFile = path.join(tmpDir, 'out.json');

  const prMetadata = {
    repository: 'meshery/meshsync',
    prAuthor: 'dev3',
    changedFiles: ['internal/sync.go'],
    commits: [
      {
        author: { login: 'dev3' },
        commit: {
          message: 'feat: sync\n\nSigned-off-by: Dev Three <dev3@layer5.io>'
        }
      }
    ]
  };

  fs.writeFileSync(metaFile, JSON.stringify(prMetadata), 'utf-8');
  fs.writeFileSync(labelsFile, JSON.stringify(['area/sync']), 'utf-8');

  // Programmatic CLI run
  const { execFileSync } = require('child_process');
  const scriptPath = path.resolve(__dirname, 'award-orchestrator.js');
  execFileSync(process.execPath, [
    scriptPath,
    `--metadata=${metaFile}`,
    `--existing-labels=${labelsFile}`,
    `--out=${outFile}`
  ]);

  assert.ok(fs.existsSync(outFile));
  const output = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
  assert.equal(output.pendingAwards.length, 1);
  assert.equal(output.pendingAwards[0].slug, 'meshsync');

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
