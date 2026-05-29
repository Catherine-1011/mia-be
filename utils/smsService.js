const twilio = require("twilio");

// Initialize Twilio client
let twilioClient = null;

try {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  
  if (accountSid && authToken) {
    twilioClient = twilio(accountSid, authToken);
    console.log("✅ Twilio SMS service initialized");
  } else {
    console.log("⚠️  Twilio credentials not configured. SMS notifications disabled.");
  }
} catch (error) {
  console.error("❌ Twilio initialization error:", error.message);
}

// Send Order Confirmation SMS
const sendOrderConfirmationSMS = async (phoneNumber, orderDetails) => {
  try {
    if (!twilioClient) {
      console.log("⚠️  Twilio not configured. SMS skipped.");
      return { success: false, message: "SMS service not configured" };
    }

    const message = `
🎨 Aboriginal Art Marketplace - Order Confirmed!

Order ID: ${orderDetails.orderId}
Total: $${orderDetails.totalAmount.toFixed(2)}
Items: ${orderDetails.itemCount} product(s)

We'll notify you when your order ships!

Track your order: ${process.env.FRONTEND_URL || 'https://yourwebsite.com'}/orders/${orderDetails.orderId}

Thank you for supporting Aboriginal artists! 🌟
    `.trim();

    const result = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phoneNumber
    });

    console.log(`✅ Order confirmation SMS sent to ${phoneNumber}. SID: ${result.sid}`);
    
    return {
      success: true,
      messageSid: result.sid,
      message: "SMS sent successfully"
    };
  } catch (error) {
    console.error("❌ SMS sending error:", error.message);
    
    // Don't fail the order if SMS fails
    return {
      success: false,
      message: error.message || "Failed to send SMS"
    };
  }
};

// Send Order Status Update SMS
const sendOrderStatusSMS = async (phoneNumber, orderDetails) => {
  try {
    if (!twilioClient) {
      console.log("⚠️  Twilio not configured. SMS skipped.");
      return { success: false, message: "SMS service not configured" };
    }

    let statusMessage = "";
    
    switch (orderDetails.status) {
      case "packed":
        statusMessage = `Your order #${orderDetails.orderId} has been packed and is ready for shipping! 📦`;
        break;
      case "shipped":
        statusMessage = `Great news! Your order #${orderDetails.orderId} has been shipped! 🚚${orderDetails.trackingNumber ? `\n\nTracking: ${orderDetails.trackingNumber}` : ''}`;
        break;
      case "delivered":
        statusMessage = `Your order #${orderDetails.orderId} has been delivered! 🎉\n\nEnjoy your Aboriginal art piece!`;
        break;
      case "cancelled":
        statusMessage = `Your order #${orderDetails.orderId} has been cancelled. Refund will be processed within 3-5 business days. 💰`;
        break;
      default:
        statusMessage = `Order #${orderDetails.orderId} status updated to: ${orderDetails.status}`;
    }

    const message = `
🎨 Aboriginal Art Marketplace

${statusMessage}

Track: ${process.env.FRONTEND_URL || 'https://yourwebsite.com'}/orders/${orderDetails.orderId}
    `.trim();

    const result = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phoneNumber
    });

    console.log(`✅ Status update SMS sent to ${phoneNumber}. SID: ${result.sid}`);
    
    return {
      success: true,
      messageSid: result.sid,
      message: "SMS sent successfully"
    };
  } catch (error) {
    console.error("❌ SMS sending error:", error.message);
    return {
      success: false,
      message: error.message || "Failed to send SMS"
    };
  }
};

// Send SMS to Seller for New Order
const sendSellerOrderNotificationSMS = async (phoneNumber, orderDetails) => {
  try {
    if (!twilioClient) {
      console.log("⚠️  Twilio not configured. SMS skipped.");
      return { success: false, message: "SMS service not configured" };
    }

    const message = `
🎨 New Order Received!

Order ID: ${orderDetails.orderId}
Products: ${orderDetails.productCount}
Total: $${orderDetails.totalAmount.toFixed(2)}

Login to your seller dashboard to process this order.

${process.env.SELLER_DASHBOARD_URL || 'https://yourwebsite.com/seller/orders'}
    `.trim();

    const result = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phoneNumber
    });

    console.log(`✅ Seller notification SMS sent to ${phoneNumber}. SID: ${result.sid}`);
    
    return {
      success: true,
      messageSid: result.sid,
      message: "SMS sent successfully"
    };
  } catch (error) {
    console.error("❌ SMS sending error:", error.message);
    return {
      success: false,
      message: error.message || "Failed to send SMS"
    };
  }
};

module.exports = {
  sendOrderConfirmationSMS,
  sendOrderStatusSMS,
  sendSellerOrderNotificationSMS
};

