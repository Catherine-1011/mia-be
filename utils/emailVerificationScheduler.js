const prisma = require("../config/prisma");
const { sendOTPEmail, generateOTP } = require("./emailService");

/**
 * Email Verification Reminder Scheduler
 * Runs daily to check if any users have reached their 7-day verification deadline
 * and sends them a reminder email with a new OTP
 * 
 * RENDER.COM SAFE: Prevents duplicate emails from multiple container restarts
 */

// Global flag to track if scheduler is already running
let schedulerRunning = false;
let lastRunTime = null;

const scheduleEmailVerificationReminder = () => {
  // Prevent multiple schedulers from running (important for Render.com)
  if (schedulerRunning) {
    console.log("⚠️ [Email Verification Scheduler] Already running, skipping duplicate initialization");
    return null;
  }
  
  schedulerRunning = true;
  
  // Run every 24 hours
  const interval = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  
  const checkAndSendReminders = async () => {
    try {
      const now = new Date();
      
      // Rate limiting: Don't run more than once every 4 hours
      // This prevents duplicate emails from container restarts on Render.com
      if (lastRunTime && (now.getTime() - lastRunTime.getTime()) < (4 * 60 * 60 * 1000)) {
        console.log(`⏰ [Email Verification Scheduler] Rate limited - last run was ${((now.getTime() - lastRunTime.getTime()) / (1000 * 60)).toFixed(1)} minutes ago`);
        return;
      }
      
      console.log("🔔 [Email Verification Scheduler] Running verification reminder check...");
      lastRunTime = now;
      
      // Find users who:
      // 1. Email is not verified
      // 2. Are past their 7-day deadline  
      // 3. Haven't received reminder in last 24 hours (prevents spam)
      const twentyFourHoursAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));
      
      try {
        const usersNeedingReminder = await prisma.user.findMany({
          where: {
            emailVerified: false,
            emailVerificationDeadline: {
              lte: now // Past the deadline
            },
            OR: [
              { emailVerificationReminderSentAt: null }, // Never sent reminder
              { emailVerificationReminderSentAt: { lte: twentyFourHoursAgo } } // Reminder sent more than 24h ago
            ]
          },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            emailVerificationDeadline: true,
            emailVerificationReminderSentAt: true
          }
        });
        
        console.log(`📧 Found ${usersNeedingReminder.length} users needing email verification reminders`);
        
        if (usersNeedingReminder.length === 0) {
          console.log("✅ No users need verification reminders at this time");
          return;
        }
        
        // Send reminder email to each user
        let successCount = 0;
        for (const user of usersNeedingReminder) {
          try {
            // Additional safety check: don't send if reminder was sent in last hour
            if (user.emailVerificationReminderSentAt) {
              const hoursSinceLastReminder = (now.getTime() - user.emailVerificationReminderSentAt.getTime()) / (1000 * 60 * 60);
              if (hoursSinceLastReminder < 1) {
                console.log(`⏳ Skipping ${user.email} - reminder sent ${hoursSinceLastReminder.toFixed(1)} hours ago`);
                continue;
              }
            }
            
            // Generate a new OTP for email verification
            const otp = generateOTP();
            const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
            
            // Send verification email with OTP
            const emailResult = await sendOTPEmail(
              user.email,
              otp,
              user.name,
              `Email Verification Reminder - Your account requires verification`
            );
            
            if (emailResult.success) {
              // Mark reminder as sent with current timestamp
              await prisma.user.update({
                where: { id: user.id },
                data: {
                  emailVerificationReminderSentAt: new Date()
                }
              });
              
              successCount++;
              console.log(`✅ Reminder email sent to ${user.email} (${user.role})`);
            } else {
              console.error(`❌ Failed to send reminder email to ${user.email}:`, emailResult.error);
            }
            
            // Small delay to prevent overwhelming email service
            await new Promise(resolve => setTimeout(resolve, 1000));
            
          } catch (error) {
            console.error(`❌ Error sending reminder to user ${user.id}:`, error.message);
          }
        }
        
        console.log(`✅ Email verification reminder check completed - sent ${successCount} reminders`);
      } catch (dbError) {
        // If the columns don't exist yet (migration not run), log a helpful message
        if (dbError.message && (dbError.message.includes("emailVerificationDeadline") || dbError.message.includes("emailVerificationReminderSentAt"))) {
          console.log("⏳ [Email Verification Scheduler] Database columns not yet migrated. Please run: npx prisma db push");
          return;
        }
        throw dbError;
      }
      
    } catch (error) {
      console.error("❌ [Email Verification Scheduler] Error:", error);
    }
  };
  
  // On production/hosting platforms like Render, don't run immediately 
  // to prevent duplicate emails from container restarts
  const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER;
  
  if (!isProduction) {
    // Development: run immediately for testing
    console.log("🔧 Development mode: Running email scheduler immediately");
    checkAndSendReminders();
  } else {
    // Production: wait longer and add jitter to prevent synchronized restarts
    const jitterDelay = Math.random() * 300000; // Random delay up to 5 minutes
    console.log(`🌐 Production mode: Waiting ${(jitterDelay/1000/60).toFixed(1)} minutes before first scheduler run`);
    setTimeout(() => {
      checkAndSendReminders();
    }, jitterDelay);
  }
  
  // Schedule regular runs every 24 hours
  const scheduledInterval = setInterval(checkAndSendReminders, interval);
  
  console.log("🕐 Email verification reminder scheduler started (runs every 24 hours with rate limiting)");
  
  // Return the interval ID so it can be stopped if needed
  return scheduledInterval;
};

module.exports = { scheduleEmailVerificationReminder };

module.exports = { scheduleEmailVerificationReminder };
