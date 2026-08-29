const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { verifyAndConsumeOtp, resetOtpChallenge } = require('../utils/otpChallenge');
const { generateOTP } = require('../utils/emailService');

const makeChallengeModel = (challenge) => ({
  challenge,
  async updateMany({ where, data }) {
    const current = this.challenge;
    const matches = current.id === where.id
      && current.otp === where.otp
      && current.otpExpiry > where.otpExpiry.gt
      && current.otpConsumedAt === null
      && current.otpFailedAttempts < where.otpFailedAttempts.lt;

    if (!matches) return { count: 0 };
    if (data.otpFailedAttempts) current.otpFailedAttempts += data.otpFailedAttempts.increment;
    if (data.otpConsumedAt) current.otpConsumedAt = data.otpConsumedAt;
    return { count: 1 };
  },
});

const newChallenge = (overrides = {}) => ({
  id: 'challenge-1',
  otp: '123456',
  otpExpiry: new Date('2030-01-01T00:10:00.000Z'),
  otpFailedAttempts: 0,
  otpConsumedAt: null,
  ...overrides,
});

test('active OTP generator uses crypto.randomInt and preserves six numeric digits', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'utils', 'emailService.js'), 'utf8');
  const generator = source.slice(source.indexOf('const generateOTP'), source.indexOf('// Send OTP email'));
  assert.match(generator, /randomInt\(100000, 1000000\)/);
  assert.doesNotMatch(generator, /Math\.random/);

  for (let index = 0; index < 100; index += 1) {
    const otp = generateOTP();
    assert.match(otp, /^\d{6}$/);
    assert.ok(Number(otp) >= 100000 && Number(otp) <= 999999);
  }
});

test('four wrong OTPs increment persistent state and leave the challenge usable', async () => {
  const model = makeChallengeModel(newChallenge());
  const now = new Date('2030-01-01T00:00:00.000Z');
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.equal((await verifyAndConsumeOtp(model, model.challenge, '000000', now)).status, 'invalid');
    assert.equal(model.challenge.otpFailedAttempts, attempt);
    assert.equal(model.challenge.otpConsumedAt, null);
  }
  assert.equal((await verifyAndConsumeOtp(model, model.challenge, '123456', now)).status, 'verified');
});

test('fifth wrong OTP exhausts the challenge and a later correct OTP fails', async () => {
  const model = makeChallengeModel(newChallenge());
  const now = new Date('2030-01-01T00:00:00.000Z');
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = await verifyAndConsumeOtp(model, model.challenge, '000000', now);
    assert.equal(result.status, 'invalid');
  }
  assert.equal(model.challenge.otpFailedAttempts, 5);
  assert.equal((await verifyAndConsumeOtp(model, model.challenge, '123456', now)).status, 'exhausted');
});

test('reissue resets attempt and consumption state and invalidates the old OTP', async () => {
  const model = makeChallengeModel(newChallenge({ otpFailedAttempts: 5 }));
  Object.assign(model.challenge, resetOtpChallenge('654321', new Date('2030-01-01T00:20:00.000Z')));
  const now = new Date('2030-01-01T00:00:00.000Z');
  assert.equal(model.challenge.otpFailedAttempts, 0);
  assert.equal(model.challenge.otpConsumedAt, null);
  assert.equal((await verifyAndConsumeOtp(model, model.challenge, '123456', now)).status, 'invalid');
  assert.equal((await verifyAndConsumeOtp(model, model.challenge, '654321', now)).status, 'verified');
});

test('successful challenge is single use, including concurrent correct submissions', async () => {
  const model = makeChallengeModel(newChallenge());
  const now = new Date('2030-01-01T00:00:00.000Z');
  const results = await Promise.all([
    verifyAndConsumeOtp(model, model.challenge, '123456', now),
    verifyAndConsumeOtp(model, model.challenge, '123456', now),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), ['exhausted', 'verified']);
  assert.ok(model.challenge.otpConsumedAt instanceof Date);
  assert.equal((await verifyAndConsumeOtp(model, model.challenge, '123456', now)).status, 'exhausted');
});

test('expired OTP is rejected without consuming or incrementing it', async () => {
  const challenge = newChallenge({ otpExpiry: new Date('2029-12-31T23:59:59.000Z') });
  const model = makeChallengeModel(challenge);
  assert.equal((await verifyAndConsumeOtp(model, challenge, '123456', new Date('2030-01-01T00:00:00.000Z'))).status, 'expired');
  assert.equal(challenge.otpFailedAttempts, 0);
  assert.equal(challenge.otpConsumedAt, null);
});

test('all externally reachable OTP verification flows use the shared atomic verifier', () => {
  const auth = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'auth.js'), 'utf8');
  const seller = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'sellerOnboarding.js'), 'utf8');
  for (const handler of ['verifyOTP', 'resetPassword', 'verifyLoginOTP', 'verifySamlAccessOTP']) {
    const start = auth.indexOf(`exports.${handler}`);
    const end = auth.indexOf('\nexports.', start + 1);
    assert.match(auth.slice(start, end < 0 ? undefined : end), /verifyAndConsumeOtp/);
  }
  for (const handler of ['verifyOTP', 'resumeVerifyOtp', 'resetPassword', 'verifyAndSubmit']) {
    const start = seller.indexOf(`exports.${handler}`);
    const end = seller.indexOf('\nexports.', start + 1);
    assert.match(seller.slice(start, end < 0 ? undefined : end), /verifyAndConsumeOtp/);
  }
});
