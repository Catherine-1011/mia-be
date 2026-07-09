const fastifyPassport = require("@fastify/passport");
const { Strategy: SamlStrategy } = require("@node-saml/passport-saml");
const fs = require("fs");
const path = require("path");
const prisma = require("./prisma");

// TEMPORARY DEBUG HELPER — remove once the SAML email root cause is confirmed.
// Masks values so we can see shape/format without dumping full PII to logs.
function maskSamlValue(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}${'*'.repeat(value.length - 4)}${value.slice(-2)}`;
}

function extractSamlDebugInfo(profile) {
  if (!profile || typeof profile !== 'object') return null;

  const attributes = profile.attributes && typeof profile.attributes === 'object' ? profile.attributes : {};
  const maskAttrValue = (v) => (Array.isArray(v) ? v.map(maskSamlValue) : maskSamlValue(v));

  return {
    nameID: maskSamlValue(profile.nameID),
    nameIDFormat: profile.nameIDFormat || null,
    email: maskSamlValue(profile.email),
    mail: maskSamlValue(profile.mail),
    emailAddress: maskSamlValue(profile.emailAddress),
    upn: maskSamlValue(profile.upn),
    userPrincipalName: maskSamlValue(profile.userPrincipalName),
    profileKeys: Object.keys(profile),
    attributesKeys: Object.keys(attributes),
    attributes: Object.fromEntries(
      Object.entries(attributes).map(([key, value]) => [key, maskAttrValue(value)])
    ),
    looksLikeEmail: {
      nameID: typeof profile.nameID === 'string' && profile.nameID.includes('@'),
      email: typeof profile.email === 'string' && profile.email.includes('@'),
    },
  };
}

module.exports = function (app) {
  // Load Certificate and Metadata if available
  let decryptionPvk = null;
  let idpCert = null;
  let entryPoint = process.env.SAML_ENTRY_POINT; // e.g. https://authpoint.watchguard.com/...

  // 1. Try env var first (production/Render — no filesystem dependency)
  if (process.env.SAML_IDP_CERT) {
    // Env vars can't store real newlines easily — allow \n literal to be used
    idpCert = process.env.SAML_IDP_CERT.replace(/\\n/g, '\n');
    console.log("✅ SAML Cert loaded from SAML_IDP_CERT env var. Length:", idpCert.length);
  }

  // 2. Fall back to file (local dev)
  if (!idpCert) {
    try {
      const certPath = path.join(__dirname, "certs", "authpoint.cer");
      console.log("🔍 Looking for SAML Cert at:", certPath);
      if (fs.existsSync(certPath)) {
        idpCert = fs.readFileSync(certPath, "utf-8");
        console.log("✅ SAML Cert loaded from file. Length:", idpCert.length);
      } else {
        console.error("❌ SAML Cert not found at path:", certPath);
      }
    } catch (e) {
      console.warn("⚠️ SAML Cert file not readable:", e.message);
    }
  }

  if (!idpCert) {
      console.error("🛑 CRITICAL: IDP Certificate is missing (no SAML_IDP_CERT env var and no cert file). SAML Strategy cannot be initialized.");
      return; 
  }

  // Define SAML Strategy
  const samlStrategy = new SamlStrategy(
    {
      callbackUrl: process.env.SAML_CALLBACK_URL || "https://alpa-be.onrender.com/api/auth/saml/login",
      entryPoint: entryPoint || "PLACEHOLDER_ENTRY_POINT_FROM_METADATA_XML",
      issuer: process.env.SAML_ISSUER || process.env.BACKEND_URL || "https://alpa-be.onrender.com", // EntityID
      idpCert: idpCert, // IDP Public Key
      // decryptionPvk: decryptionPvk, // If encryption is enabled
      identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      acceptedClockSkewMs: 300000, // 5 minutes tolerance (3-5 min requested)
      disableRequestedAuthnContext: true,
      forceAuthn: true
    },
    async (profile, done) => {
      try {
        console.log("🔐 SAML Profile Received:", profile);

        // TEMPORARY DEBUG LOGGING — gated behind SAML_DEBUG_PROFILE=true.
        // Purpose: confirm whether AuthPoint sends a real email anywhere in the
        // assertion (mail/emailAddress/upn/userPrincipalName/attributes) or only
        // a username-shaped NameID. Values are masked; remove after diagnosis.
        if (process.env.SAML_DEBUG_PROFILE === 'true') {
          console.log('🧪 [SAML_DEBUG_PROFILE] masked profile info:', JSON.stringify(extractSamlDebugInfo(profile), null, 2));
        }

        const samlSubject = typeof profile.nameID === 'string' ? profile.nameID.trim() : '';

        if (!samlSubject) {
          return done(new Error("No SAML NameID returned from SAML Provider"), null);
        }

        return done(null, {
          samlSubject,
          samlNameIdFormat: profile.nameIDFormat || null,
          samlProfileEmail: typeof profile.email === 'string' ? profile.email.toLowerCase().trim() : null,
          samlAuthenticatedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error("❌ SAML Auth Error:", err);
        return done(err, null);
      }
    }
  );

  fastifyPassport.use("saml", samlStrategy);

  // Serialization (required for session)
  fastifyPassport.registerUserSerializer(async (user, req) => user.id);
  fastifyPassport.registerUserDeserializer(async (id, req) => {
    return await prisma.user.findUnique({ where: { id } });
  });
};
