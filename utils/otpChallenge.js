const MAX_OTP_FAILED_ATTEMPTS = 5;

const verifyAndConsumeOtp = async (model, challenge, submittedOtp, now = new Date()) => {
  if (challenge.otpExpiry <= now) return { status: 'expired' };
  if (challenge.otpConsumedAt || challenge.otpFailedAttempts >= MAX_OTP_FAILED_ATTEMPTS) {
    return { status: 'exhausted' };
  }

  if (challenge.otp !== submittedOtp) {
    const updated = await model.updateMany({
      where: {
        id: challenge.id,
        otp: challenge.otp,
        otpExpiry: { gt: now },
        otpConsumedAt: null,
        otpFailedAttempts: { lt: MAX_OTP_FAILED_ATTEMPTS },
      },
      data: { otpFailedAttempts: { increment: 1 } },
    });

    return {
      status: 'invalid',
      exhausted: updated.count === 1 && challenge.otpFailedAttempts + 1 >= MAX_OTP_FAILED_ATTEMPTS,
    };
  }

  const consumed = await model.updateMany({
    where: {
      id: challenge.id,
      otp: challenge.otp,
      otpExpiry: { gt: now },
      otpConsumedAt: null,
      otpFailedAttempts: { lt: MAX_OTP_FAILED_ATTEMPTS },
    },
    data: { otpConsumedAt: now },
  });

  return { status: consumed.count === 1 ? 'verified' : 'exhausted' };
};

const resetOtpChallenge = (otp, otpExpiry) => ({
  otp,
  otpExpiry,
  otpFailedAttempts: 0,
  otpConsumedAt: null,
});

module.exports = { MAX_OTP_FAILED_ATTEMPTS, verifyAndConsumeOtp, resetOtpChallenge };
