const cron = require('node-cron');
const { generateGstReportData } = require('../controllers/admin');
const { generateGstReportCSV } = require('./csvExport');
const { sendMonthlyGstReportEmail } = require('./emailService');

const gstScheduler = () => {
  // Run on the 28th to 31st at 11:55 PM
  cron.schedule('55 23 28-31 * *', async () => {
    const today = new Date();
    // Check if tomorrow is the 1st of the next month
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    if (tomorrow.getDate() === 1) {
      console.log('Generating automated GST report for the month...');
      try {
        const month = today.getMonth() + 1; // 1-12
        const year = today.getFullYear();
        
        // 1. Fetch GST data mapping
        const reportData = await generateGstReportData(month, year);
        
        // 2. Generate CSV Buffer/String
        const csvString = generateGstReportCSV(reportData.transactions);
        const csvBase64String = Buffer.from(csvString).toString('base64');
        
        // 3. Send email to ritikkumar1@crobstacle.com
        await sendMonthlyGstReportEmail('ritikkumar1@crobstacle.com', reportData, csvBase64String);
        console.log('✅ Automated GST reconciliation email sent successfully.');
        
      } catch (error) {
        console.error('❌ Error executing automated GST report sync:', error);
      }
    }
  });
};

module.exports = gstScheduler;