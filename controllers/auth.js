
const prisma = require("../config/prisma");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { generateOTP, sendOTPEmail } = require("../utils/emailService");
const { addToBlacklist, isBlacklisted } = require("../utils/tokenDenylist");
const { ALLOWED_ORIGINS } = require("../config/allowedOrigins");

const SAML_PASSWORD = 'SAML_MANAGED_ACCOUNT_NO_PASSWORD';
const ALPA_EMAIL_DOMAIN = '@alpa.asn.au';
const SAML_ACCESS_PURPOSE = 'saml_access_verification';
const SAML_ACCESS_SESSION_TTL_SECONDS = 10 * 60;
const SAML_ACCESS_DENIED_MESSAGE = 'You are not authorized to access this dashboard.\nPlease contact your administrator.';

const ONE_HOUR_SECONDS = 60 * 60;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

const normalizeAlpaEmail = (email) => (typeof email === 'string' ? email.toLowerCase().trim() : '');

const isAlpaEmail = (email) => normalizeAlpaEmail(email).endsWith(ALPA_EMAIL_DOMAIN);

const getDashboardUrl = () => (process.env.DASHBOARD_URL || "https://alpa-dashboard.vercel.app").replace(/\/$/, '');

const createAdminSessionToken = (user) => jwt.sign(
  { userId: user.id, uid: user.id, email: user.email, role: user.role, jti: crypto.randomUUID() },
  process.env.JWT_SECRET,
  { expiresIn: "60m" }
);

const setAdminSessionCookie = (reply, token) => {
  reply.setCookie('session_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: ONE_HOUR_SECONDS,
    path: '/'
  });
};

const createSamlAccessSession = ({ samlSubject, samlNameIdFormat }) => jwt.sign(
  {
    purpose: SAML_ACCESS_PURPOSE,
    samlSubject,
    samlNameIdFormat: samlNameIdFormat || null,
    jti: crypto.randomUUID(),
  },
  process.env.JWT_SECRET,
  { expiresIn: SAML_ACCESS_SESSION_TTL_SECONDS }
);

const verifySamlAccessSession = (session) => {
  if (!session || typeof session !== 'string') return null;
  try {
    const decoded = jwt.verify(session, process.env.JWT_SECRET);
    if (decoded?.purpose !== SAML_ACCESS_PURPOSE || !decoded?.samlSubject) return null;
    return decoded;
  } catch {
    return null;
  }
};

const getSamlBoundApproval = async (samlSubject) => prisma.samlApproval.findFirst({
  where: {
    samlSubject,
    samlBindingCompleted: true,
  },
  include: { user: true },
});

const isApprovedSamlAdminUser = (user, approval) => {
  if (!user || !approval) return false;
  if (user.isDeleted) return false;
  if (user.password !== SAML_PASSWORD) return false;
  if (!['ADMIN', 'SUPER_ADMIN'].includes(user.role)) return false;
  if (approval.status !== 'APPROVED') return false;
  return true;
};

const sendAccessDenied = (reply, statusCode = 403) => reply.status(statusCode).send({
  success: false,
  message: SAML_ACCESS_DENIED_MESSAGE,
});

// HELPER FUNCTION: Generate device fingerprint
const generateDeviceFingerprint = (request) => {
  // Use only stable headers for device identification (exclude IP address)
  const userAgent = request.headers['user-agent'] || '';
  const acceptLanguage = request.headers['accept-language'] || '';
  const acceptEncoding = request.headers['accept-encoding'] || '';

  // Create fingerprint from stable sources only
  const fingerprintData = [
    userAgent,
    acceptLanguage,
    acceptEncoding
  ].join('|');

  const fingerprint = require('crypto')
    .createHash('sha256')
    .update(fingerprintData)
    .digest('hex');


  return fingerprint.substring(0, 32); // First 32 chars for storage
};

// SIGNUP - Send OTP for verification
exports.register = async (request, reply) => {
  try {
    
    const { name, email, password, mobile, role } = request.body;

    if (!name || !email || !password || !mobile || !role) {
      return reply.status(400).send({ success: false, message: "All fields are required" });
    }

    // Validate and normalize role
    const roleMap = {
      'customer': 'CUSTOMER',
      'seller': 'SELLER'
    };
    
    const normalizedRole = roleMap[role.toLowerCase()];
    
    if (!normalizedRole) {
      return reply.status(400).send({ 
        success: false, 
        message: "Invalid role. Must be 'customer' or 'seller'" 
      });
    }

    const normalizedEmail = email.toLowerCase();

    // Check if email already exists in users or pending registrations
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail }
    });

    if (existingUser) {
      return reply.status(400).send({ 
        success: false, 
        message: "Email already registered. Please login." 
      });
    }

    // Check for expired pending registration
    const pendingReg = await prisma.pendingRegistration.findUnique({
      where: { email: normalizedEmail }
    });

    if (pendingReg) {
      // If expired, delete it and allow new registration
      if (new Date() > pendingReg.otpExpiry) {
        await prisma.pendingRegistration.delete({
          where: { email: normalizedEmail }
        });
      } else {
        return reply.status(400).send({ 
          success: false, 
          message: "Registration pending. Please verify your email or request a new OTP." 
        });
      }
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Generate OTP
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

    // Store pending registration
    await prisma.pendingRegistration.create({
      data: {
        name,
        email: normalizedEmail,
        password: hashedPassword,
        mobile,
        role: normalizedRole,
        otp,
        otpExpiry,
      }
    });

    // Send OTP email
    const emailResult = await sendOTPEmail(email, otp, name);

    if (!emailResult.success) {
      console.error("❌ Email sending failed:", emailResult.error);
      return reply.status(500).send({ 
        success: false, 
        message: "Failed to send OTP email. Please try again.",
        details: emailResult.error 
      });
    }

    return reply.status(200).send({ 
      success: true, 
      message: "OTP sent to your email. Please verify to complete registration.",
      email: normalizedEmail
    });
  } catch (error) {
    console.error("❌ Register error:", error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// LOGIN
exports.login = async (request, reply) => {
  try {
    const { email, password } = request.body;
    
    if (!email || !password) {
      return reply.status(400).send({ success: false, message: "Email & password are required" });
    }
    
    const normalizedEmail = email.toLowerCase();
    
    // Find user
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    
    if (!user) {
      return reply.status(404).send({ success: false, message: "User not found or invalid credentials" });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    
    if (!isPasswordValid) {
      return reply.status(401).send({ success: false, message: "Invalid credentials" });
    }

    // Generate device fingerprint
    const deviceFingerprint = generateDeviceFingerprint(request);
    const now = new Date();

    // LANE SELECTION LOGIC
    const isInternalStaff = user.role === 'ADMIN' || user.role === 'SUPER_ADMIN'; // Internal staff bypass verification
    
    // Default Session Configuration (Lane 1: External)
    let sessionDuration = "7d";
    let cookieMaxAge = SEVEN_DAYS_SECONDS;
    
    // Override for Lane 2: Internal Staff
    if (isInternalStaff) {
       sessionDuration = "60m";
       cookieMaxAge = ONE_HOUR_SECONDS;
    }


    // Check if this device has a valid session (verified within last 7 days)
    const existingSession = await prisma.userSession.findUnique({
      where: {
        userId_deviceFingerprint: {
          userId: user.id,
          deviceFingerprint: deviceFingerprint
        }
      },
      select: {
        id: true,
        userId: true,
        deviceFingerprint: true,
        lastVerifiedAt: true,
        verificationExpiryAt: true,
        isActive: true,
        createdAt: true,
        updatedAt: true
      }
    });


    let needsVerification = false;
    let verificationReason = "";

    // Determine if verification is needed (Logic Split)
    if (isInternalStaff) {
        // Lane 2: Internal Staff
        // MFA handled by AuthPoint -> Verification skipped here
        needsVerification = false;
        verificationReason = "internal_auth_policy_bypass";
    } else {
        // Lane 1: External Users (Original Logic)
        if (!user.emailVerified) {
          // First login after signup - always require verification
          needsVerification = true;
          verificationReason = "first_login_after_signup";
        } else if (!existingSession) {
          // New device - require verification
          needsVerification = true;
          verificationReason = "new_device";
        } else if (now > existingSession.verificationExpiryAt) {
          // Session expired (7 days passed) - require verification again
          needsVerification = true;
          verificationReason = "session_expired";
        } else {
          // Session exists and is valid (within 7 days) - allow direct login
          // This includes re-login after logout, as long as within 7-day window
          needsVerification = false;
          verificationReason = "session_valid";
        }
    }

    // If verification is NOT needed, proceed with direct login
    if (!needsVerification) {

      const token = jwt.sign(
        { userId: user.id, uid: user.id, email: user.email, role: user.role, jti: crypto.randomUUID() },
        process.env.JWT_SECRET,
        { expiresIn: sessionDuration }
      );

      reply.setCookie('session_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: cookieMaxAge,
        path: '/'
      });

      const userResponse = {
        id: user.id,
        uid: user.id,
        name: user.name,
        email: user.email,
        mobile: user.phone,
        role: user.role,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
      };

      return reply.status(200).send({
        success: true,
        message: isInternalStaff 
          ? "Login successful (Internal Session: 60m)" 
          : "Login successful - device already verified",
        token,
        role: user.role,
        user: userResponse,
        deviceVerified: true,
        verificationReason: verificationReason,
        sessionType: isInternalStaff ? "internal_short" : "external_long_lived"
      });
    }

    // If we reach here, verification IS needed
    if (needsVerification) {
      // Generate OTP for email verification
      const otp = generateOTP();
      const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes


      // Delete ALL existing login verifications for this user (both verified and unverified)
      await prisma.loginVerification.deleteMany({
        where: {
          userId: user.id
        }
      });

      // Create new login verification record
      await prisma.loginVerification.create({
        data: {
          userId: user.id,
          email: normalizedEmail,
          otp: otp,
          otpExpiry: otpExpiry,
          deviceFingerprint: deviceFingerprint,
          verified: false
        }
      });

      // Send OTP email
      const emailResult = await sendOTPEmail(
        normalizedEmail,
        otp,
        user.name,
        "Email Verification Required"
      );

      if (!emailResult.success) {
        return reply.status(500).send({
          success: false,
          message: "Failed to send verification email. Please try again.",
          details: emailResult.error
        });
      }


      return reply.status(200).send({
        success: true,
        message: verificationReason === "first_login_after_signup" 
          ? "Welcome! Please verify your email to complete your first login." 
          : "Email verification required. Please check your email for the verification code.",
        requiresVerification: true,
        email: normalizedEmail,
        verificationReason: verificationReason
      });
    }
  } catch (error) {
    console.error("❌ Login error:", error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// VERIFY OTP - Complete registration after OTP verification
exports.verifyOTP = async (request, reply) => {
  try {
    const { email, otp } = request.body;

    if (!email || !otp) {
      return reply.status(400).send({ success: false, message: "Email and OTP are required" });
    }

    const normalizedEmail = email.toLowerCase();

    // Get pending registration
    const pendingData = await prisma.pendingRegistration.findUnique({
      where: { email: normalizedEmail }
    });

    if (!pendingData) {
      return reply.status(404).send({ 
        success: false, 
        message: "No pending registration found. Please register first." 
      });
    }

    // Check if OTP has expired
    if (new Date() > pendingData.otpExpiry) {
      await prisma.pendingRegistration.delete({
        where: { email: normalizedEmail }
      });
      return reply.status(400).send({ 
        success: false, 
        message: "OTP has expired. Please register again." 
      });
    }

    // Verify OTP
    if (pendingData.otp !== otp) {
      return reply.status(400).send({ 
        success: false, 
        message: "Invalid OTP. Please try again." 
      });
    }

    // OTP verified - Create user (emailVerified will be false, user will verify on first login)
    const user = await prisma.user.create({
      data: {
        name: pendingData.name,
        email: pendingData.email,
        password: pendingData.password,
        phone: pendingData.mobile,
        role: pendingData.role,
        emailVerified: false, // User needs to verify on first login
        isVerified: false,
      }
    });

    // Delete pending registration
    await prisma.pendingRegistration.delete({
      where: { email: normalizedEmail }
    });

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, uid: user.id, email: user.email, role: user.role, jti: crypto.randomUUID() },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    const userResponse = {
      id: user.id,
      uid: user.id,
      name: user.name,
      email: user.email,
      mobile: user.phone,
      role: user.role,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
    };


    return reply.status(201).send({ 
      success: true, 
      message: "Email verified successfully. Registration complete! You can now login.", 
      token,
      user: userResponse 
    });
  } catch (error) {
    console.error("❌ Verify OTP error:", error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// RESEND OTP
exports.resendOTP = async (request, reply) => {
  try {
    const { email } = request.body;

    if (!email) {
      return reply.status(400).send({ success: false, message: "Email is required" });
    }

    const normalizedEmail = email.toLowerCase();

    // Get pending registration
    const pendingData = await prisma.pendingRegistration.findUnique({
      where: { email: normalizedEmail }
    });

    if (!pendingData) {
      // If no pending registration, check if the user is already registered and needs a login OTP
      const existingUser = await prisma.user.findUnique({
        where: { email: normalizedEmail }
      });

      if (!existingUser) {
        return reply.status(404).send({ 
          success: false, 
          message: "No pending registration found. Please register first." 
        });
      }

      // Check for an existing unverified login verification to verify rate limits and get deviceFingerprint
      const recentLoginVerification = await prisma.loginVerification.findFirst({
        where: { userId: existingUser.id, verified: false },
        orderBy: { updatedAt: 'desc' }
      });

      if (recentLoginVerification) {
        const now = new Date();
        const timeSinceLastUpdate = now.getTime() - recentLoginVerification.updatedAt.getTime();
        const oneMinute = 60 * 1000;

        if (timeSinceLastUpdate < oneMinute) {
          const waitTime = Math.ceil((oneMinute - timeSinceLastUpdate) / 1000);
          return reply.status(429).send({ 
            success: false, 
            message: `Please wait ${waitTime} seconds before requesting a new OTP.`,
            waitTime: waitTime
          });
        }
      }

      const df = request.body.deviceFingerprint || (recentLoginVerification ? recentLoginVerification.deviceFingerprint : "unknown-device");

      // Generate new login OTP
      const otp = generateOTP();
      const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      // Clear existing to keep it clean, as per login flow
      await prisma.loginVerification.deleteMany({
        where: { userId: existingUser.id }
      });

      await prisma.loginVerification.create({
        data: {
          userId: existingUser.id,
          email: normalizedEmail,
          otp: otp,
          otpExpiry: otpExpiry,
          deviceFingerprint: df,
          verified: false
        }
      });

      const emailResult = await sendOTPEmail(normalizedEmail, otp, existingUser.username || existingUser.email);
      
      if (!emailResult.success) {
        return reply.status(500).send({ 
          success: false, 
          message: "Failed to send OTP email. Please try again." 
        });
      }

      return reply.send({
        success: true,
        message: "New OTP sent to your email.",
      });
    }

    // Rate limiting for Registration OTP: Check if OTP was updated recently (within 1 minute)
    const now = new Date();
    const timeSinceLastUpdate = now.getTime() - pendingData.updatedAt.getTime();
    const oneMinute = 60 * 1000;

    if (timeSinceLastUpdate < oneMinute) {
      const waitTime = Math.ceil((oneMinute - timeSinceLastUpdate) / 1000);
      return reply.status(429).send({ 
        success: false, 
        message: `Please wait ${waitTime} seconds before requesting a new OTP.`,
        waitTime: waitTime
      });
    }

    // Generate new OTP
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Update OTP
    await prisma.pendingRegistration.update({
      where: { email: normalizedEmail },
      data: {
        otp,
        otpExpiry,
      }
    });

    // Send new OTP email
    const emailResult = await sendOTPEmail(email, otp, pendingData.name);

    if (!emailResult.success) {
      return reply.status(500).send({ 
        success: false, 
        message: "Failed to send OTP email. Please try again." 
      });
    }


    return reply.status(200).send({ 
      success: true, 
      message: "New OTP sent to your email." 
    });
  } catch (error) {
    console.error("❌ Resend OTP error:", error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// FORGOT PASSWORD - Send OTP for password reset
exports.forgotPassword = async (request, reply) => {
  try {
    const { email } = request.body;

    if (!email) {
      return reply.status(400).send({ success: false, message: "Email is required" });
    }

    const normalizedEmail = email.toLowerCase();

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail }
    });

    if (!user) {
      return reply.status(404).send({ 
        success: false, 
        message: "No account found with this email address" 
      });
    }

    // Generate OTP for password reset
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store or update password reset request
    await prisma.pendingRegistration.upsert({
      where: { email: normalizedEmail },
      update: {
        otp,
        otpExpiry,
        role: 'PASSWORD_RESET'
      },
      create: {
        email: normalizedEmail,
        name: user.name,
        password: user.password, // Store existing password temporarily
        mobile: user.phone || '',
        role: 'PASSWORD_RESET',
        otp,
        otpExpiry
      }
    });

    // Send OTP email
    const emailResult = await sendOTPEmail(email, otp, user.name, 'Password Reset');

    if (!emailResult.success) {
      return reply.status(500).send({ 
        success: false, 
        message: "Failed to send reset email. Please try again." 
      });
    }

    return reply.status(200).send({ 
      success: true, 
      message: "Password reset OTP sent to your email." 
    });
  } catch (error) {
    console.error("❌ Forgot password error:", error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// RESET PASSWORD - Verify OTP and update password
exports.resetPassword = async (request, reply) => {
  try {
    const { email, otp, newPassword } = request.body;

    if (!email || !otp || !newPassword) {
      return reply.status(400).send({ 
        success: false, 
        message: "Email, OTP and new password are required" 
      });
    }

    if (newPassword.length < 6) {
      return reply.status(400).send({
        success: false,
        message: 'New password must be at least 6 characters long'
      });
    }

    const normalizedEmail = email.toLowerCase();

    // Get password reset request
    const resetData = await prisma.pendingRegistration.findUnique({
      where: { email: normalizedEmail }
    });

    if (!resetData || resetData.role !== 'PASSWORD_RESET') {
      return reply.status(404).send({ 
        success: false, 
        message: "No password reset request found. Please request a new reset." 
      });
    }

    // Check if OTP has expired
    if (new Date() > resetData.otpExpiry) {
      await prisma.pendingRegistration.delete({
        where: { email: normalizedEmail }
      });
      return reply.status(400).send({ 
        success: false, 
        message: "Reset OTP has expired. Please request a new reset." 
      });
    }

    // Verify OTP
    if (resetData.otp !== otp) {
      return reply.status(400).send({ 
        success: false, 
        message: "Invalid OTP. Please try again." 
      });
    }

    // Hash new password
    const hashedNewPassword = await bcrypt.hash(newPassword, 12);

    // Update user password
    await prisma.user.update({
      where: { email: normalizedEmail },
      data: { password: hashedNewPassword }
    });

    // Delete password reset request
    await prisma.pendingRegistration.delete({
      where: { email: normalizedEmail }
    });

    return reply.status(200).send({ 
      success: true, 
      message: "Password reset successfully. You can now login with your new password." 
    });
  } catch (error) {
    console.error("❌ Reset password error:", error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// LOGOUT - Clear session cookie and denylist the JWT so SSO tickets can no longer be created
exports.logout = async (request, reply) => {
  try {

    // --- Origin / CSRF validation (narrowly scoped to logout only) ---
    // Logout is the only route that is cookie-authenticated without an explicit
    // Authorization header being required, so it needs its own CSRF guard.
    //
    // Logic:
    //   Origin present  → must be in the approved allowlist, else 403.
    //   Origin absent + Bearer present → allow (non-browser / trusted client).
    //   Origin absent + no Bearer → reject (cookie-only request; indistinguishable
    //                               from a cross-site POST by an attacker).
    const originHeader = request.headers.origin;
    const hasBearerToken =
      typeof request.headers.authorization === 'string' &&
      request.headers.authorization.startsWith('Bearer ');

    if (originHeader !== undefined) {
      let normalizedOrigin;
      try {
        normalizedOrigin = new URL(originHeader).origin;
      } catch (_) {
        return reply.status(403).send({ success: false, error: 'Invalid Origin header' });
      }
      if (!ALLOWED_ORIGINS.includes(normalizedOrigin)) {
        return reply.status(403).send({ success: false, error: 'Origin not allowed' });
      }
    } else if (!hasBearerToken) {
      // No Origin and no Bearer token: the request cannot be distinguished from
      // a cross-site POST.  All active browser clients send an Origin, so this
      // branch only blocks attacker-controlled forms, not real clients.
      return reply.status(403).send({ success: false, error: 'Origin header required for cookie-authenticated requests' });
    }
    // --- End Origin / CSRF validation ---

    // Extract token from Authorization header OR session cookie
    const authHeader = request.headers.authorization;
    const rawToken =
      (authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.split(' ')[1]
        : null) ||
      (request.cookies && request.cookies.session_token) ||
      null;

    if (rawToken) {
      try {
        // Decode without re-verifying — we trust this token since the user is
        // calling logout themselves.  We only need the jti and exp claims.
        const decoded = jwt.decode(rawToken);
        if (decoded && decoded.jti && decoded.exp) {
          const remainingTtl = decoded.exp - Math.floor(Date.now() / 1000);
          if (remainingTtl > 0) {
            await addToBlacklist(decoded.jti, remainingTtl);
          }
        }
      } catch (decodeErr) {
        // Non-fatal: if we can't decode the token, just clear the cookie and continue
        console.warn("⚠️  Could not decode token on logout:", decodeErr.message);
      }
    }

    // NOTE: We don't deactivate the session because users should be able to login
    // again on the same device within 7 days without OTP verification.
    // The session cookie being cleared ensures the browser session is ended.

    // Clear the session cookie
    reply.clearCookie('session_token', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/'
    });


    return reply.status(200).send({ 
      success: true, 
      message: "Logout successful. You can login again on this device without OTP within 7 days." 
    });
  } catch (error) {
    console.error("❌ Logout error:", error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// VERIFY LOGIN OTP AND COMPLETE LOGIN
exports.verifyLoginOTP = async (request, reply) => {
  try {
    const { email, otp } = request.body;
    
    if (!email || !otp) {
      return reply.status(400).send({ 
        success: false, 
        message: "Email and OTP are required" 
      });
    }
    
    const normalizedEmail = email.toLowerCase();

    // Find the most recent unverified verification record for this email
    const verification = await prisma.loginVerification.findFirst({
      where: {
        email: normalizedEmail,
        verified: false
      },
      include: {
        user: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    if (!verification) {
      return reply.status(404).send({ 
        success: false, 
        message: "Verification session expired. Please login again to receive a new OTP." 
      });
    }

    // Check if OTP is expired
    if (new Date() > verification.otpExpiry) {
      // Delete expired verification
      await prisma.loginVerification.delete({
        where: { id: verification.id }
      });
      return reply.status(400).send({ 
        success: false, 
        message: "OTP has expired. Please login again to get a new OTP." 
      });
    }

    // Verify OTP
    if (verification.otp !== otp) {
      return reply.status(400).send({ 
        success: false, 
        message: "Invalid OTP. Please check and try again." 
      });
    }


    // If this was the user's first login after signup, mark email as verified
    if (!verification.user.emailVerified) {
      await prisma.user.update({
        where: { id: verification.user.id },
        data: { emailVerified: true }
      });
    }

    // Delete the verification record (clean up)
    await prisma.loginVerification.delete({
      where: { id: verification.id }
    });

    // Create/update user session for this device (7 days validity)
    const sessionExpiryDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    
    await prisma.userSession.upsert({
      where: {
        userId_deviceFingerprint: {
          userId: verification.user.id,
          deviceFingerprint: verification.deviceFingerprint
        }
      },
      update: {
        lastVerifiedAt: new Date(),
        verificationExpiryAt: sessionExpiryDate,
        isActive: true
      },
      create: {
        userId: verification.user.id,
        deviceFingerprint: verification.deviceFingerprint,
        lastVerifiedAt: new Date(),
        verificationExpiryAt: sessionExpiryDate,
        isActive: true
      }
    });

    // Generate JWT token
    const token = jwt.sign(
      { userId: verification.user.id, uid: verification.user.id, email: verification.user.email, role: verification.user.role, jti: crypto.randomUUID() },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // Set secure session cookie
    reply.setCookie('session_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SEVEN_DAYS_SECONDS, // 7 days
      path: '/'
    });


    // Get updated user data (in case emailVerified was updated)
    const updatedUser = await prisma.user.findUnique({
      where: { id: verification.user.id }
    });

    return reply.status(200).send({
      success: true,
      message: !verification.user.emailVerified 
        ? "Welcome! Your email has been verified and you're now logged in." 
        : "Email verified successfully! You are now logged in.",
      user: {
        id: updatedUser.id,
        uid: updatedUser.id,
        email: updatedUser.email,
        name: updatedUser.name,
        mobile: updatedUser.phone,
        role: updatedUser.role,
        emailVerified: updatedUser.emailVerified,
        createdAt: updatedUser.createdAt
      },
      token: token,
      role: updatedUser.role,
      deviceVerified: true,
      firstLoginCompleted: !verification.user.emailVerified // True if this was their first login
    });
  } catch (error) {
    console.error("❌ Verify login OTP error:", error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// RESEND LOGIN OTP
exports.resendLoginOTP = async (request, reply) => {
  try {
    const { email } = request.body;

    if (!email) {
      return reply.status(400).send({ success: false, message: "Email is required" });
    }

    const normalizedEmail = email.toLowerCase();

    // Find the user
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail }
    });

    if (!user) {
      return reply.status(404).send({ 
        success: false, 
        message: "User not found" 
      });
    }

    // Check for recent resend attempts (rate limiting)
    const recentRequest = await prisma.loginVerification.findFirst({
      where: {
        userId: user.id,
        verified: false,
        createdAt: {
          gte: new Date(Date.now() - 60 * 1000) // Within last 1 minute
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    if (recentRequest) {
      const secondsSinceLastRequest = Math.floor((Date.now() - recentRequest.createdAt.getTime()) / 1000);
      const waitTime = 60 - secondsSinceLastRequest;
      
      return reply.status(429).send({ 
        success: false, 
        message: `Please wait ${waitTime} seconds before requesting a new OTP.`,
        waitTime: waitTime
      });
    }

    // Generate device fingerprint
    const deviceFingerprint = generateDeviceFingerprint(request);

    // Generate new OTP
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Delete existing unverified verification records for this user
    await prisma.loginVerification.deleteMany({
      where: {
        userId: user.id,
        verified: false
      }
    });

    // Create new verification record
    await prisma.loginVerification.create({
      data: {
        userId: user.id,
        email: normalizedEmail,
        otp: otp,
        otpExpiry: otpExpiry,
        deviceFingerprint: deviceFingerprint,
        verified: false
      }
    });

    // Send OTP email
    const emailResult = await sendOTPEmail(
      normalizedEmail,
      otp,
      user.name,
      "Email Verification Required"
    );

    if (!emailResult.success) {
      return reply.status(500).send({
        success: false,
        message: "Failed to send verification email. Please try again."
      });
    }


    return reply.status(200).send({
      success: true,
      message: "New OTP sent to your email."
    });
  } catch (error) {
    console.error("❌ Resend login OTP error:", error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// SAML Callback Handler (Lane 2)
exports.samlCallback = async (request, reply) => {
  try {
    return exports.samlCallbackV2(request, reply);

    // Passport validates WatchGuard authentication and returns the SAML identity.
    const samlIdentity = request.user;
    const samlSubject = typeof samlIdentity?.samlSubject === 'string' ? samlIdentity.samlSubject.trim() : '';

    if (!user) {
      console.error("❌ No user returned from SAML strategy");
      const dashboardUrl = process.env.DASHBOARD_URL || "https://alpa-dashboard.vercel.app";
      return reply.redirect(`${dashboardUrl}/access-rejected`);
    }

    const dashboardUrl = (process.env.DASHBOARD_URL || "https://alpa-dashboard.vercel.app").replace(/\/$/, '');

    // SAML approval gate — only for SAML-managed users, SUPER_ADMIN always bypasses
    if (user.password === 'SAML_MANAGED_ACCOUNT_NO_PASSWORD' && user.role !== 'SUPER_ADMIN') {
      let samlApproval = null;
      try {
        samlApproval = await prisma.samlApproval.findUnique({ where: { userId: user.id } });

        if (!samlApproval) {
          console.log(`🔒 SAML user ${user.email} has no local approval record — redirecting`);
          return reply.redirect(`${dashboardUrl}/access-rejected`);
        }
      } catch {
        return reply.redirect(`${dashboardUrl}/access-rejected`);
      }

      if (samlApproval) switch (samlApproval.status) {
        case 'PENDING':
          console.log(`🔒 SAML user ${user.email} is pending approval — redirecting`);
          return reply.redirect(`${dashboardUrl}/access-pending`);
        case 'REJECTED':
          console.log(`🔒 SAML user ${user.email} is rejected — redirecting`);
          return reply.redirect(`${dashboardUrl}/access-rejected`);
        case 'BLOCKED':
          console.log(`🔒 SAML user ${user.email} is blocked — redirecting`);
          return reply.redirect(`${dashboardUrl}/access-blocked`);
        case 'APPROVED':
          break;
        default:
          return reply.redirect(`${dashboardUrl}/login?error=unknown_status`);
      }
    }

    // Lane 2: Internal Admin Session -> 60 Minutes (Strict Requirement)
    const sessionDuration = "60m";
    const cookieMaxAge = ONE_HOUR_SECONDS;

    const token = jwt.sign(
      { userId: user.id, uid: user.id, email: user.email, role: user.role, jti: crypto.randomUUID() },
      process.env.JWT_SECRET,
      { expiresIn: sessionDuration }
    );

    // Set Cookie
    reply.setCookie('session_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: cookieMaxAge,
      path: '/'
    });

    // Always redirect to the Admin Dashboard login-callback page
    return reply.redirect(`${dashboardUrl}/login-callback?token=${token}&type=saml`);

  } catch (error) {
    console.error("❌ SAML Callback Error:", error);
    const dashboardUrl = process.env.DASHBOARD_URL || "https://alpa-dashboard.vercel.app";
    return reply.redirect(`${dashboardUrl}/login?error=server_error`);
  }
};




/**
 * Creates a short-lived (60 s) single-use SSO ticket for an admin user.
 * The ticket ID is a UUID stored in sso_tickets; the JWT is never exposed in the URL.
 */
const createAdminSsoTicket = async (userId) => {
  // Remove expired tickets for this user before creating a new one
  await prisma.ssoTicket.deleteMany({
    where: { userId, expiresAt: { lt: new Date() } }
  });
  const expiresAt = new Date(Date.now() + 60 * 1000); // 60 seconds
  return prisma.ssoTicket.create({ data: { userId, expiresAt } });
};

exports.samlCallbackV2 = async (request, reply) => {
  try {
    const samlIdentity = request.user;
    const samlSubject = typeof samlIdentity?.samlSubject === 'string' ? samlIdentity.samlSubject.trim() : '';

    if (!samlSubject) {
      console.error("No SAML subject returned from SAML strategy");
      return reply.redirect(`${getDashboardUrl()}/access-rejected`);
    }

    const dashboardUrl = getDashboardUrl();
    const boundApproval = await getSamlBoundApproval(samlSubject);

    if (boundApproval && isApprovedSamlAdminUser(boundApproval.user, boundApproval)) {
      const ticket = await createAdminSsoTicket(boundApproval.user.id);
      return reply.redirect(`${dashboardUrl}/login-callback?ticket=${ticket.id}&type=saml`);
    }

    if (process.env.SAML_EMAIL_BINDING_REQUIRED === 'false') {
      return reply.redirect(`${dashboardUrl}/access-rejected`);
    }

    const session = createSamlAccessSession({
      samlSubject,
      samlNameIdFormat: samlIdentity.samlNameIdFormat || null,
    });

    return reply.redirect(`${dashboardUrl}/complete-access-verification?session=${encodeURIComponent(session)}`);
  } catch (error) {
    console.error("SAML Callback Error:", error);
    return reply.redirect(`${getDashboardUrl()}/login?error=server_error`);
  }
};

exports.submitSamlAccessEmail = async (request, reply) => {
  try {
    const { session, email } = request.body || {};
    const samlSession = verifySamlAccessSession(session);
    const normalizedEmail = normalizeAlpaEmail(email);

    if (!samlSession) {
      return reply.status(401).send({ success: false, message: "Verification session expired. Please sign in with SSO again." });
    }

    if (!normalizedEmail || !isAlpaEmail(normalizedEmail)) {
      return sendAccessDenied(reply);
    }

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { samlApproval: true },
    });

    if (!user || !isApprovedSamlAdminUser(user, user.samlApproval)) {
      return sendAccessDenied(reply);
    }

    const linkedApproval = await prisma.samlApproval.findFirst({
      where: {
        samlSubject: samlSession.samlSubject,
        userId: { not: user.id },
      },
      select: { id: true },
    });

    if (linkedApproval) {
      return sendAccessDenied(reply);
    }

    if (user.samlApproval.samlSubject && user.samlApproval.samlSubject !== samlSession.samlSubject) {
      return sendAccessDenied(reply);
    }

    const bindingResult = await prisma.$transaction(async (tx) => {
      const freshUser = await tx.user.findUnique({
        where: { id: user.id },
        include: { samlApproval: true },
      });

      if (!freshUser || !isApprovedSamlAdminUser(freshUser, freshUser.samlApproval)) {
        const error = new Error(SAML_ACCESS_DENIED_MESSAGE);
        error.statusCode = 403;
        throw error;
      }

      const freshApproval = freshUser.samlApproval;

      const boundElsewhere = await tx.samlApproval.findFirst({
        where: {
          samlSubject: samlSession.samlSubject,
          userId: { not: freshUser.id },
        },
        select: { id: true },
      });

      if (boundElsewhere) {
        const error = new Error(SAML_ACCESS_DENIED_MESSAGE);
        error.statusCode = 409;
        throw error;
      }

      if (freshApproval.samlBindingCompleted) {
        if (freshApproval.samlSubject !== samlSession.samlSubject) {
          const error = new Error(SAML_ACCESS_DENIED_MESSAGE);
          error.statusCode = 409;
          throw error;
        }

        return freshUser;
      }

      if (freshApproval.samlSubject && freshApproval.samlSubject !== samlSession.samlSubject) {
        const error = new Error(SAML_ACCESS_DENIED_MESSAGE);
        error.statusCode = 409;
        throw error;
      }

      const binding = await tx.samlApproval.updateMany({
        where: {
          userId: freshUser.id,
          status: 'APPROVED',
          samlBindingCompleted: false,
          samlSubject: null,
        },
        data: {
          samlSubject: samlSession.samlSubject,
          samlNameIdFormat: samlSession.samlNameIdFormat || freshApproval.samlNameIdFormat,
          samlEmailVerified: false,
          samlBindingCompleted: true,
          samlBoundAt: new Date(),
          samlPendingSubject: null,
          samlVerificationToken: null,
          samlVerificationExpiresAt: null,
        },
      });

      if (binding.count !== 1) {
        const error = new Error(SAML_ACCESS_DENIED_MESSAGE);
        error.statusCode = 409;
        throw error;
      }

      return freshUser;
    });

    const ticket = await createAdminSsoTicket(bindingResult.id);
    const redirectUrl = `${getDashboardUrl()}/login-callback?ticket=${ticket.id}&type=saml`;

    return reply.status(200).send({
      success: true,
      message: "Access verified successfully.",
      role: bindingResult.role,
      redirectUrl,
      user: {
        id: bindingResult.id,
        uid: bindingResult.id,
        name: bindingResult.name,
        email: bindingResult.email,
        mobile: bindingResult.phone,
        role: bindingResult.role,
        emailVerified: bindingResult.emailVerified,
        createdAt: bindingResult.createdAt,
      },
    });
  } catch (error) {
    console.error("SAML access email error:", error);
    if (error.statusCode === 403 || error.statusCode === 409 || error.code === 'P2002') {
      return reply.status(error.statusCode || 409).send({
        success: false,
        message: SAML_ACCESS_DENIED_MESSAGE,
      });
    }
    return reply.status(500).send({ success: false, message: "Failed to start access verification." });
  }
};

exports.verifySamlAccessOTP = async (request, reply) => {
  try {
    const { session, otp } = request.body || {};
    const samlSession = verifySamlAccessSession(session);
    const submittedOtp = String(otp || '').trim();

    if (!samlSession) {
      return reply.status(401).send({ success: false, message: "Verification session expired. Please sign in with SSO again." });
    }

    if (submittedOtp.length !== 6) {
      return reply.status(400).send({ success: false, message: "A valid 6-digit OTP is required." });
    }

    const approval = await prisma.samlApproval.findFirst({
      where: {
        samlPendingSubject: samlSession.samlSubject,
        samlVerificationToken: { not: null },
      },
      include: { user: true },
      orderBy: { updatedAt: 'desc' },
    });

    if (!approval || !isApprovedSamlAdminUser(approval.user, approval)) {
      return sendAccessDenied(reply);
    }

    if (!approval.samlVerificationExpiresAt || new Date() > approval.samlVerificationExpiresAt) {
      await prisma.samlApproval.update({
        where: { userId: approval.userId },
        data: {
          samlPendingSubject: null,
          samlVerificationToken: null,
          samlVerificationExpiresAt: null,
        },
      });
      return reply.status(400).send({ success: false, message: "OTP has expired. Please request a new code." });
    }

    const verification = await prisma.loginVerification.findFirst({
      where: {
        userId: approval.userId,
        email: approval.user.email,
        deviceFingerprint: `saml:${approval.samlVerificationToken}`,
        verified: false,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!verification) {
      return reply.status(404).send({ success: false, message: "Verification session expired. Please sign in with SSO again." });
    }

    if (new Date() > verification.otpExpiry) {
      await prisma.loginVerification.delete({ where: { id: verification.id } });
      return reply.status(400).send({ success: false, message: "OTP has expired. Please request a new code." });
    }

    if (verification.otp !== submittedOtp) {
      return reply.status(400).send({ success: false, message: "Invalid OTP. Please check and try again." });
    }

    const boundElsewhere = await prisma.samlApproval.findFirst({
      where: {
        samlSubject: samlSession.samlSubject,
        userId: { not: approval.userId },
      },
      select: { id: true },
    });

    if (boundElsewhere) {
      return sendAccessDenied(reply);
    }

    const updatedUser = await prisma.$transaction(async (tx) => {
      await tx.loginVerification.delete({ where: { id: verification.id } });

      await tx.samlApproval.update({
        where: { userId: approval.userId },
        data: {
          samlSubject: samlSession.samlSubject,
          samlNameIdFormat: samlSession.samlNameIdFormat || approval.samlNameIdFormat,
          samlEmailVerified: true,
          samlBindingCompleted: true,
          samlBoundAt: new Date(),
          samlPendingSubject: null,
          samlVerificationToken: null,
          samlVerificationExpiresAt: null,
        },
      });

      return tx.user.update({
        where: { id: approval.userId },
        data: { emailVerified: true, isVerified: true },
      });
    });

    const token = createAdminSessionToken(updatedUser);
    setAdminSessionCookie(reply, token);

    return reply.status(200).send({
      success: true,
      message: "Access verified successfully.",
      token,
      role: updatedUser.role,
      user: {
        id: updatedUser.id,
        uid: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email,
        mobile: updatedUser.phone,
        role: updatedUser.role,
        emailVerified: updatedUser.emailVerified,
        createdAt: updatedUser.createdAt,
      },
    });
  } catch (error) {
    console.error("SAML access OTP error:", error);
    return reply.status(500).send({ success: false, message: "Failed to verify access." });
  }
};



// const prisma = require("../config/prisma");
// const jwt = require("jsonwebtoken");
// const bcrypt = require("bcryptjs");
// const crypto = require("crypto");
// const { generateOTP, sendOTPEmail } = require("../utils/emailService");

// // HELPER FUNCTION: Generate device similarity fingerprint (for similarity detection only)
// const generateDeviceFingerprint = (request, clientFingerprint = null) => {
//   // Server-side fingerprinting (for similarity detection, not exact matching)
//   const userAgent = request.headers['user-agent'] || '';
//   const acceptLanguage = request.headers['accept-language'] || '';
//   const acceptEncoding = request.headers['accept-encoding'] || '';
  
//   // Extract OS and browser info from User-Agent for similarity comparison
//   const osInfo = extractOSInfo(userAgent);
//   const browserInfo = extractBrowserInfo(userAgent);
  
//   // Create server-side fingerprint components (general device characteristics)
//   const serverFingerprintData = [
//     browserInfo.name,
//     osInfo.name,
//     acceptLanguage.split(',')[0] || '', // Primary language only
//     acceptEncoding
//   ].filter(Boolean).join('|');

//   let finalFingerprintData = serverFingerprintData;
  
//   // If client provided additional fingerprint data, combine it
//   if (clientFingerprint) {
//     console.log("🔐 Using client-side fingerprint for similarity detection");
//     finalFingerprintData = `${serverFingerprintData}|CLIENT:${clientFingerprint}`;
//   }

//   const fingerprint = require('crypto')
//     .createHash('sha256')
//     .update(finalFingerprintData)
//     .digest('hex');

//   console.log("🔐 Device similarity fingerprint created:", {
//     os: osInfo.name,
//     browser: browserInfo.name,
//     hasClientData: !!clientFingerprint,
//     fingerprintPrefix: fingerprint.substring(0, 8)
//   });

//   return fingerprint.substring(0, 32); // First 32 chars for storage
// };

// // HELPER FUNCTION: Generate secure trusted device token
// const generateTrustedDeviceToken = () => {
//   const crypto = require('crypto');
//   return crypto.randomBytes(32).toString('hex'); // 64-char secure random token
// };

// // HELPER FUNCTION: Calculate fingerprint similarity score
// const calculateFingerprintSimilarity = (fp1, fp2) => {
//   if (!fp1 || !fp2) return 0;
//   if (fp1 === fp2) return 100;
  
//   // Calculate character-level similarity
//   let matches = 0;
//   const minLength = Math.min(fp1.length, fp2.length);
  
//   for (let i = 0; i < minLength; i++) {
//     if (fp1[i] === fp2[i]) matches++;
//   }
  
//   return Math.round((matches / Math.max(fp1.length, fp2.length)) * 100);
// };

// // Helper function to extract OS information
// const extractOSInfo = (userAgent) => {
//   const os = { name: 'Unknown', version: '' };
  
//   if (/Windows NT 10.0/.test(userAgent)) {
//     os.name = 'Windows';
//     os.version = '10';
//   } else if (/Windows NT 6.1/.test(userAgent)) {
//     os.name = 'Windows';
//     os.version = '7';
//   } else if (/Mac OS X/.test(userAgent)) {
//     os.name = 'macOS';
//     const match = userAgent.match(/Mac OS X ([0-9_]+)/);
//     if (match) os.version = match[1].replace(/_/g, '.');
//   } else if (/Linux/.test(userAgent)) {
//     os.name = 'Linux';
//   } else if (/Android/.test(userAgent)) {
//     os.name = 'Android';
//     const match = userAgent.match(/Android ([0-9.]+)/);
//     if (match) os.version = match[1];
//   } else if (/iPhone OS|iOS/.test(userAgent)) {
//     os.name = 'iOS';
//     const match = userAgent.match(/OS ([0-9_]+)/);
//     if (match) os.version = match[1].replace(/_/g, '.');
//   }
  
//   return os;
// };

// // Helper function to extract browser information
// const extractBrowserInfo = (userAgent) => {
//   const browser = { name: 'Unknown', majorVersion: '' };
  
//   if (/Chrome/.test(userAgent) && !/Edge|Edg/.test(userAgent)) {
//     browser.name = 'Chrome';
//     const match = userAgent.match(/Chrome\/([0-9]+)/);
//     if (match) browser.majorVersion = match[1];
//   } else if (/Firefox/.test(userAgent)) {
//     browser.name = 'Firefox';
//     const match = userAgent.match(/Firefox\/([0-9]+)/);
//     if (match) browser.majorVersion = match[1];
//   } else if (/Safari/.test(userAgent) && !/Chrome/.test(userAgent)) {
//     browser.name = 'Safari';
//     const match = userAgent.match(/Version\/([0-9]+)/);
//     if (match) browser.majorVersion = match[1];
//   } else if (/Edge|Edg/.test(userAgent)) {
//     browser.name = 'Edge';
//     const match = userAgent.match(/Edge?\/([0-9]+)/);
//     if (match) browser.majorVersion = match[1];
//   }
  
//   return browser;
// };

// // SIGNUP - Send OTP for verification
// exports.register = async (request, reply) => {
//   try {
//     console.log("📝 Register request received:", { email: request.body?.email });
    
//     const { name, email, password, mobile, role } = request.body;

//     if (!name || !email || !password || !mobile || !role) {
//       console.log("❌ Missing required fields");
//       return reply.status(400).send({ success: false, message: "All fields are required" });
//     }

//     // Validate and normalize role
//     const roleMap = {
//       'customer': 'CUSTOMER',
//       'seller': 'SELLER',
//       'admin': 'ADMIN'
//     };
    
//     const normalizedRole = roleMap[role.toLowerCase()];
    
//     if (!normalizedRole) {
//       return reply.status(400).send({ 
//         success: false, 
//         message: "Invalid role. Must be 'customer', 'seller', or 'admin'" 
//       });
//     }

//     const normalizedEmail = email.toLowerCase();

//     console.log("🔍 Checking if email exists...");
//     // Check if email already exists in users or pending registrations
//     const existingUser = await prisma.user.findUnique({
//       where: { email: normalizedEmail }
//     });

//     if (existingUser) {
//       console.log("❌ Email already registered");
//       return reply.status(400).send({ 
//         success: false, 
//         message: "Email already registered. Please login." 
//       });
//     }

//     // Check for expired pending registration
//     const pendingReg = await prisma.pendingRegistration.findUnique({
//       where: { email: normalizedEmail }
//     });

//     if (pendingReg) {
//       // If expired, delete it and allow new registration
//       if (new Date() > pendingReg.otpExpiry) {
//         console.log("♻️ Deleting expired pending registration");
//         await prisma.pendingRegistration.delete({
//           where: { email: normalizedEmail }
//         });
//       } else {
//         console.log("❌ Pending registration exists");
//         return reply.status(400).send({ 
//           success: false, 
//           message: "Registration pending. Please verify your email or request a new OTP." 
//         });
//       }
//     }

//     console.log("🔑 Generating OTP and hashing password...");
//     // Hash password
//     const hashedPassword = await bcrypt.hash(password, 10);
    
//     // Generate OTP
//     const otp = generateOTP();
//     const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

//     console.log("💾 Storing pending registration in database...");
//     // Store pending registration
//     await prisma.pendingRegistration.create({
//       data: {
//         name,
//         email: normalizedEmail,
//         password: hashedPassword,
//         mobile,
//         role: normalizedRole,
//         otp,
//         otpExpiry,
//       }
//     });

//     console.log("📧 Sending OTP email...");
//     // Send OTP email
//     const emailResult = await sendOTPEmail(email, otp, name);

//     if (!emailResult.success) {
//       console.error("❌ Email sending failed:", emailResult.error);
//       return reply.status(500).send({ 
//         success: false, 
//         message: "Failed to send OTP email. Please try again.",
//         details: emailResult.error 
//       });
//     }

//     console.log("✅ Registration successful, OTP sent");
//     return reply.status(200).send({ 
//       success: true, 
//       message: "OTP sent to your email. Please verify to complete registration.",
//       email: normalizedEmail
//     });
//   } catch (error) {
//     console.error("❌ Register error:", error);
//     return reply.status(500).send({ success: false, error: error.message });
//   }
// };

// // LOGIN
// ─────────────────────────────────────────────────────────────────────────────
// SSO TICKET ENDPOINTS  (Sellers & Customers only — Admin uses SAML / SSO)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /auth/create-ticket
 * Called by the Website after a successful Seller/Customer login.
 * Returns a short-lived (60 s) one-time ticketId that the frontend can
 * immediately pass to the Dashboard domain so it can exchange it for its
 * own session.
 */
// POST /auth/create-ticket
// Protected by authMiddleware (preHandler in route) — request.user is already verified.
exports.createTicket = async (request, reply) => {
  try {
    // request.user is set by the auth middleware from the Bearer token
    const { userId, role } = request.user;

    // Guard: only SELLER and CUSTOMER — Admin uses SAML
    if (!['SELLER', 'CUSTOMER'].includes(role)) {
      return reply.status(403).send({
        success: false,
        message: 'SSO tickets are only available for Sellers and Customers'
      });
    }

    // Confirm the user still exists in the DB
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return reply.status(404).send({ success: false, message: 'User not found' });
    }

    // Housekeeping: remove any already-expired tickets for this user
    await prisma.ssoTicket.deleteMany({
      where: { userId: user.id, expiresAt: { lt: new Date() } }
    });

    // Create a new 60-second one-time ticket
    const expiresAt = new Date(Date.now() + 60 * 1000);
    const ticket = await prisma.ssoTicket.create({
      data: { userId: user.id, expiresAt }
    });


    return reply.status(200).send({
      success: true,
      ticketId: ticket.id,
      expiresIn: 60,
      message: 'SSO ticket created. Use this ticket within 60 seconds.'
    });
  } catch (error) {
    console.error('❌ Create SSO ticket error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

/**
 * POST /auth/exchange-ticket
 * Called by the Dashboard domain (no existing session).
 * Consumes the ticket (deletes it immediately) and issues a fresh JWT +
 * sets a session cookie valid on the Dashboard domain.
 */
exports.exchangeTicket = async (request, reply) => {
  try {
    // Accept both `ticket` (sent by the Dashboard /login-callback page) and
    // `ticketId` (legacy / direct API callers) so neither breaks.
    const { ticket, ticketId } = request.body;
    const resolvedTicketId = ticket || ticketId;

    if (!resolvedTicketId) {
      return reply.status(400).send({ success: false, message: 'ticket is required' });
    }

    // Look up the ticket
    const ssoTicket = await prisma.ssoTicket.findUnique({ where: { id: resolvedTicketId } });

    if (!ssoTicket) {
      return reply.status(404).send({
        success: false,
        message: 'Invalid or already-used ticket'
      });
    }

    // Check expiry before doing anything else
    if (new Date() > ssoTicket.expiresAt) {
      await prisma.ssoTicket.delete({ where: { id: resolvedTicketId } });
      return reply.status(401).send({
        success: false,
        message: 'Ticket has expired. Please log in again.'
      });
    }

    // *** One-time use: delete the ticket immediately ***
    await prisma.ssoTicket.delete({ where: { id: resolvedTicketId } });

    // Fetch the full user record
    const user = await prisma.user.findUnique({ where: { id: ssoTicket.userId } });
    if (!user) {
      return reply.status(404).send({ success: false, message: 'User not found' });
    }

    // Determine session duration by role
    const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(user.role);
    const isSso = ['SELLER', 'CUSTOMER'].includes(user.role);

    if (!isAdmin && !isSso) {
      return reply.status(403).send({
        success: false,
        message: 'Ticket exchange not available for this account type'
      });
    }

    // Issue a fresh JWT with role-appropriate duration
    const token = isAdmin
      ? createAdminSessionToken(user)  // 60 minutes for admin
      : jwt.sign(
          { userId: user.id, uid: user.id, email: user.email, role: user.role, jti: crypto.randomUUID() },
          process.env.JWT_SECRET,
          { expiresIn: '7d' }
        );

    // For admin: set a short-lived httpOnly session cookie.
    // For seller/customer: token is returned in the response body only (Bearer-token architecture).
    if (isAdmin) {
      setAdminSessionCookie(reply, token);
    }

    const userResponse = {
      id: user.id,
      uid: user.id,
      name: user.name,
      email: user.email,
      mobile: user.phone,
      role: user.role,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt
    };

    // Response shape the Dashboard /login-callback page expects:
    // { token, role, user }
    return reply.status(200).send({
      success: true,
      message: 'SSO authentication successful',
      token,
      role: user.role,
      user: userResponse
    });
  } catch (error) {
    console.error('❌ Exchange SSO ticket error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// exports.login = async (request, reply) => {
//   try {
//     const { email, password, clientFingerprint, trustedDeviceToken } = request.body;
    
//     if (!email || !password) {
//       return reply.status(400).send({ success: false, message: "Email & password are required" });
//     }
    
//     const normalizedEmail = email.toLowerCase();
    
//     // Find user
//     const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    
//     if (!user) {
//       return reply.status(404).send({ success: false, message: "User not found or invalid credentials" });
//     }
    
//     // Verify password
//     const isPasswordValid = await bcrypt.compare(password, user.password);
    
//     if (!isPasswordValid) {
//       return reply.status(401).send({ success: false, message: "Invalid credentials" });
//     }

//     // Generate device similarity fingerprint
//     const deviceFingerprint = generateDeviceFingerprint(request, clientFingerprint);
//     const now = new Date();

//     console.log("🔍 Checking trusted device status for:", { 
//       email: normalizedEmail, 
//       deviceFingerprint,
//       userId: user.id,
//       hasClientFingerprint: !!clientFingerprint,
//       hasTrustedToken: !!trustedDeviceToken
//     });

//     // Check for trusted device token first (primary authority)
//     let existingTrustedDevice = null;
//     if (trustedDeviceToken) {
//       try {
//         existingTrustedDevice = await prisma.userSession.findFirst({
//           where: {
//             userId: user.id,
//             trustedDeviceToken: trustedDeviceToken,
//             isActive: true,
//             verificationExpiryAt: {
//               gt: now
//             }
//           },
//           select: {
//             id: true,
//             userId: true,
//             deviceFingerprint: true,
//             trustedDeviceToken: true,
//             lastVerifiedAt: true,
//             verificationExpiryAt: true,
//             isActive: true,
//             createdAt: true,
//             updatedAt: true
//           }
//         });
//       } catch (error) {
//         // If trustedDeviceToken field doesn't exist yet, fall back to fingerprint matching
//         console.log("⚠️ Trusted device token feature not yet available (database needs update), falling back to fingerprint matching");
        
//         // Try to find session by fingerprint as fallback
//         try {
//           existingTrustedDevice = await prisma.userSession.findFirst({
//             where: {
//               userId: user.id,
//               deviceFingerprint: deviceFingerprint,
//               isActive: true,
//               verificationExpiryAt: {
//                 gt: now
//               }
//             },
//             select: {
//               id: true,
//               userId: true,
//               deviceFingerprint: true,
//               lastVerifiedAt: true,
//               verificationExpiryAt: true,
//               isActive: true,
//               createdAt: true,
//               updatedAt: true
//             }
//           });
//         } catch (fallbackError) {
//           console.log("⚠️ Fallback fingerprint matching also failed, proceeding without trusted device");
//           existingTrustedDevice = null;
//         }
//       }
//     }

//     // If no trusted device found, check fingerprint similarity (secondary validation)
//     let similarDevice = null;
//     if (!existingTrustedDevice) {
//       try {
//         const userSessions = await prisma.userSession.findMany({
//           where: {
//             userId: user.id,
//             isActive: true,
//             verificationExpiryAt: {
//               gt: now
//             }
//           },
//           select: {
//             id: true,
//             userId: true,
//             deviceFingerprint: true,
//             lastVerifiedAt: true,
//             verificationExpiryAt: true,
//             isActive: true,
//             createdAt: true,
//             updatedAt: true
//           }
//         });

//         // Find most similar device
//         let bestSimilarity = 0;
//         for (const session of userSessions) {
//           const similarity = calculateFingerprintSimilarity(deviceFingerprint, session.deviceFingerprint);
//           if (similarity > bestSimilarity && similarity >= 50) { // Lowered to 50% similarity threshold for better device recognition
//             bestSimilarity = similarity;
//             similarDevice = session;
//           }
//         }

//         console.log("🔍 Device similarity analysis:", {
//           currentFingerprint: deviceFingerprint.substring(0, 8),
//           foundSimilarDevice: !!similarDevice,
//           bestSimilarity: bestSimilarity,
//           totalActiveSessions: userSessions.length,
//           sessionFingerprints: userSessions.map(s => s.deviceFingerprint.substring(0, 8))
//         });
//       } catch (error) {
//         console.log("⚠️ Device similarity check failed:", error.message);
//         similarDevice = null;
//       }
//     }

//     let needsVerification = false;
//     let verificationReason = "";
//     let trustLevel = "unknown";

//     // Determine if verification is needed based on trust levels AND 30-minute email verification rule (TESTING)
//     if (existingTrustedDevice) {
//       // Check if 10 minutes have passed since last email verification (TESTING - normally 7 days)
//       const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes for testing
//       const lastEmailVerification = existingTrustedDevice.lastVerifiedAt;
      
//       if (lastEmailVerification < tenMinutesAgo) {
//         // 10 minutes passed - require email verification even for trusted device
//         console.log("⏰ 10 minutes passed since last verification - email verification required (TESTING)");
//         needsVerification = true;
//         verificationReason = "seven_day_verification_cycle";
//         trustLevel = "trusted_device_expired";
//       } else {
//         // HIGH TRUST: Valid trusted device token within 10-minute cycle
//         console.log("✅ Trusted device token validated and within 10-minute cycle - direct login allowed (TESTING)");
//         needsVerification = false;
//         trustLevel = "trusted_device";
//       }
//     } else if (similarDevice) {
//       // Check 10-minute verification for similar device too
//       const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes for testing
//       const lastEmailVerification = similarDevice.lastVerifiedAt;
      
//       if (lastEmailVerification < tenMinutesAgo) {
//         // MEDIUM TRUST + 10-minute rule: Similar device but verification needed due to time
//         console.log("⏰ Similar device detected but 10 minutes passed - verification required (TESTING)");
//         needsVerification = true;
//         verificationReason = "similar_device_seven_day_cycle";
//         trustLevel = "similar_device_expired";
//       } else {
//         // MEDIUM TRUST: Similar device but no token, still require verification
//         console.log("⚠️ Similar device detected but no trusted token - verification required");
//         needsVerification = true;
//         verificationReason = "similar_device_no_token";
//         trustLevel = "similar_device";
//       }
//     } else if (!user.emailVerified) {
//       // LOW TRUST: First login after signup
//       console.log("🔐 First login after signup - email verification required");
//       needsVerification = true;
//       verificationReason = "first_login_after_signup";
//       trustLevel = "new_user";
//     } else {
//       // NO TRUST: Completely new device
//       console.log("🆕 New device detected - verification needed");
//       needsVerification = true;
//       verificationReason = "new_device";
//       trustLevel = "unknown_device";
//     }

//     console.log("📊 Trust evaluation result:", {
//       needsVerification,
//       verificationReason,
//       trustLevel
//     });

//     // If verification is NOT needed (trusted device), proceed with direct login
//     if (!needsVerification) {
//       console.log("✅ Trusted device verified - direct login");

//       // Update/refresh the trusted device session
//       const sessionExpiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

//       if (existingTrustedDevice) {
//         // Refresh existing trusted device session and reset 30-minute verification cycle (TESTING)
//         try {
//           await prisma.userSession.update({
//             where: { id: existingTrustedDevice.id },
//             data: {
//               lastVerifiedAt: now, // Reset 30-minute verification cycle (TESTING - normally 7 days)
//               verificationExpiryAt: sessionExpiryDate, // Extend device trust
//               deviceFingerprint: deviceFingerprint, // Update similarity fingerprint
//               trustedDeviceToken: existingTrustedDevice.trustedDeviceToken // Maintain existing token
//             }
//           });
//         } catch (error) {
//           console.log("⚠️ Could not update trusted device session (database may need update):", error.message);
//           // Continue with login even if session update fails
//         }
//       }

//       const token = jwt.sign(
//         { userId: user.id, uid: user.id, email: user.email, role: user.role },
//         process.env.JWT_SECRET,
//         { expiresIn: "7d" }
//       );

//       reply.setCookie('session_token', token, {
//         httpOnly: true,
//         secure: false,
//         sameSite: 'lax',
//         maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
//         path: '/'
//       });

//       const userResponse = {
//         id: user.id,
//         uid: user.id,
//         name: user.name,
//         email: user.email,
//         mobile: user.phone,
//         role: user.role,
//         emailVerified: user.emailVerified,
//         createdAt: user.createdAt,
//       };

//       return reply.status(200).send({
//         success: true,
//         message: "Login successful - trusted device verified",
//         token,
//         role: user.role,
//         user: userResponse,
//         deviceTrusted: true,
//         trustLevel: trustLevel,
//         trustedDeviceToken: existingTrustedDevice.trustedDeviceToken
//       });
//     }

//     // If we reach here, verification IS needed
//     if (needsVerification) {
//       // Check if there's already a recent verification request for this user
//       // BUT ONLY if it's for a DIFFERENT device fingerprint (don't block same device)
//       const now2 = new Date();
//       const recentVerification = await prisma.loginVerification.findFirst({
//         where: {
//           userId: user.id,
//           verified: false,
//           createdAt: {
//             gte: new Date(Date.now() - 2 * 60 * 1000) // Within last 2 minutes
//           }
//         },
//         orderBy: {
//           createdAt: 'desc'
//         }
//       });

//       if (recentVerification && recentVerification.deviceFingerprint !== deviceFingerprint) {
//         // Different device attempted to login recently - let them try
//         console.log("📱 Different device detected since last OTP. Deleting old verification and generating new one.");
//         await prisma.loginVerification.delete({
//           where: { id: recentVerification.id }
//         });
//       } else if (recentVerification && recentVerification.deviceFingerprint === deviceFingerprint) {
//         // SAME device - check if OTP is still valid before blocking
//         if (new Date() < recentVerification.otpExpiry) {
//           console.log("⏳ Recent OTP request exists for same device - reusing existing verification");
          
//           const messageMap = {
//             first_login_after_signup: "A verification code was already sent for your first login. Please check your email or wait 2 minutes to request a new code.",
//             new_device: "A verification code was already sent for this new device. Please check your email or wait 2 minutes to request a new code.",
//             similar_device_no_token: "A verification code was already sent for device verification. Please check your email or wait 2 minutes to request a new code.",
//             seven_day_verification_cycle: "A verification code was already sent for your 30-minute security check (TESTING). Please check your email or wait 2 minutes to request a new code.",
//             similar_device_seven_day_cycle: "A verification code was already sent for your 30-minute security check (TESTING). Please check your email or wait 2 minutes to request a new code.",
//             session_inactive: "A verification code was already sent. Please check your email or wait 2 minutes to request a new code.",
//             session_expired: "A verification code was already sent. Please check your email or wait 2 minutes to request a new code."
//           };
          
//           return reply.status(200).send({
//             success: true,
//             message: messageMap[verificationReason] || "A verification code was already sent to your email recently. Please check your email or wait 2 minutes to request a new code.",
//             requiresVerification: true,
//             email: normalizedEmail,
//             existingRequest: true,
//             verificationReason: verificationReason
//           });
//         } else {
//           // Existing OTP is expired, clean it up
//           await prisma.loginVerification.delete({
//             where: { id: recentVerification.id }
//           });
//         }
//       }

//       // Generate OTP for email verification
//       const otp = generateOTP();
//       const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

//       console.log(`🔑 Generating OTP for ${normalizedEmail}: ${otp}, Expires: ${otpExpiry}`);

//       // Delete ALL existing login verifications for this user (both verified and unverified)
//       await prisma.loginVerification.deleteMany({
//         where: {
//           userId: user.id
//         }
//       });

//       // Create new login verification record
//       const verificationRecord = await prisma.loginVerification.create({
//         data: {
//           userId: user.id,
//           email: normalizedEmail,
//           otp: otp,
//           otpExpiry: otpExpiry,
//           deviceFingerprint: deviceFingerprint,
//           verified: false
//         }
//       });

//       console.log(`✅ Created verification record: ID ${verificationRecord.id} for ${normalizedEmail} with OTP ${otp}`);

//       // Send OTP email
//       const emailResult = await sendOTPEmail(
//         normalizedEmail,
//         otp,
//         user.name,
//         "Email Verification Required"
//       );

//       if (!emailResult.success) {
//         return reply.status(500).send({
//           success: false,
//           message: "Failed to send verification email. Please try again.",
//           details: emailResult.error
//         });
//       }

//       console.log("✅ Verification OTP sent to email");

//       return reply.status(200).send({
//         success: true,
//         message: verificationReason === "first_login_after_signup" 
//           ? "Welcome! Please verify your email to complete your first login." 
//           : verificationReason === "seven_day_verification_cycle" || verificationReason === "similar_device_seven_day_cycle"
//           ? "Security check required. Please verify your email - this happens every 30 minutes for testing purposes."
//           : "Email verification required. Please check your email for the verification code.",
//         requiresVerification: true,
//         email: normalizedEmail,
//         verificationReason: verificationReason,
//         isSevenDayCheck: verificationReason.includes("seven_day")
//       });
//     }
//   } catch (error) {
//     console.error("❌ Login error:", error);
//     return reply.status(500).send({ success: false, error: error.message });
//   }
// };

// // VERIFY OTP - Complete registration after OTP verification
// exports.verifyOTP = async (request, reply) => {
//   try {
//     const { email, otp } = request.body;

//     if (!email || !otp) {
//       return reply.status(400).send({ success: false, message: "Email and OTP are required" });
//     }

//     const normalizedEmail = email.toLowerCase();

//     // Get pending registration
//     const pendingData = await prisma.pendingRegistration.findUnique({
//       where: { email: normalizedEmail }
//     });

//     if (!pendingData) {
//       return reply.status(404).send({ 
//         success: false, 
//         message: "No pending registration found. Please register first." 
//       });
//     }

//     // Check if OTP has expired
//     if (new Date() > pendingData.otpExpiry) {
//       await prisma.pendingRegistration.delete({
//         where: { email: normalizedEmail }
//       });
//       return reply.status(400).send({ 
//         success: false, 
//         message: "OTP has expired. Please register again." 
//       });
//     }

//     // Verify OTP
//     if (pendingData.otp !== otp) {
//       return reply.status(400).send({ 
//         success: false, 
//         message: "Invalid OTP. Please try again." 
//       });
//     }

//     // OTP verified - Create user (emailVerified will be false, user will verify on first login)
//     const user = await prisma.user.create({
//       data: {
//         name: pendingData.name,
//         email: pendingData.email,
//         password: pendingData.password,
//         phone: pendingData.mobile,
//         role: pendingData.role,
//         emailVerified: false, // User needs to verify on first login
//         isVerified: false,
//       }
//     });

//     // Delete pending registration
//     await prisma.pendingRegistration.delete({
//       where: { email: normalizedEmail }
//     });

//     // Generate JWT token
//     const token = jwt.sign(
//       { userId: user.id, uid: user.id, email: user.email, role: user.role },
//       process.env.JWT_SECRET,
//       { expiresIn: "7d" }
//     );

//     const userResponse = {
//       id: user.id,
//       uid: user.id,
//       name: user.name,
//       email: user.email,
//       mobile: user.phone,
//       role: user.role,
//       emailVerified: user.emailVerified,
//       createdAt: user.createdAt,
//     };

//     console.log(`✅ OTP verified for ${user.email}. User will need to verify on first login.`);

//     return reply.status(201).send({ 
//       success: true, 
//       message: "Email verified successfully. Registration complete! You can now login.", 
//       token,
//       user: userResponse 
//     });
//   } catch (error) {
//     console.error("❌ Verify OTP error:", error);
//     return reply.status(500).send({ success: false, error: error.message });
//   }
// };

// // RESEND OTP
// exports.resendOTP = async (request, reply) => {
//   try {
//     const { email } = request.body;

//     if (!email) {
//       return reply.status(400).send({ success: false, message: "Email is required" });
//     }

//     const normalizedEmail = email.toLowerCase();

//     // Get pending registration
//     const pendingData = await prisma.pendingRegistration.findUnique({
//       where: { email: normalizedEmail }
//     });

//     if (!pendingData) {
//       return reply.status(404).send({ 
//         success: false, 
//         message: "No pending registration found. Please register first." 
//       });
//     }

//     // Rate limiting: Check if OTP was updated recently (within 1 minute)
//     const now = new Date();
//     const timeSinceLastUpdate = now.getTime() - pendingData.updatedAt.getTime();
//     const oneMinute = 60 * 1000;

//     if (timeSinceLastUpdate < oneMinute) {
//       const waitTime = Math.ceil((oneMinute - timeSinceLastUpdate) / 1000);
//       return reply.status(429).send({ 
//         success: false, 
//         message: `Please wait ${waitTime} seconds before requesting a new OTP.`,
//         waitTime: waitTime
//       });
//     }

//     // Generate new OTP
//     const otp = generateOTP();
//     const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

//     // Update OTP
//     await prisma.pendingRegistration.update({
//       where: { email: normalizedEmail },
//       data: {
//         otp,
//         otpExpiry,
//       }
//     });

//     // Send new OTP email
//     const emailResult = await sendOTPEmail(email, otp, pendingData.name);

//     if (!emailResult.success) {
//       return reply.status(500).send({ 
//         success: false, 
//         message: "Failed to send OTP email. Please try again." 
//       });
//     }

//     console.log(`✅ Registration OTP resent to ${normalizedEmail}`);

//     return reply.status(200).send({ 
//       success: true, 
//       message: "New OTP sent to your email." 
//     });
//   } catch (error) {
//     console.error("❌ Resend OTP error:", error);
//     return reply.status(500).send({ success: false, error: error.message });
//   }
// };

// // FORGOT PASSWORD - Send OTP for password reset
// exports.forgotPassword = async (request, reply) => {
//   try {
//     const { email } = request.body;

//     if (!email) {
//       return reply.status(400).send({ success: false, message: "Email is required" });
//     }

//     const normalizedEmail = email.toLowerCase();

//     // Check if user exists
//     const user = await prisma.user.findUnique({
//       where: { email: normalizedEmail }
//     });

//     if (!user) {
//       return reply.status(404).send({ 
//         success: false, 
//         message: "No account found with this email address" 
//       });
//     }

//     // Generate OTP for password reset
//     const otp = generateOTP();
//     const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

//     // Store or update password reset request
//     await prisma.pendingRegistration.upsert({
//       where: { email: normalizedEmail },
//       update: {
//         otp,
//         otpExpiry,
//         role: 'PASSWORD_RESET'
//       },
//       create: {
//         email: normalizedEmail,
//         name: user.name,
//         password: user.password, // Store existing password temporarily
//         mobile: user.phone || '',
//         role: 'PASSWORD_RESET',
//         otp,
//         otpExpiry
//       }
//     });

//     // Send OTP email
//     const emailResult = await sendOTPEmail(email, otp, user.name, 'Password Reset');

//     if (!emailResult.success) {
//       return reply.status(500).send({ 
//         success: false, 
//         message: "Failed to send reset email. Please try again." 
//       });
//     }

//     return reply.status(200).send({ 
//       success: true, 
//       message: "Password reset OTP sent to your email." 
//     });
//   } catch (error) {
//     console.error("❌ Forgot password error:", error);
//     return reply.status(500).send({ success: false, error: error.message });
//   }
// };

// // RESET PASSWORD - Verify OTP and update password
// exports.resetPassword = async (request, reply) => {
//   try {
//     const { email, otp, newPassword } = request.body;

//     if (!email || !otp || !newPassword) {
//       return reply.status(400).send({ 
//         success: false, 
//         message: "Email, OTP and new password are required" 
//       });
//     }

//     if (newPassword.length < 6) {
//       return reply.status(400).send({
//         success: false,
//         message: 'New password must be at least 6 characters long'
//       });
//     }

//     const normalizedEmail = email.toLowerCase();

//     // Get password reset request
//     const resetData = await prisma.pendingRegistration.findUnique({
//       where: { email: normalizedEmail }
//     });

//     if (!resetData || resetData.role !== 'PASSWORD_RESET') {
//       return reply.status(404).send({ 
//         success: false, 
//         message: "No password reset request found. Please request a new reset." 
//       });
//     }

//     // Check if OTP has expired
//     if (new Date() > resetData.otpExpiry) {
//       await prisma.pendingRegistration.delete({
//         where: { email: normalizedEmail }
//       });
//       return reply.status(400).send({ 
//         success: false, 
//         message: "Reset OTP has expired. Please request a new reset." 
//       });
//     }

//     // Verify OTP
//     if (resetData.otp !== otp) {
//       return reply.status(400).send({ 
//         success: false, 
//         message: "Invalid OTP. Please try again." 
//       });
//     }

//     // Hash new password
//     const hashedNewPassword = await bcrypt.hash(newPassword, 12);

//     // Update user password
//     await prisma.user.update({
//       where: { email: normalizedEmail },
//       data: { password: hashedNewPassword }
//     });

//     // Delete password reset request
//     await prisma.pendingRegistration.delete({
//       where: { email: normalizedEmail }
//     });

//     return reply.status(200).send({ 
//       success: true, 
//       message: "Password reset successfully. You can now login with your new password." 
//     });
//   } catch (error) {
//     console.error("❌ Reset password error:", error);
//     return reply.status(500).send({ success: false, error: error.message });
//   }
// };

// // LOGOUT - Clear session cookie and invalidate device session
// exports.logout = async (request, reply) => {
//   try {
//     console.log("🚪 Logout request received");
    
//     // Try to get user info from token to invalidate their session
//     const token = request.cookies.session_token || request.headers.authorization?.replace('Bearer ', '');
//     const { clientFingerprint } = request.body || {};
    
//     if (token) {
//       try {
//         const decoded = jwt.verify(token, process.env.JWT_SECRET);
//         const userId = decoded.userId || decoded.uid;
        
//         if (userId) {
//           // Generate enhanced device fingerprint and get trusted token
//           const { clientFingerprint, revokeTrustedDevice } = request.body || {};
//           const deviceFingerprint = generateDeviceFingerprint(request, clientFingerprint);
          
//           // Find and deactivate the user session for this device
//           const session = await prisma.userSession.findUnique({
//             where: {
//               userId_deviceFingerprint: {
//                 userId: userId,
//                 deviceFingerprint: deviceFingerprint
//               }
//             }
//           });
          
//           if (session) {
//             if (revokeTrustedDevice) {
//               // Complete revocation - remove trusted device token
//               try {
//                 await prisma.userSession.update({
//                   where: { id: session.id },
//                   data: { 
//                     isActive: false,
//                     trustedDeviceToken: null, // Remove trust
//                     revokedAt: new Date()
//                   }
//                 });
//                 console.log(`✅ Trusted device revoked and session deactivated for user ${userId}`);
//               } catch (error) {
//                 // Fallback if fields don't exist
//                 await prisma.userSession.update({
//                   where: { id: session.id },
//                   data: { isActive: false }
//                 });
//                 console.log(`✅ Session deactivated for user ${userId} (trust revocation not available)`);
//               }
//             } else {
//               // Simple logout - keep device trust but deactivate session
//               await prisma.userSession.update({
//                 where: { id: session.id },
//                 data: { isActive: false }
//               });
//               console.log(`✅ Device session deactivated for user ${userId} (trust maintained)`);
//             }
//           }
//         }
//       } catch (err) {
//         console.log("⚠️ Could not decode token or invalidate session:", err.message);
//       }
//     }
    
//     // Clear the session cookie
//     reply.clearCookie('session_token', {
//       httpOnly: true,
//       secure: false,
//       sameSite: 'lax',
//       path: '/'
//     });

//     console.log("✅ Session cookie cleared");

//     return reply.status(200).send({ 
//       success: true, 
//       message: "Logout successful. You will need to verify your email on next login." 
//     });
//   } catch (error) {
//     console.error("❌ Logout error:", error);
//     return reply.status(500).send({ success: false, error: error.message });
//   }
// };


// // VERIFY LOGIN OTP - Complete login after email verification
// exports.verifyLoginOTP = async (request, reply) => {
//   try {
//     const { email, otp, clientFingerprint } = request.body;

//     if (!email || !otp) {
//       return reply.status(400).send({ 
//         success: false, 
//         message: "Email and OTP are required" 
//       });
//     }

//     const normalizedEmail = email.toLowerCase();

//     // Find user
//     const user = await prisma.user.findUnique({ 
//       where: { email: normalizedEmail } 
//     });

//     if (!user) {
//       return reply.status(404).send({ 
//         success: false, 
//         message: "User not found" 
//       });
//     }

//     // Get login verification record
//     const verificationRecord = await prisma.loginVerification.findFirst({
//       where: {
//         userId: user.id,
//         email: normalizedEmail,
//         verified: false
//       },
//       orderBy: {
//         createdAt: 'desc'
//       }
//     });

//     if (!verificationRecord) {
//       return reply.status(404).send({ 
//         success: false, 
//         message: "No verification request found. Please try logging in again." 
//       });
//     }

//     // Check if OTP has expired
//     if (new Date() > verificationRecord.otpExpiry) {
//       await prisma.loginVerification.delete({
//         where: { id: verificationRecord.id }
//       });
//       return reply.status(400).send({ 
//         success: false, 
//         message: "OTP has expired. Please try logging in again." 
//       });
//     }

//     // Verify OTP
//     if (verificationRecord.otp !== otp) {
//       return reply.status(400).send({ 
//         success: false, 
//         message: "Invalid OTP. Please try again." 
//       });
//     }

//     console.log(`✅ Login OTP verified for ${normalizedEmail}`);

//     // Generate device fingerprint
//     const deviceFingerprint = generateDeviceFingerprint(request, clientFingerprint);
    
//     // Generate unique trusted device token
//     const trustedDeviceToken = generateTrustedDeviceToken();
    
//     const now = new Date();
//     const sessionExpiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

//     // Mark user as email verified if this is their first login
//     if (!user.emailVerified) {
//       await prisma.user.update({
//         where: { id: user.id },
//         data: { emailVerified: true }
//       });
//       console.log(`✅ User ${normalizedEmail} email marked as verified`);
//     }

//     // Create or update user session for trusted device
//     try {
//       // Check if there's an existing session for this device
//       const existingSession = await prisma.userSession.findFirst({
//         where: {
//           userId: user.id,
//           deviceFingerprint: deviceFingerprint
//         },
//         select: {
//           id: true,
//           userId: true,
//           deviceFingerprint: true,
//           lastVerifiedAt: true,
//           verificationExpiryAt: true,
//           isActive: true,
//           createdAt: true,
//           updatedAt: true
//         }
//       });

//       if (existingSession) {
//         // Update existing session
//         await prisma.userSession.update({
//           where: { id: existingSession.id },
//           data: {
//             trustedDeviceToken: trustedDeviceToken,
//             isActive: true,
//             lastVerifiedAt: now,
//             verificationExpiryAt: sessionExpiryDate
//           },
//           select: {
//             id: true,
//             lastVerifiedAt: true,
//             verificationExpiryAt: true
//           }
//         });
//       } else {
//         // Create new session
//         await prisma.userSession.create({
//           data: {
//             userId: user.id,
//             deviceFingerprint: deviceFingerprint,
//             trustedDeviceToken: trustedDeviceToken,
//             isActive: true,
//             lastVerifiedAt: now,
//             verificationExpiryAt: sessionExpiryDate
//           },
//           select: {
//             id: true,
//             lastVerifiedAt: true,
//             verificationExpiryAt: true
//           }
//         });
//       }
//       console.log(`✅ Trusted device session created/updated for ${normalizedEmail}`);
//     } catch (error) {
//       console.log("⚠️ Could not create/update trusted device session:", error.message);
//       // Continue with login even if session creation fails
//     }

//     // Mark verification as complete
//     await prisma.loginVerification.update({
//       where: { id: verificationRecord.id },
//       data: { verified: true }
//     });

//     // Generate JWT token
//     const token = jwt.sign(
//       { userId: user.id, uid: user.id, email: user.email, role: user.role },
//       process.env.JWT_SECRET,
//       { expiresIn: "7d" }
//     );

//     // Set cookie
//     reply.setCookie('session_token', token, {
//       httpOnly: true,
//       secure: false,
//       sameSite: 'lax',
//       maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
//       path: '/'
//     });

//     const userResponse = {
//       id: user.id,
//       uid: user.id,
//       name: user.name,
//       email: user.email,
//       mobile: user.phone,
//       role: user.role,
//       emailVerified: true, // Now verified
//       createdAt: user.createdAt,
//     };

//     return reply.status(200).send({ 
//       success: true, 
//       message: "Login verified successfully", 
//       token,
//       role: user.role,
//       user: userResponse,
//       deviceTrusted: true,
//       trustedDeviceToken: trustedDeviceToken
//     });
//   } catch (error) {
//     console.error("❌ Verify Login OTP error:", error);
//     return reply.status(500).send({ 
//       success: false, 
//       message: "Verification failed",
//       error: error.message 
//     });
//   }
// };

// // RESEND LOGIN OTP
// exports.resendLoginOTP = async (request, reply) => {
//   try {
//     const { email } = request.body;

//     if (!email) {
//       return reply.status(400).send({ success: false, message: "Email is required" });
//     }

//     const normalizedEmail = email.toLowerCase();

//     // Find the user
//     const user = await prisma.user.findUnique({
//       where: { email: normalizedEmail }
//     });

//     if (!user) {
//       return reply.status(404).send({ 
//         success: false, 
//         message: "User not found" 
//       });
//     }

//     // Check for recent resend attempts (rate limiting)
//     const recentRequest = await prisma.loginVerification.findFirst({
//       where: {
//         userId: user.id,
//         verified: false,
//         createdAt: {
//           gte: new Date(Date.now() - 60 * 1000) // Within last 1 minute
//         }
//       },
//       orderBy: {
//         createdAt: 'desc'
//       }
//     });

//     if (recentRequest) {
//       const secondsSinceLastRequest = Math.floor((Date.now() - recentRequest.createdAt.getTime()) / 1000);
//       const waitTime = 60 - secondsSinceLastRequest;
      
//       return reply.status(429).send({ 
//         success: false, 
//         message: `Please wait ${waitTime} seconds before requesting a new OTP.`,
//         waitTime: waitTime
//       });
//     }

//     // Generate enhanced device fingerprint with optional client-side data
//     const { clientFingerprint } = request.body;
//     const deviceFingerprint = generateDeviceFingerprint(request, clientFingerprint);

//     // Generate new OTP
//     const otp = generateOTP();
//     const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

//     // Delete existing unverified verification records for this user
//     await prisma.loginVerification.deleteMany({
//       where: {
//         userId: user.id,
//         verified: false
//       }
//     });

//     // Create new verification record
//     await prisma.loginVerification.create({
//       data: {
//         userId: user.id,
//         email: normalizedEmail,
//         otp: otp,
//         otpExpiry: otpExpiry,
//         deviceFingerprint: deviceFingerprint,
//         verified: false
//       }
//     });

//     // Send OTP email
//     const emailResult = await sendOTPEmail(
//       normalizedEmail,
//       otp,
//       user.name,
//       "Email Verification Required"
//     );

//     if (!emailResult.success) {
//       return reply.status(500).send({
//         success: false,
//         message: "Failed to send verification email. Please try again."
//       });
//     }

//     console.log(`✅ New login OTP sent to ${normalizedEmail}`);

//     return reply.status(200).send({
//       success: true,
//       message: "New OTP sent to your email."
//     });
//   } catch (error) {
//     console.error("❌ Resend login OTP error:", error);
//     return reply.status(500).send({ success: false, error: error.message });
//   }
// };
