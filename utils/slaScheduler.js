const cron = require('node-cron');
const { checkSLAStatus } = require('../controllers/orderNotification');

// Initialize SLA monitoring scheduler
const initializeSLAMonitoring = () => {
  console.log("🔔 Initializing SLA monitoring scheduler...");

  // Run SLA status check every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try {
      console.log("⏰ Running SLA status check...");
      await checkSLAStatus();
      console.log("✅ SLA status check completed");
    } catch (error) {
      console.error("❌ SLA status check error:", error.message);
    }
  });

  // Run comprehensive SLA cleanup every hour
  cron.schedule('0 * * * *', async () => {
    try {
      console.log("🧹 Running SLA cleanup...");
      await cleanupOldNotifications();
      console.log("✅ SLA cleanup completed");
    } catch (error) {
      console.error("❌ SLA cleanup error:", error.message);
    }
  });

  console.log("✅ SLA monitoring scheduler initialized");
};

// Clean up old completed notifications (older than 30 days)
const cleanupOldNotifications = async () => {
  const prisma = require('../config/prisma');
  
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const result = await prisma.orderNotification.deleteMany({
      where: {
        status: 'COMPLETED',
        completedAt: {
          lt: thirtyDaysAgo
        }
      }
    });

    console.log(`🗑️ Cleaned up ${result.count} old notifications`);
  } catch (error) {
    console.error("Cleanup error:", error);
  }
};

module.exports = {
  initializeSLAMonitoring,
  cleanupOldNotifications
};