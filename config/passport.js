const fastifyPassport = require("@fastify/passport");
const { Strategy: SamlStrategy } = require("@node-saml/passport-saml");
const fs = require("fs");
const path = require("path");
const prisma = require("./prisma");

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
        
        const email = profile.email || profile.nameID;
        
        if (!email) {
          return done(new Error("No email returned from SAML Provider"), null);
        }

        // Find user by email
        let user = await prisma.user.findUnique({
          where: { email: email.toLowerCase() }
        });

        // Ensure user is internal/admin? 
        // Logic: If user doesn't exist, should we create them? 
        // For now, let's assume valid employees should be in the system 
        // OR we map them to an account.
        
        if (!user) {
           console.log(`⚠️ User not found for SAML email: ${email}. Creating provisioned account.`);
           // Optional: Auto-provision user
           user = await prisma.user.create({
             data: {
               email: email.toLowerCase(),
               name: profile.givenName ? `${profile.givenName} ${profile.sn || ''}` : email.split('@')[0],
               role: 'ADMIN', // Default to ADMIN/STAFF for Internal Lane
               password: 'SAML_MANAGED_ACCOUNT_NO_PASSWORD',
               isVerified: true,
               emailVerified: true
             }
           });
        }

        return done(null, user);
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
