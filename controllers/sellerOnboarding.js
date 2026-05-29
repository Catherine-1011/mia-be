const prisma = require("../config/prisma");
const { generateOTP, sendOTPEmail, sendSellerApplicationSubmittedEmail, sendSellerRegistrationEmail, sendSuperAdminNewSellerEmail } = require("../utils/emailService");
const { abnLookup } = require("../utils/abnLookup");
const { uploadToCloudinary } = require("../config/cloudinary");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { getDefaultCommission, getCommissionForSeller } = require("./commission");
const { notifyAdminNewSellerApplication, notifyBankChangeRequested } = require("./notification");

// Helper function to generate seller JWT token
const generateSellerToken = (userId) => {
  return jwt.sign({ userId, userType: "seller", role: "SELLER" }, process.env.JWT_SECRET, {
    expiresIn: "30d"
  });
};

// Helper function to determine which step data is missing
const getOnboardingStepDetails = (sellerProfile) => {
  const steps = [
    {
      step: 1,
      name: "Email Verification",
      completed: true, // If we have sellerProfile, step 1 is done
      description: "Email verified and account created"
    },
    {
      step: 2,
      name: "Password Setup", 
      completed: true, // If we have sellerProfile, step 2 is done
      description: "Password set and basic profile created"
    },
    {
      step: 3,
      name: "Business Details",
      completed: !!(sellerProfile.businessName && sellerProfile.abn && sellerProfile.businessAddress),
      description: "Business name, ABN, and address information",
      missing: []
    },
    {
      step: 4,
      name: "Business Summary",
      completed: true, // Optional step - always considered completed
      description: "Tell us about you business/Artists"
    },
    {
      step: 5,
      name: "Store Profile", 
      completed: !!(sellerProfile.storeName && sellerProfile.storeDescription),
      description: "Store name, description, and logo"
    },
    {
      step: 6,
      name: "KYC Documents",
      completed: sellerProfile.kycSubmitted === true,
      description: "Identity verification documents"
    },
    {
      step: 7,
      name: "Bank Details",
      completed: !!(sellerProfile.bankAccountNumber && sellerProfile.bankBSB),
      description: "Banking information for payments"
    },
    {
      step: 8,
      name: "Submit for Review",
      completed: sellerProfile.status === 'PENDING_APPROVAL' || sellerProfile.status === 'APPROVED',
      description: "Final submission for admin review"
    }
  ];

  // Add missing field details for step 3
  const step3 = steps[2];
  if (!step3.completed) {
    if (!sellerProfile.businessName) step3.missing.push('Business Name');
    if (!sellerProfile.abn) step3.missing.push('ABN');
    if (!sellerProfile.businessAddress) step3.missing.push('Business Address');
  }

  return steps;
};

// Helper function to get current step
const getCurrentStep = (sellerProfile) => {
  const steps = getOnboardingStepDetails(sellerProfile);
  
  // Find first incomplete step
  for (let i = 0; i < steps.length; i++) {
    if (!steps[i].completed) {
      return {
        currentStep: steps[i].step,
        currentStepInfo: steps[i],
        nextSteps: steps.slice(i),
        completedSteps: steps.slice(0, i)
      };
    }
  }
  
  // All steps completed
  return {
    currentStep: 8,
    currentStepInfo: steps[7],
    nextSteps: [],
    completedSteps: steps,
    allCompleted: true
  };
};

// Step 1: Apply as Seller
exports.applyAsSeller = async (request, reply) => {
  try {
    const { email, phone, contactPerson } = request.body;

    if (!email || !phone || !contactPerson) {
      return reply.status(400).send({
        success: false,
        message: "Email, phone, and contact person are required"
      });
    }

    const normalizedEmail = email.toLowerCase();

    // Check if email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { sellerProfile: true }
    });

    if (existingUser) {
      // If user exists but hasn't verified email, allow resending OTP
      if (!existingUser.emailVerified && existingUser.role === 'SELLER') {
        // Generate new OTP
        const otp = generateOTP();
        const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        // Update or create pending registration
        await prisma.pendingRegistration.upsert({
          where: { email: normalizedEmail },
          update: {
            otp,
            otpExpiry,
            updatedAt: new Date()
          },
          create: {
            email: normalizedEmail,
            phone,
            name: contactPerson,
            otp,
            otpExpiry,
            role: 'SELLER'
          }
        });

        await sendOTPEmail(normalizedEmail, otp, contactPerson);

        return reply.status(200).send({
          success: true,
          message: "OTP sent to your email. Please verify to continue.",
          userId: existingUser.id
        });
      }

      return reply.status(400).send({
        success: false,
        message: "Email already registered"
      });
    }

    // Generate OTP
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    // Create or update pending registration (upsert to handle re-applications)
    const pendingReg = await prisma.pendingRegistration.upsert({
      where: { email: normalizedEmail },
      update: {
        phone,
        name: contactPerson,
        otp,
        otpExpiry,
        role: 'SELLER'
      },
      create: {
        email: normalizedEmail,
        phone,
        name: contactPerson,
        otp,
        otpExpiry,
        role: 'SELLER'
      }
    });

    // Send OTP email
    await sendOTPEmail(normalizedEmail, otp, contactPerson);

    reply.status(200).send({
      success: true,
      message: "OTP sent to your email. Please verify to continue.",
      sellerId: pendingReg.id,
      email: normalizedEmail
    });
  } catch (error) {
    console.error("Apply as seller error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// Step 2: Verify OTP & Set Password
exports.verifyOTP = async (request, reply) => {
  try {
    const { email, sellerId, otp, password } = request.body;

    // Support both email and sellerId for backward compatibility
    if ((!email && !sellerId) || !otp) {
      return reply.status(400).send({
        success: false,
        message: "Email or Seller ID and OTP are required"
      });
    }

    if (!password || password.length < 6) {
      return reply.status(400).send({
        success: false,
        message: "Password is required and must be at least 6 characters"
      });
    }

    // Find pending registration by email or sellerId
    let pending;
    if (sellerId) {
      pending = await prisma.pendingRegistration.findUnique({
        where: { id: sellerId }
      });
    } else {
      const normalizedEmail = email.toLowerCase();
      pending = await prisma.pendingRegistration.findUnique({
        where: { email: normalizedEmail }
      });
    }

    if (!pending || pending.otp !== otp) {
      return reply.status(400).send({
        success: false,
        message: "Invalid OTP"
      });
    }

    // Check if OTP is expired
    if (pending.otpExpiry < new Date()) {
      await prisma.pendingRegistration.delete({
        where: { id: pending.id }
      });
      return reply.status(400).send({
        success: false,
        message: "OTP has expired. Please request a new one."
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Fetch default commission before transaction (for post-creation assignment)
    const defaultCommission = await getDefaultCommission().catch(() => null);

    // Create user and seller profile in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create user
      const user = await tx.user.create({
        data: {
          email: pending.email,
          password: hashedPassword,
          name: pending.name,
          phone: pending.phone || pending.mobile,
          role: 'SELLER',
          emailVerified: true
        }
      });

      // Create seller profile
      const sellerProfile = await tx.sellerProfile.create({
        data: {
          userId: user.id,
          contactPerson: pending.name,
          onboardingStep: 2,
          status: 'PENDING',
          productCount: 0,
          minimumProductsUploaded: false
        }
      });

      // Delete pending registration
      await tx.pendingRegistration.delete({
        where: { id: pending.id }
      });

      return { user, sellerProfile };
    });

    // Auto-assign the current default commission via raw SQL
    // (Prisma client regeneration may be pending; raw SQL always works)
    if (defaultCommission) {
      await prisma.$executeRaw`
        UPDATE seller_profiles SET commission_id = ${defaultCommission.id}
        WHERE "userId" = ${result.user.id}
      `.catch(err => console.error("Commission auto-assign error (non-fatal):", err.message));
    }

    // Generate JWT token
    const token = generateSellerToken(result.user.id);

    // Fetch default commission that was assigned (if any)
    const assignedCommission = await getCommissionForSeller(result.user.id).catch(() => null);

    // Send registration confirmation email with application number (non-blocking)
    sendSellerRegistrationEmail(
      result.user.email,
      result.user.name || "Seller",
      result.sellerProfile.id
    ).catch(err => console.error("Registration email error (non-fatal):", err.message));

    // Send notifications to all admins (admin + super admin)
    const sellerDetails = {
      sellerName: result.user.name || 'Unknown Seller',
      email: result.user.email,
      applicationId: result.sellerProfile.id,
      businessName: pending.formData?.businessName || null
    };
    
    try {
      await notifyAdminNewSellerApplication(result.user.id, sellerDetails);
      console.log(`🔔 Notifications sent to admins for new seller: ${result.user.name}`);
    } catch (notificationError) {
      console.error('Failed to send notifications to admins:', notificationError);
    }

    // Send emails only to super admins
    try {
      const superAdmins = await prisma.user.findMany({
        where: { role: 'SUPER_ADMIN' },
        select: { email: true, name: true }
      });

      for (const admin of superAdmins) {
        if (admin.email) {
          await sendSuperAdminNewSellerEmail(admin.email, admin.name, {
            sellerName: result.user.name || 'Unknown Seller',
            email: result.user.email,
            businessName: pending.formData?.businessName || null,
            applicationId: result.sellerProfile.id
          });
        }
      }
      console.log(`📧 Emails sent to ${superAdmins.length} super admins for new seller: ${result.user.name}`);
    } catch (emailError) {
      console.error('Failed to send emails to super admins:', emailError);
    }

    // Remove password from response
    const { password: _, ...userWithoutPassword } = result.user;

    reply.status(200).send({
      success: true,
      message: "Email verified and password set successfully. You can now continue with your application.",
      user: userWithoutPassword,
      sellerProfile: {
        ...result.sellerProfile,
        applicationNumber: result.sellerProfile.id,
        commission: assignedCommission || null
      },
      applicationNumber: result.sellerProfile.id,
      commission: assignedCommission || null,
      token
    });
  } catch (error) {
    console.error("Verify OTP error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// Seller Login
exports.sellerLogin = async (request, reply) => {
  try {
    const { email, password } = request.body;

    if (!email || !password) {
      return reply.status(400).send({
        success: false,
        message: "Email and password are required"
      });
    }

    const normalizedEmail = email.toLowerCase();

    // Find seller by email
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { sellerProfile: true }
    });

    if (!user || user.role !== 'SELLER') {
      return reply.status(401).send({
        success: false,
        message: "Invalid email or password"
      });
    }

    // Check if seller has set password
    if (!user.password) {
      return reply.status(400).send({
        success: false,
        message: "Please complete your registration first by verifying OTP and setting a password"
      });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return reply.status(401).send({
        success: false,
        message: "Invalid email or password"
      });
    }

    // Check if seller is rejected
    if (user.sellerProfile && user.sellerProfile.status === 'REJECTED') {
      return reply.status(403).send({
        success: false,
        message: "Your seller account has been rejected. Please contact support."
      });
    }

    // Generate JWT token
    const token = generateSellerToken(user.id);

    // Fetch commission assigned to this seller
    const commission = await getCommissionForSeller(user.id).catch(() => null);

    // Remove password from response
    const { password: _, ...userWithoutPassword } = user;

    reply.status(200).send({
      success: true,
      message: "Login successful",
      user: {
        ...userWithoutPassword,
        sellerProfile: userWithoutPassword.sellerProfile
          ? { ...userWithoutPassword.sellerProfile, commission: commission || null }
          : userWithoutPassword.sellerProfile
      },
      commission: commission || null,
      token,
      onboardingStatus: getCurrentStep(user.sellerProfile)
    });
  } catch (error) {
    console.error("Seller login error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// Resend OTP
exports.resendOTP = async (request, reply) => {
  try {
    const { email, sellerId } = request.body;

    // Support both email and sellerId
    if (!email && !sellerId) {
      return reply.status(400).send({
        success: false,
        message: "Email or Seller ID is required"
      });
    }

    // Find pending registration
    let pending;
    if (sellerId) {
      pending = await prisma.pendingRegistration.findUnique({
        where: { id: sellerId }
      });
    } else {
      const normalizedEmail = email.toLowerCase();
      pending = await prisma.pendingRegistration.findUnique({
        where: { email: normalizedEmail }
      });
    }

    if (!pending) {
      return reply.status(404).send({
        success: false,
        message: "No pending registration found"
      });
    }

    // Generate new OTP
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    // Update pending registration with new OTP
    await prisma.pendingRegistration.update({
      where: { id: pending.id },
      data: {
        otp,
        otpExpiry,
        updatedAt: new Date()
      }
    });

    // Send OTP
    await sendOTPEmail(pending.email, otp, pending.name);

    reply.status(200).send({
      success: true,
      message: "New OTP sent to your email"
    });
  } catch (error) {
    console.error("Resend OTP error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// Step 3: Submit Business Details
exports.submitBusinessDetails = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const {
      businessName,
      abn,
      businessAddress,
      businessType,
      yearsInBusiness
    } = request.body;

    if (!businessName || !abn || !businessAddress) {
      return reply.status(400).send({
        success: false,
        message: "Business name, ABN, and address are required"
      });
    }

    // Update seller profile
    const sellerProfile = await prisma.sellerProfile.update({
      where: { userId },
      data: {
        businessName,
        abn,
        businessAddress: typeof businessAddress === 'string' ? businessAddress : JSON.stringify(businessAddress),
        businessType,
        yearsInBusiness: yearsInBusiness ? parseInt(yearsInBusiness) : null,
        onboardingStep: 3,
        updatedAt: new Date()
      }
    });

    reply.status(200).send({
      success: true,
      message: "Business details submitted successfully",
      sellerProfile
    });
  } catch (error) {
    console.error("Submit business details error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// Validate ABN with Vigil API
exports.validateABN = async (request, reply) => {
  try {
    const { abn } = request.body;

    if (!abn) {
      return reply.status(400).send({
        success: false,
        message: "ABN is required"
      });
    }

    // Call ABR API for ABN lookup
    const abnResult = await abnLookup(abn);

    reply.status(200).send({
      success: abnResult.isValid,
      abnValidation: abnResult
    });
  } catch (error) {
    console.error("Validate ABN error:", error);
    reply.status(500).send({
      success: false,
      message: "Failed to validate ABN",
      error: error.message
    });
  }
};

// Validate ABN (GET method with query params)
exports.validateABNGet = async (request, reply) => {
  try {
    const { abn } = request.query;

    if (!abn) {
      return reply.status(400).send({
        success: false,
        message: "ABN query parameter is required"
      });
    }

    // Call ABR API for ABN lookup
    const abnResult = await abnLookup(abn);

    reply.status(200).send({
      success: abnResult.isValid,
      abnValidation: abnResult
    });
  } catch (error) {
    console.error("Validate ABN (GET) error:", error);
    reply.status(500).send({
      success: false,
      message: "Failed to validate ABN",
      error: error.message
    });
  }
};

// Step 4: Submit Business Summary (Optional)
exports.submitCulturalInfo = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const { artistName, description } = request.body;

    // Both fields are now optional - no validation required

    // Update seller profile
    const sellerProfile = await prisma.sellerProfile.update({
      where: { userId },
      data: {
        artistName,
        artistDescription: description || null,
        onboardingStep: 4,
        updatedAt: new Date()
      }
    });

    reply.status(200).send({
      success: true,
      message: "Business summary saved successfully",
      sellerProfile
    });
  } catch (error) {
    console.error("Submit business summary error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// Step 5: Submit Store Profile
exports.submitStoreProfile = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const {
      storeName,
      storeDescription,
      storeBio,
      storeLogo,
      logo,
      storeBanner,
      banner,
      storeLocation
    } = request.body;

    // Support both storeDescription and storeBio
    const description = storeDescription || storeBio;
    
    // Support both storeLogo/logo and storeBanner/banner
    const logoUrl = storeLogo || logo;
    const bannerUrl = storeBanner || banner;

    if (!storeName || !description) {
      return reply.status(400).send({
        success: false,
        message: "Store name and description are required"
      });
    }

    // Update seller profile
    const sellerProfile = await prisma.sellerProfile.update({
      where: { userId },
      data: {
        storeName,
        storeDescription: description,
        storeLogo: logoUrl,
        storeBanner: bannerUrl,
        storeLocation,
        onboardingStep: 5,
        updatedAt: new Date()
      }
    });

    reply.status(200).send({
      success: true,
      message: "Store profile submitted successfully",
      sellerProfile
    });
  } catch (error) {
    console.error("Submit store profile error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// Step 6: Upload KYC Documents
exports.uploadKYC = async (request, reply) => {
  try {
    const userId = request.user.userId;
    
    // Files should be uploaded via multer middleware
    // Check if files exist in request
    if (!request.files || request.files.length === 0) {
      return reply.status(400).send({
        success: false,
        message: "Please upload at least one KYC document"
      });
    }

    const uploadedDocuments = [];

    // Upload each file to Cloudinary
    for (const file of request.files) {
      try {
        // Upload to Cloudinary
        const result = await uploadToCloudinary(file.path, 'kyc-documents');
        
        uploadedDocuments.push({
          documentType: file.fieldname,
          documentUrl: result.url,
          publicId: result.publicId,
          originalName: file.originalname,
          uploadedAt: new Date()
        });

        // Delete local file after upload
        await fs.unlink(file.path);
      } catch (uploadError) {
        console.error(`Failed to upload ${file.originalname}:`, uploadError);
        // Continue with other files
      }
    }

    if (uploadedDocuments.length === 0) {
      return reply.status(500).send({
        success: false,
        message: "Failed to upload documents"
      });
    }

    // Update seller profile with KYC documents
    const sellerProfile = await prisma.sellerProfile.update({
      where: { userId },
      data: {
        kycDocuments: uploadedDocuments,
        kycSubmitted: true,
        onboardingStep: 6,
        updatedAt: new Date()
      }
    });

    // Optional: Call Vigil API for identity verification
    // const verificationResult = await verifyIdentityDocument(uploadedDocuments[0].documentUrl);

    reply.status(200).send({
      success: true,
      message: "KYC documents uploaded successfully",
      documents: uploadedDocuments,
      sellerProfile
    });
  } catch (error) {
    console.error("Upload KYC error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// Step 7: Submit Bank Details
exports.submitBankDetails = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const { bankName, accountName, bsb, accountNumber } = request.body;

    if (!bankName || !accountName || !bsb || !accountNumber) {
      return reply.status(400).send({
        success: false,
        message: "All bank details are required"
      });
    }

    // Update seller profile
    const sellerProfile = await prisma.sellerProfile.update({
      where: { userId },
      data: {
        bankDetails: {
          bankName,
          accountName,
          bsb,
          accountNumber
        },
        onboardingStep: 7,
        updatedAt: new Date()
      }
    });

    reply.status(200).send({
      success: true,
      message: "Bank details submitted successfully",
      sellerProfile
    });
  } catch (error) {
    console.error("Submit bank details error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// Step 8: Submit for Review
exports.submitForReview = async (request, reply) => {
  try {
    const userId = request.user.userId;

    // Get seller profile
    const sellerProfile = await prisma.sellerProfile.findUnique({
      where: { userId }
    });

    if (!sellerProfile) {
      return reply.status(404).send({
        success: false,
        message: "Seller profile not found"
      });
    }

    // Validate all required fields are completed
    const requiredFields = [
      'businessName',
      'abn',
      'businessAddress',
      'businessType',
      'storeName',
      'storeDescription'
    ];

    const missingFields = requiredFields.filter(field => !sellerProfile[field]);

    if (missingFields.length > 0) {
      return reply.status(400).send({
        success: false,
        message: `Please complete the following fields: ${missingFields.join(', ')}`
      });
    }

    if (!sellerProfile.kycSubmitted) {
      return reply.status(400).send({
        success: false,
        message: "Please upload KYC documents before submitting"
      });
    }

    // Update status to pending review
    const updatedProfile = await prisma.sellerProfile.update({
      where: { userId },
      data: {
        status: 'PENDING',
        submittedForReviewAt: new Date(),
        onboardingStep: 8,
        updatedAt: new Date()
      }
    });

    // Send confirmation email to seller
    try {
      const sellerUser = await prisma.user.findUnique({
        where: { id: request.user.userId },
        select: { email: true, name: true }
      });
      if (sellerUser) {
        await sendSellerApplicationSubmittedEmail(sellerUser.email, sellerUser.name || "Seller", updatedProfile.id);
      }
    } catch (emailErr) {
      console.error("Application submission email error (non-fatal):", emailErr.message);
    }

    reply.status(200).send({
      success: true,
      message: "Application submitted for review successfully",
      applicationNumber: updatedProfile.id,
      sellerProfile: {
        ...updatedProfile,
        applicationNumber: updatedProfile.id
      }
    });
  } catch (error) {
    console.error("Submit for review error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// Get Seller Profile
exports.getProfile = async (request, reply) => {
  try {
    const userId = request.user.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        sellerProfile: true
      }
    });

    if (!user || !user.sellerProfile) {
      return reply.status(404).send({
        success: false,
        message: "Seller profile not found"
      });
    }

    // Remove password
    const { password: _, ...userWithoutPassword } = user;

    // Fetch commission assigned to this seller
    const commission = await getCommissionForSeller(userId).catch(() => null);

    // Attach applicationNumber to sellerProfile in response
    if (userWithoutPassword.sellerProfile) {
      userWithoutPassword.sellerProfile = {
        ...userWithoutPassword.sellerProfile,
        applicationNumber: userWithoutPassword.sellerProfile.id,
        commission: commission || null
      };
    }

    reply.status(200).send({
      success: true,
      applicationNumber: user.sellerProfile.id,
      commission: commission || null,
      user: userWithoutPassword,
      onboardingStatus: getCurrentStep(user.sellerProfile)
    });
  } catch (error) {
    console.error("Get profile error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// Update Seller Profile
exports.updateProfile = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const updates = request.body;

    // Remove fields that shouldn't be directly updated
    delete updates.userId;
    delete updates.status;
    delete updates.productCount;
    delete updates.kycSubmitted;

    const sellerProfile = await prisma.sellerProfile.update({
      where: { userId },
      data: {
        ...updates,
        updatedAt: new Date()
      }
    });

    reply.status(200).send({
      success: true,
      message: "Profile updated successfully",
      sellerProfile
    });
  } catch (error) {
    console.error("Update profile error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// Get Go-Live Status
exports.getGoLiveStatus = async (request, reply) => {
  try {
    const userId = request.user.userId;

    const sellerProfile = await prisma.sellerProfile.findUnique({
      where: { userId }
    });

    if (!sellerProfile) {
      return reply.status(404).send({
        success: false,
        message: "Seller profile not found"
      });
    }

    // Check all requirements for going live
    const requirements = {
      accountApproved: sellerProfile.status === 'APPROVED' || sellerProfile.status === 'ACTIVE',
      minimumProducts: sellerProfile.minimumProductsUploaded,
      kycCompleted: sellerProfile.kycSubmitted,
      bankDetailsAdded: !!sellerProfile.bankDetails
    };

    const canGoLive = Object.values(requirements).every(req => req === true);

    reply.status(200).send({
      success: true,
      canGoLive,
      requirements,
      currentStatus: sellerProfile.status,
      productCount: sellerProfile.productCount
    });
  } catch (error) {
    console.error("Get go-live status error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// Update Product Count (called when products are added/removed)
exports.updateProductCount = async (userId, increment = true) => {
  try {
    const sellerProfile = await prisma.sellerProfile.findUnique({
      where: { userId }
    });

    if (!sellerProfile) {
      throw new Error("Seller profile not found");
    }

    const newCount = increment ? sellerProfile.productCount + 1 : Math.max(0, sellerProfile.productCount - 1);

    // Check if minimum products requirement is met (e.g., 5 products)
    const minimumRequired = 5;
    const minimumProductsUploaded = newCount >= minimumRequired;

    await prisma.sellerProfile.update({
      where: { userId },
      data: {
        productCount: newCount,
        minimumProductsUploaded,
        updatedAt: new Date()
      }
    });

    return { productCount: newCount, minimumProductsUploaded };
  } catch (error) {
    console.error("Update product count error:", error);
    throw error;
  }
};

// Get Onboarding Status - Shows current step and what's needed to continue
exports.getOnboardingStatus = async (request, reply) => {
  try {
    const userId = request.user.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sellerProfile: true }
    });

    if (!user || !user.sellerProfile) {
      return reply.status(404).send({
        success: false,
        message: "Seller profile not found"
      });
    }

    const onboardingStatus = getCurrentStep(user.sellerProfile);
    
    reply.status(200).send({
      success: true,
      onboardingStatus,
      profile: {
        id: user.sellerProfile.id,
        applicationNumber: user.sellerProfile.id,
        status: user.sellerProfile.status,
        onboardingStep: user.sellerProfile.onboardingStep,
        businessName: user.sellerProfile.businessName,
        storeName: user.sellerProfile.storeName,
        kycSubmitted: user.sellerProfile.kycSubmitted
      }
    });
  } catch (error) {
    console.error("Get onboarding status error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// Resume Onboarding - Public endpoint to help users continue their onboarding
exports.resumeOnboarding = async (request, reply) => {
  try {
    const { email } = request.body;

    if (!email) {
      return reply.status(400).send({
        success: false,
        message: "Email is required"
      });
    }

    const normalizedEmail = email.toLowerCase();

    // Check if user exists and is a seller
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { sellerProfile: true }
    });

    // Check if user is in pending registration (hasn't completed step 2)
    if (!user) {
      const pendingReg = await prisma.pendingRegistration.findUnique({
        where: { email: normalizedEmail }
      });

      if (pendingReg) {
        return reply.status(200).send({
          success: true,
          message: "Please complete email verification first",
          step: 1,
          action: "verify_otp",
          description: "You need to verify your email and set a password to continue"
        });
      } else {
        return reply.status(404).send({
          success: false,
          message: "No seller account found with this email. Please start the application process."
        });
      }
    }

    if (user.role !== 'SELLER' || !user.sellerProfile) {
      return reply.status(400).send({
        success: false,
        message: "This email is not associated with a seller account"
      });
    }

    // Check if seller is rejected
    if (user.sellerProfile.status === 'REJECTED') {
      return reply.status(403).send({
        success: false,
        message: "Your seller account has been rejected. Please contact support."
      });
    }

    const onboardingStatus = getCurrentStep(user.sellerProfile);
    
    reply.status(200).send({
      success: true,
      message: "Please log in with your email and password to continue your seller onboarding",
      currentStep: onboardingStatus.currentStep,
      stepName: onboardingStatus.currentStepInfo.name,
      description: onboardingStatus.currentStepInfo.description,
      completedSteps: onboardingStatus.completedSteps.length,
      totalSteps: 8,
      action: "login_required",
      loginEndpoint: "/seller-onboarding/login"
    });
  } catch (error) {
    console.error("Resume onboarding error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// Forgot Password for Sellers - Sends reset link/OTP
exports.forgotPassword = async (request, reply) => {
  try {
    const { email } = request.body;

    if (!email) {
      return reply.status(400).send({
        success: false,
        message: "Email is required"
      });
    }

    const normalizedEmail = email.toLowerCase();

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { sellerProfile: true }
    });

    if (!user || user.role !== 'SELLER') {
      return reply.status(404).send({
        success: false,
        message: "No seller account found with this email"
      });
    }

    // Generate OTP for password reset
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store OTP in pendingRegistration table for password reset
    await prisma.pendingRegistration.upsert({
      where: { email: normalizedEmail },
      update: {
        otp,
        otpExpiry,
        name: user.name,
        phone: user.phone,
        role: 'SELLER',
        updatedAt: new Date()
      },
      create: {
        email: normalizedEmail,
        name: user.name,
        phone: user.phone,
        otp,
        otpExpiry,
        role: 'SELLER'
      }
    });

    // Send OTP email
    await sendOTPEmail(normalizedEmail, otp, user.name);

    reply.status(200).send({
      success: true,
      message: "Password reset OTP sent to your email"
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// Reset Password for Sellers - Verify OTP and set new password
exports.resetPassword = async (request, reply) => {
  try {
    const { email, otp, newPassword } = request.body;

    if (!email || !otp || !newPassword) {
      return reply.status(400).send({
        success: false,
        message: "Email, OTP, and new password are required"
      });
    }

    if (newPassword.length < 6) {
      return reply.status(400).send({
        success: false,
        message: "Password must be at least 6 characters"
      });
    }

    const normalizedEmail = email.toLowerCase();

    const pending = await prisma.pendingRegistration.findUnique({
      where: { email: normalizedEmail }
    });

    if (!pending || pending.otp !== otp) {
      return reply.status(400).send({
        success: false,
        message: "Invalid OTP"
      });
    }

    // Check if OTP is expired
    if (pending.otpExpiry < new Date()) {
      await prisma.pendingRegistration.delete({
        where: { id: pending.id }
      });
      return reply.status(400).send({
        success: false,
        message: "OTP has expired. Please request a new one."
      });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update user password
    const user = await prisma.user.update({
      where: { email: normalizedEmail },
      data: { password: hashedPassword },
      include: { sellerProfile: true }
    });

    // Delete pending registration
    await prisma.pendingRegistration.delete({
      where: { id: pending.id }
    });

    // Generate token
    const token = generateSellerToken(user.id);

    // Remove password from response
    const { password: _, ...userWithoutPassword } = user;

    reply.status(200).send({
      success: true,
      message: "Password reset successful. You can now continue your onboarding.",
      user: userWithoutPassword,
      token,
      onboardingStatus: getCurrentStep(user.sellerProfile)
    });
  } catch (error) {
    console.error("Reset password error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// =============================================================================
// NEW SINGLE-PAYLOAD ONBOARDING FLOW
// =============================================================================

// STEP FINAL-1: Collect full form, send OTP to email (NO token required)
// Frontend collects all steps locally, then calls this to submit & trigger OTP
// Accepts multipart/form-data — text fields + KYC files in one request
exports.submitSellerOnboarding = async (request, reply) => {
  try {
    // @fastify/multipart v9 WITHOUT attachFieldsToBody:
    // Must manually iterate parts() to collect text fields AND files
    const fields = {};
    const uploadedParts = [];

    const parts = request.parts();
    for await (const part of parts) {
      if (part.type === 'file') {
        // Save file buffer in memory for Cloudinary upload
        const buf = await part.toBuffer();
        uploadedParts.push({
          fieldname: part.fieldname,
          filename: part.filename,
          mimetype: part.mimetype,
          buffer: buf
        });
      } else {
        fields[part.fieldname] = part.value;
      }
    }

    const {
      email, phone, contactPerson, password,
      businessName, abn, businessAddress, businessType,
      artistName, description,
      storeName, storeDescription, storeLogo,
      bankName, accountName, bsb, accountNumber,
      documentType,
      firstName: kycFirstName,
      lastName: kycLastName,
      dateOfBirth
    } = fields;

    if (!email || !phone || !contactPerson || !password) {
      return reply.status(400).send({
        success: false,
        message: "Email, phone, contact person, and password are required"
      });
    }

    if (password.length < 6) {
      return reply.status(400).send({
        success: false,
        message: "Password must be at least 6 characters"
      });
    }

    // Separate uploaded files by fieldname
    const storeLogoParts = uploadedParts.filter(f => f.fieldname === 'storeLogo');
    const kycFileParts = uploadedParts.filter(f => f.fieldname !== 'storeLogo');

    // Validate required fields
    // Bank details (bankName, accountName, bsb, accountNumber) are NOT required here
    // — they are collected by Stripe Connect during seller payout onboarding.
    // KYC documents are also NOT required here — Stripe handles identity verification.
    const missingFields = [];
    if (!businessName) missingFields.push("businessName");
    if (!abn) missingFields.push("abn");
    if (!businessAddress) missingFields.push("businessAddress");
    if (!businessType) missingFields.push("businessType");
    if (!storeName) missingFields.push("storeName");
    if (!storeDescription) missingFields.push("storeDescription");
    if (!storeLogo && storeLogoParts.length === 0) missingFields.push("storeLogo");

    // Reject placeholder ABN values
    const abnPlaceholders = ["n/a", "na", "none", "nil", "-", "0"];
    if (abn && abnPlaceholders.includes(abn.trim().toLowerCase())) {
      return reply.status(400).send({
        success: false,
        message: "Please enter a valid ABN. If you don't have one yet, leave the field blank."
      });
    }

    if (missingFields.length > 0) {
      return reply.status(400).send({
        success: false,
        message: `The following fields are required: ${missingFields.join(", ")}`
      });
    }

    // Upload storeLogo to Cloudinary if sent as file
    let storeLogoUrl = storeLogo || null;
    if (storeLogoParts.length > 0) {
      const logoFile = storeLogoParts[0];
      const tmpPath = path.join(os.tmpdir(), `storeLogo-${Date.now()}-${logoFile.filename || 'logo'}`);
      try {
        await fs.writeFile(tmpPath, logoFile.buffer);
        const result = await uploadToCloudinary(tmpPath, 'store-logos');
        storeLogoUrl = result.url;
      } catch (err) {
        console.error('storeLogo upload failed:', err.message);
        return reply.status(500).send({ success: false, message: 'Failed to upload store logo' });
      } finally {
        await fs.unlink(tmpPath).catch(() => {});
      }
    }

    const normalizedEmail = email.toLowerCase();

    // Check if already fully registered
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail }
    });

    if (existingUser) {
      return reply.status(400).send({
        success: false,
        message: "Email already registered. Please login instead."
      });
    }

    // KYC upload is optional — Stripe Connect handles identity verification.
    // If KYC files are provided, upload them; otherwise skip.
    const kycDocuments = [];
    if (kycFileParts && kycFileParts.length > 0) {
    for (const file of kycFileParts) {
      // Write buffer to a tmp file, upload to Cloudinary, then delete tmp
      const tmpPath = path.join(os.tmpdir(), `kyc-${Date.now()}-${file.filename || 'doc'}`);
      try {
        await fs.writeFile(tmpPath, file.buffer);
        const result = await uploadToCloudinary(tmpPath, 'kyc-documents');
        kycDocuments.push({
          documentType: documentType || file.fieldname,
          firstName: kycFirstName || null,
          lastName: kycLastName || null,
          dateOfBirth: dateOfBirth || null,
          documentUrl: result.url,
          publicId: result.publicId,
          originalName: file.filename,
          uploadedAt: new Date()
        });
      } catch (uploadErr) {
        console.error(`KYC upload failed for ${file.filename}:`, uploadErr.message);
      } finally {
        await fs.unlink(tmpPath).catch(() => {});
      }
    }
    } // end optional KYC upload block

    // Generate OTP
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    // Store all form data + KYC Cloudinary URLs as JSON alongside OTP
    const formData = {
      phone,
      contactPerson,
      password, // plain — will be hashed on verify-and-submit
      businessName: businessName || null,
      abn: abn || null,
      businessAddress: businessAddress || null,
      businessType: businessType || null,
      artistName: artistName || null,
      description: description || null,
      storeName: storeName || null,
      storeDescription: storeDescription || null,
      storeLogo: storeLogoUrl,
      bankName: bankName || null,
      accountName: accountName || null,
      bsb: bsb || null,
      accountNumber: accountNumber || null,
      kycDocuments: kycDocuments.length > 0 ? kycDocuments : null
    };

    // Upsert: if the email had a previous abandoned attempt, overwrite it
    await prisma.pendingRegistration.upsert({
      where: { email: normalizedEmail },
      update: {
        name: contactPerson,
        phone,
        otp,
        otpExpiry,
        formData,
        updatedAt: new Date()
      },
      create: {
        email: normalizedEmail,
        name: contactPerson,
        phone,
        otp,
        otpExpiry,
        role: 'SELLER',
        formData
      }
    });

    // Send OTP email
    const emailResult = await sendOTPEmail(normalizedEmail, otp, contactPerson);
    if (!emailResult?.success) {
      return reply.status(500).send({
        success: false,
        message: "Failed to send OTP email. Please try again later."
      });
    }

    return reply.status(200).send({
      success: true,
      message: "OTP sent to your email. Please verify to complete registration.",
      email: normalizedEmail,
      kycUploaded: kycDocuments.length
    });
  } catch (error) {
    console.error("submitSellerOnboarding error:", error);
    reply.status(500).send({ success: false, message: "Server error", debug: error?.message });
  }
};

// STEP FINAL-2: Verify OTP and create User + SellerProfile (PENDING approval)
// No token returned — account goes to admin queue for approval
exports.verifyAndSubmit = async (request, reply) => {
  try {
    const { email, otp } = request.body;

    if (!email || !otp) {
      return reply.status(400).send({
        success: false,
        message: "Email and OTP are required"
      });
    }

    const normalizedEmail = email.toLowerCase();

    const pending = await prisma.pendingRegistration.findUnique({
      where: { email: normalizedEmail }
    });

    if (!pending || pending.otp !== otp) {
      return reply.status(400).send({
        success: false,
        message: "Invalid OTP"
      });
    }

    if (pending.otpExpiry < new Date()) {
      await prisma.pendingRegistration.delete({ where: { id: pending.id } });
      return reply.status(400).send({
        success: false,
        message: "OTP has expired. Please request a new one."
      });
    }

    const fd = pending.formData || {};

    if (!fd.password) {
      return reply.status(400).send({
        success: false,
        message: "Registration data is incomplete. Please restart the onboarding."
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(fd.password, 10);

    // Create User + SellerProfile in a single transaction
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: normalizedEmail,
          password: hashedPassword,
          name: fd.contactPerson,
          phone: fd.phone || null,
          role: 'SELLER',
          emailVerified: true
        }
      });

      const sellerProfile = await tx.sellerProfile.create({
        data: {
          userId: user.id,
          contactPerson: fd.contactPerson,
          businessName: fd.businessName || null,
          abn: fd.abn || null,
          businessAddress: fd.businessAddress
            ? (typeof fd.businessAddress === 'string' ? fd.businessAddress : JSON.stringify(fd.businessAddress))
            : null,
          businessType: fd.businessType || null,
          artistName: fd.artistName || null,
          artistDescription: fd.description || null,
          storeName: fd.storeName || null,
          storeDescription: fd.storeDescription || null,
          storeLogo: fd.storeLogo || null,
          bankDetails: (fd.bankName && fd.accountName && fd.bsb && fd.accountNumber)
            ? { bankName: fd.bankName, accountName: fd.accountName, bsb: fd.bsb, accountNumber: fd.accountNumber }
            : undefined,
          kycDocuments: fd.kycDocuments || undefined,
          kycSubmitted: fd.kycDocuments && fd.kycDocuments.length > 0 ? true : false,
          onboardingStep: 2,
          status: 'PENDING',
          productCount: 0,
          minimumProductsUploaded: false
        }
      });

      // Clean up pending registration
      await tx.pendingRegistration.delete({ where: { id: pending.id } });

      return { user, sellerProfile };
    });

    // Notify admin of new seller application
    try {
      await sendSellerApplicationSubmittedEmail(normalizedEmail, fd.contactPerson, result.sellerProfile.id);
    } catch (e) {
      console.error('Admin notification email failed:', e.message);
    }

    // Generate JWT so the seller can immediately call authenticated routes
    // (e.g. Stripe Connect onboarding) without needing a separate login step.
    const token = generateSellerToken(result.user.id);

    return reply.status(200).send({
      success: true,
      message: "Application submitted successfully! Your account is under review. We'll notify you once an admin approves your application.",
      token,
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        role: result.user.role,
      },
      sellerProfile: {
        id: result.sellerProfile.id,
        applicationNumber: result.sellerProfile.id,
        status: result.sellerProfile.status,
        onboardingStep: result.sellerProfile.onboardingStep,
      },
    });
  } catch (error) {
    console.error("verifyAndSubmit error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// Validate ABN - Public version (no token) for use during onboarding form
exports.validateABNPublic = async (request, reply) => {
  try {
    const abn = request.body?.abn || request.query?.abn;

    if (!abn) {
      return reply.status(400).send({
        success: false,
        message: "ABN is required"
      });
    }

    // Check if ABN is already registered with an existing seller
    const existingSeller = await prisma.sellerProfile.findFirst({
      where: { abn: abn.replace(/\s/g, '') }
    });

    if (existingSeller) {
      return reply.status(400).send({
        success: false,
        message: "This ABN is already registered with another seller account."
      });
    }

    const abnResult = await abnLookup(abn);

    reply.status(200).send({
      success: abnResult.isValid,
      abnValidation: abnResult
    });
  } catch (error) {
    console.error("validateABNPublic error:", error);
    reply.status(500).send({
      success: false,
      message: "Failed to validate ABN",
      error: error.message
    });
  }
};

// ─── BANK DETAILS (Dashboard) ─────────────────────────────────────────────────

// GET /seller-onboarding/bank-details
// Returns the seller's current bank details (account number partially masked)
// and any pending change request they may have submitted.
exports.getBankDetails = async (request, reply) => {
  try {
    const userId = request.user.userId;

    const sellerProfile = await prisma.sellerProfile.findUnique({
      where: { userId },
      select: {
        bankDetails: true,
        bankChangeRequests: {
          where: { status: 'PENDING' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            newBankDetails: true,
            reason: true,
            status: true,
            createdAt: true
          }
        }
      }
    });

    if (!sellerProfile) {
      return reply.status(404).send({ success: false, message: "Seller profile not found" });
    }

    // Mask sensitive fields before sending
    const raw = sellerProfile.bankDetails;
    const masked = raw ? {
      bankName: raw.bankName || null,
      accountName: raw.accountName || null,
      bsb: raw.bsb ? raw.bsb.replace(/^(\d{3})/, 'XXX') : null,
      accountNumber: raw.accountNumber
        ? '*'.repeat(Math.max(0, raw.accountNumber.length - 3)) + raw.accountNumber.slice(-3)
        : null
    } : null;

    return reply.status(200).send({
      success: true,
      bankDetails: masked,
      pendingChangeRequest: sellerProfile.bankChangeRequests[0] || null
    });
  } catch (error) {
    console.error("getBankDetails error:", error);
    return reply.status(500).send({ success: false, message: "Server error" });
  }
};

// POST /seller-onboarding/bank-details/change-request
// Seller submits a request to change their bank details.
// Requires: bankName, accountName, bsb, accountNumber, currentPassword, reason
exports.requestBankDetailsChange = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const { bankName, accountName, bsb, accountNumber, currentPassword, reason } = request.body;

    // Input validation
    if (!bankName || !accountName || !bsb || !accountNumber || !currentPassword || !reason) {
      return reply.status(400).send({
        success: false,
        message: "bankName, accountName, bsb, accountNumber, currentPassword and reason are all required"
      });
    }

    if (reason.trim().length < 10) {
      return reply.status(400).send({
        success: false,
        message: "Please provide a more detailed reason (at least 10 characters)"
      });
    }

    // Verify current password and fetch name for notification
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        password: true,
        name: true,
        sellerProfile: { select: { storeName: true } }
      }
    });

    if (!user) {
      return reply.status(404).send({ success: false, message: "User not found" });
    }

    const passwordValid = await bcrypt.compare(currentPassword, user.password);
    if (!passwordValid) {
      return reply.status(401).send({ success: false, message: "Incorrect password" });
    }

    // Check for an existing pending request — only one allowed at a time
    const existingRequest = await prisma.bankChangeRequest.findFirst({
      where: { sellerId: userId, status: 'PENDING' }
    });

    if (existingRequest) {
      return reply.status(409).send({
        success: false,
        message: "You already have a pending bank details change request. Please wait for it to be reviewed."
      });
    }

    // Create the change request
    const changeRequest = await prisma.bankChangeRequest.create({
      data: {
        sellerId: userId,
        newBankDetails: { bankName, accountName, bsb, accountNumber },
        reason: reason.trim(),
        status: 'PENDING'
      }
    });

    // Fire notifications (non-blocking — does not affect the response)
    notifyBankChangeRequested(changeRequest.id, {
      sellerName: user.name,
      storeName: user.sellerProfile?.storeName || null,
      newBankDetails: { bankName, accountName, bsb, accountNumber }
    }).catch(err => console.error('Bank change requested notification error (non-blocking):', err.message));

    return reply.status(201).send({
      success: true,
      message: "Bank details change request submitted successfully. It will be reviewed by our team.",
      requestId: changeRequest.id
    });
  } catch (error) {
    console.error("requestBankDetailsChange error:", error);
    return reply.status(500).send({ success: false, message: "Server error" });
  }
};

// GET /seller-onboarding/bank-change-requests
// Returns the authenticated seller's full history of bank change requests,
// ordered most-recent first. Results are always scoped to the calling seller.
exports.getBankChangeHistory = async (request, reply) => {
  try {
    const userId = request.user.userId;

    const page  = Math.max(1, parseInt(request.query.page  ?? 1,  10));
    const limit = Math.min(100, Math.max(1, parseInt(request.query.limit ?? 20, 10)));
    const skip  = (page - 1) * limit;

    const sellerProfile = await prisma.sellerProfile.findUnique({
      where: { userId },
      select: { userId: true }
    });

    if (!sellerProfile) {
      return reply.status(404).send({ success: false, message: "Seller profile not found" });
    }

    const [total, requests] = await Promise.all([
      prisma.bankChangeRequest.count({ where: { sellerId: userId } }),
      prisma.bankChangeRequest.findMany({
        where: { sellerId: userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          newBankDetails: true,
          reason: true,
          status: true,
          reviewNote: true,
          createdAt: true,
          updatedAt: true
        }
      })
    ]);

    return reply.status(200).send({
      success: true,
      requests,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error("getBankChangeHistory error:", error);
    return reply.status(500).send({ success: false, message: "Server error" });
  }
};

