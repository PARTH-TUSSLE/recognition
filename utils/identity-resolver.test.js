const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveIdentity, extractDcoTrailers, maskEmail } = require('./identity-resolver');

test('maskEmail obfuscates email addresses correctly', () => {
  assert.equal(maskEmail('john.doe@example.com'), 'j***e@example.com');
  assert.equal(maskEmail('a@layer5.io'), 'a***@layer5.io');
  assert.equal(maskEmail('lee@layer5.io'), 'l***e@layer5.io');
  assert.equal(maskEmail(''), '');
  assert.equal(maskEmail(null), '');
});

test('extractDcoTrailers extracts standard trailers', () => {
  const msg = `feat(core): add feature\n\nSigned-off-by: Lee Calcote <lee@layer5.io>`;
  const trailers = extractDcoTrailers(msg);
  assert.equal(trailers.length, 1);
  assert.equal(trailers[0].name, 'Lee Calcote');
  assert.equal(trailers[0].email, 'lee@layer5.io');
});

test('resolveIdentity succeeds on verified single commit', () => {
  const commits = [
    {
      sha: 'abcdef1234567890',
      author: { login: 'leecalcote' },
      commit: {
        author: { name: 'Lee Calcote', email: 'lee@layer5.io' },
        message: 'fix: update configuration\n\nSigned-off-by: Lee Calcote <lee@layer5.io>'
      }
    }
  ];

  const result = resolveIdentity('leecalcote', commits);
  assert.equal(result.dcoVerified, true);
  assert.equal(result.resolvedEmail, 'lee@layer5.io');
});

test('resolveIdentity succeeds with case-insensitive login comparison', () => {
  const commits = [
    {
      sha: 'abcdef1234567890',
      author: { login: 'LeeCalcote' },
      commit: {
        author: { name: 'Lee Calcote', email: 'lee@layer5.io' },
        message: 'docs: update readme\n\nSigned-off-by: Lee Calcote <lee@layer5.io>'
      }
    }
  ];

  const result = resolveIdentity('leecalcote', commits);
  assert.equal(result.dcoVerified, true);
  assert.equal(result.resolvedEmail, 'lee@layer5.io');
});

test('resolveIdentity fails DCO if Signed-off-by is absent in any author commit', () => {
  const commits = [
    {
      sha: '1111111111111111',
      author: { login: 'contributor1' },
      commit: {
        message: 'first commit\n\nSigned-off-by: Contributor <contrib@test.com>'
      }
    },
    {
      sha: '2222222222222222',
      author: { login: 'contributor1' },
      commit: {
        message: 'second commit without DCO'
      }
    }
  ];

  const result = resolveIdentity('contributor1', commits);
  assert.equal(result.dcoVerified, false);
  assert.ok(result.reason.includes('DCO Signed-off-by trailer missing'));
});

test('resolveIdentity fails if no commits belong to the PR author', () => {
  const commits = [
    {
      sha: '3333333333333333',
      author: { login: 'someoneelse' },
      commit: {
        message: 'commit\n\nSigned-off-by: Someone <someone@test.com>'
      }
    }
  ];

  const result = resolveIdentity('actualAuthor', commits);
  assert.equal(result.dcoVerified, false);
  assert.equal(result.resolvedEmail, null);
  assert.ok(result.reason.includes("No commits in PR matched GitHub login 'actualAuthor'"));
});

test('resolveIdentity gracefully handles empty inputs', () => {
  assert.equal(resolveIdentity('', []).dcoVerified, false);
  assert.equal(resolveIdentity('user', []).dcoVerified, false);
});
