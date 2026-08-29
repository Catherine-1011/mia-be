const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../controllers/auth'), 'utf8');

test('SAML access-email creates pending state and does not bind or issue a ticket', () => {
  const accessEmail = source.slice(source.indexOf('exports.submitSamlAccessEmail'), source.indexOf('exports.verifySamlAccessOTP'));
  assert.match(accessEmail, /samlPendingSubject:\s*samlSession\.samlSubject/);
  assert.match(accessEmail, /samlVerificationToken:\s*verificationToken/);
  assert.doesNotMatch(accessEmail, /samlBindingCompleted:\s*true/);
  assert.doesNotMatch(accessEmail, /createAdminSsoTicket\(/);
});

test('SAML OTP verification re-checks pending identity before binding and issuing ticket', () => {
  const otp = source.slice(source.indexOf('exports.verifySamlAccessOTP'));
  assert.match(otp, /samlPendingSubject:\s*samlSession\.samlSubject/);
  assert.match(otp, /samlVerificationToken:\s*approval\.samlVerificationToken/);
  assert.match(otp, /samlBindingCompleted:\s*false/);
  assert.match(otp, /createAdminSsoTicket\(updatedUser\.id\)/);
});

