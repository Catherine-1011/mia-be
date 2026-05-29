
/**
 * Check if email exists across all collections (users, sellers, pending_registrations)
 * Returns object with exists flag and where it was found
 */
const checkEmailExists = async (email) => {
  const normalizedEmail = email.toLowerCase().trim();
  
  try {
    // Check Firebase Auth
    let firebaseUser = null;
    try {
      firebaseUser = await admin.auth().getUserByEmail(normalizedEmail);
    } catch (error) {
      // Email not in Firebase Auth
    }

    // Check users collection
    const usersSnapshot = await db.collection("users")
      .where("email", "==", normalizedEmail)
      .limit(1)
      .get();

    if (!usersSnapshot.empty) {
      return {
        exists: true,
        location: "users",
        message: "A user account with this email already exists. Please login or use a different email."
      };
    }

    // Check sellers collection
    const sellersSnapshot = await db.collection("sellers")
      .where("email", "==", normalizedEmail)
      .limit(1)
      .get();

    if (!sellersSnapshot.empty) {
      const sellerData = sellersSnapshot.docs[0].data();
      // Allow re-registration only if email not verified
      if (sellerData.emailVerified) {
        return {
          exists: true,
          location: "sellers",
          message: "A seller account with this email already exists. Please login or use a different email.",
          sellerId: sellersSnapshot.docs[0].id,
          verified: true
        };
      } else {
        return {
          exists: true,
          location: "sellers",
          message: "Pending seller registration exists",
          sellerId: sellersSnapshot.docs[0].id,
          verified: false,
          allowContinue: true
        };
      }
    }

    // Check pending registrations
    const pendingDoc = await db.collection("pending_registrations").doc(normalizedEmail).get();
    
    if (pendingDoc.exists) {
      const pendingData = pendingDoc.data();
      const otpExpiry = pendingData.otpExpiry?.toDate ? pendingData.otpExpiry.toDate() : new Date(pendingData.otpExpiry);
      
      if (otpExpiry > new Date()) {
        return {
          exists: true,
          location: "pending_registrations",
          message: "Registration pending. Please verify your OTP or wait for it to expire.",
          allowResend: true
        };
      }
      // OTP expired, can proceed with new registration
    }

    // Check Firebase Auth
    if (firebaseUser) {
      return {
        exists: true,
        location: "firebase_auth",
        message: "An account with this email already exists. Please login or use a different email."
      };
    }

    return {
      exists: false,
      message: "Email is available"
    };

  } catch (error) {
    console.error("Email validation error:", error);
    throw new Error("Failed to validate email");
  }
};

module.exports = { checkEmailExists };

