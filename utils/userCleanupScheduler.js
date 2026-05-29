/**
 * User Cleanup Scheduler
 * Auto-anonymizes user data after the specified retention time in the recycle bin
 * Runs on a configured interval to check for expired users
 */

const cron = require('node-cron');

// Configuration
const SCHEDULER_INTERVAL = '*/5 * * * *'; // How often the cron job runs (currently: every 5 minutes)
const CLEANUP_RETENTION_MINUTES = 15; // How many minutes a user stays in the recycle bin before being anonymized

// Global flag to prevent multiple schedulers
let schedulerRunning = false;

// Import the cleanup function from admin controller
const { autoCleanupExpiredUsers } = require('../controllers/admin');

/**
 * Initialize the user cleanup scheduler
 */
const initializeUserCleanupScheduler = () => {
  // Prevent multiple schedulers (important for cloud deployments)
  if (schedulerRunning) {
    console.log('⚠️  User cleanup scheduler already running');
    return;
  }

  console.log(`🔔 Initializing user cleanup scheduler (Runs: ${SCHEDULER_INTERVAL}, Retention: ${CLEANUP_RETENTION_MINUTES}min)...`);

  // Run on the specified interval
  const task = cron.schedule(SCHEDULER_INTERVAL, async () => {
    try {
      console.log('⏰ [User Cleanup] Running scheduled cleanup...');
      // Pass the retention minutes directly from the config
      const result = await autoCleanupExpiredUsers(CLEANUP_RETENTION_MINUTES);
      
      if (result.processed > 0) {
        console.log(`✅ [User Cleanup] Successfully anonymized ${result.processed} expired users`);
      } else {
        console.log('✅ [User Cleanup] No expired users found for cleanup');
      }

    } catch (error) {
      console.error('❌ [User Cleanup] Scheduled cleanup failed:', error.message);
    }
  }, {
    scheduled: false // Don't start immediately
  });

  // Start the scheduler
  task.start();
  schedulerRunning = true;
  
  console.log(`✅ User cleanup scheduler initialized - will run according to interval (${SCHEDULER_INTERVAL}) with ${CLEANUP_RETENTION_MINUTES}m retention`);

  // Return task for testing/manual control
  return task;
};

/**
 * Manual cleanup trigger (for testing or admin actions)
 */
const runManualCleanup = async (retentionMinutes = CLEANUP_RETENTION_MINUTES) => {
  try {
    console.log(`🔧 [User Cleanup] Running manual cleanup (Retention: ${retentionMinutes} minutes)...`);
    const result = await autoCleanupExpiredUsers(retentionMinutes);
    console.log(`✅ [User Cleanup] Manual cleanup completed - ${result.processed} users processed`);
    return result;
  } catch (error) {
    console.error('❌ [User Cleanup] Manual cleanup failed:', error.message);
    throw error;
  }
};

module.exports = {
  initializeUserCleanupScheduler,
  runManualCleanup
};