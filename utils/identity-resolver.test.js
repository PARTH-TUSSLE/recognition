const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveIdentity, extractDcoTrailers, maskEmail, isValidEmail } = require('./identity-resolver');

test('isValidEmail correctly enforces RFC-style structure', () => {
  // Rejections
  assert.equal(isValidEmail('foo'), false);
  assert.equal(isValidEmail('foo@'), false);
  assert.equal(isValidEmail('@example.com'), false);
  assert.equal(isValidEmail('foo@bar'), false); // Missing valid TLD
  assert.equal(isValidEmail('foo@.com'), false);
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail(null), false);
  assert.equal(isValidEmail('user @example.com'), false);

  // Acceptances
  assert.equal(isValidEmail('user@example.com'), true);
  assert.equal(isValidEmail('contributor.name+tag@sub.domain.co.uk'), true);
  assert.equal(isValidEmail('lee@layer5.io'), true);
});

test('maskEmail obfuscates email addresses correctly', () => {
  assert.equal(maskEmail('john.doe@example.com'), 'j***e@example.com');
  assert.equal(maskEmail('a@layer5.io'), 'a***@layer5.io');
  assert.equal(maskEmail('lee@layer5.io'), 'l***e@layer5.io');
  assert.equal(maskEmail(''), '');
  assert.equal(maskEmail(null), '');
});

test('extractDcoTrailers extracts and validates standard trailers', () => {
  const msg = `feat(core): add feature\n\nSigned-off-by: Lee Calcote <lee@layer5.io>\nSigned-off-by: Malformed <not-an-email>`;
  const trailers = extractDcoTrailers(msg);
  assert.equal(trailers.length, 1);
  assert.equal(trailers[0].name, 'Lee Calcote');
  assert.equal(trailers[0].email, 'lee@layer5.io');
});

test('resolveIdentity: normal author + matching sign-off', () => {
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

test('resolveIdentity: maintainer sign-off + contributor sign-off (multiple sign-offs)', () => {
  const commits = [
    {
      sha: 'squashed12345678',
      author: { login: 'contributor1' },
      commit: {
        author: { name: 'Contributor One', email: 'contrib@layer5.io' },
        message: 'feat: add component\n\nSigned-off-by: Contributor One <contrib@layer5.io>\nSigned-off-by: Lee Calcote <lee@layer5.io>'
      }
    }
  ];

  const result = resolveIdentity('contributor1', commits);
  assert.equal(result.dcoVerified, true);
  assert.equal(result.resolvedEmail, 'contrib@layer5.io');
});

test('resolveIdentity: mismatched sign-off name and email (fails closed)', () => {
  const commits = [
    {
      sha: 'mismatch12345678',
      author: { login: 'alice' },
      commit: {
        author: { name: 'Alice Smith', email: 'alice@example.com' },
        message: 'fix: bug\n\nSigned-off-by: Bob Jones <bob@other.com>'
      }
    }
  ];

  const result = resolveIdentity('alice', commits);
  assert.equal(result.dcoVerified, false);
  assert.equal(result.resolvedEmail, null);
  assert.ok(result.reason.includes('does not match git commit author'));
});

test('resolveIdentity: commit author mismatch (commit author != PR author)', () => {
  const commits = [
    {
      sha: 'authormismatch12',
      author: { login: 'mallory' },
      commit: {
        author: { name: 'Mallory', email: 'mallory@example.com' },
        message: 'feat: patch\n\nSigned-off-by: Mallory <mallory@example.com>'
      }
    }
  ];

  const result = resolveIdentity('alice', commits);
  assert.equal(result.dcoVerified, false);
  assert.equal(result.resolvedEmail, null);
  assert.ok(result.reason.includes("does not match PR author '@alice'"));
});

test('resolveIdentity: missing GitHub-associated author account (fails closed)', () => {
  const commits = [
    {
      sha: 'noauthor12345678',
      author: null,
      committer: { login: 'alice' },
      commit: {
        author: { name: 'Alice', email: 'alice@example.com' },
        message: 'feat: patch\n\nSigned-off-by: Alice <alice@example.com>'
      }
    }
  ];

  // Must not fall back to committer
  const result = resolveIdentity('alice', commits);
  assert.equal(result.dcoVerified, false);
  assert.equal(result.resolvedEmail, null);
  assert.ok(result.reason.includes('lacks a GitHub-associated author account'));
});

test('resolveIdentity: missing DCO in one of multiple commits (fails closed)', () => {
  const commits = [
    {
      sha: '1111111111111111',
      author: { login: 'contributor1' },
      commit: {
        author: { name: 'Contrib', email: 'contrib@test.com' },
        message: 'first commit\n\nSigned-off-by: Contrib <contrib@test.com>'
      }
    },
    {
      sha: '2222222222222222',
      author: { login: 'contributor1' },
      commit: {
        author: { name: 'Contrib', email: 'contrib@test.com' },
        message: 'second commit without DCO'
      }
    }
  ];

  const result = resolveIdentity('contributor1', commits);
  assert.equal(result.dcoVerified, false);
  assert.equal(result.resolvedEmail, null);
  assert.ok(result.reason.includes('missing a valid DCO Signed-off-by trailer'));
});

test('resolveIdentity: multiple commits with conflicting emails (fails closed)', () => {
  const commits = [
    {
      sha: '1111111111111111',
      author: { login: 'contributor1' },
      commit: {
        author: { name: 'Contrib', email: 'work@test.com' },
        message: 'first commit\n\nSigned-off-by: Contrib <work@test.com>'
      }
    },
    {
      sha: '2222222222222222',
      author: { login: 'contributor1' },
      commit: {
        author: { name: 'Contrib', email: 'personal@test.com' },
        message: 'second commit\n\nSigned-off-by: Contrib <personal@test.com>'
      }
    }
  ];

  const result = resolveIdentity('contributor1', commits);
  assert.equal(result.dcoVerified, false);
  assert.equal(result.resolvedEmail, null);
  assert.ok(result.reason.includes('conflicting Signed-off-by emails across commits'));
});

test('resolveIdentity: squashed commit with multiple sign-offs', () => {
  const commits = [
    {
      sha: 'squashed99999999',
      author: { login: 'dev' },
      commit: {
        author: { name: 'Dev User', email: 'dev@company.com' },
        message: 'Squash commit (#42)\n\n* commit 1\n* commit 2\n\nSigned-off-by: Dev User <dev@company.com>\nSigned-off-by: Reviewer <reviewer@company.com>'
      }
    }
  ];

  const result = resolveIdentity('dev', commits);
  assert.equal(result.dcoVerified, true);
  assert.equal(result.resolvedEmail, 'dev@company.com');
});
