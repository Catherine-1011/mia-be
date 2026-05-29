// SLA Configuration for Order Management
const slaConfig = {
  ORDER_PROCESSING: {
    WARNING_HOURS: 2,
    CRITICAL_HOURS: 4,
    BREACH_HOURS: 6,
    DESCRIPTION: "Order confirmation and initial processing"
  },
  ORDER_CONFIRMATION: {
    WARNING_HOURS: 1,
    CRITICAL_HOURS: 2,
    BREACH_HOURS: 3,
    DESCRIPTION: "Order confirmation to customer"
  },
  SHIPPING_PREPARATION: {
    WARNING_HOURS: 12,
    CRITICAL_HOURS: 18,
    BREACH_HOURS: 24,
    DESCRIPTION: "Prepare items for shipping"
  },
  ORDER_SHIPPED: {
    WARNING_HOURS: 24,
    CRITICAL_HOURS: 36,
    BREACH_HOURS: 48,
    DESCRIPTION: "Ship order and provide tracking"
  },
  ORDER_DELIVERED: {
    WARNING_HOURS: 72,
    CRITICAL_HOURS: 96,
    BREACH_HOURS: 120,
    DESCRIPTION: "Complete order delivery"
  },
  PAYMENT_PENDING: {
    WARNING_HOURS: 6,
    CRITICAL_HOURS: 12,
    BREACH_HOURS: 24,
    DESCRIPTION: "Payment verification and processing"
  },
  STOCK_ALERT: {
    WARNING_HOURS: 4,
    CRITICAL_HOURS: 8,
    BREACH_HOURS: 12,
    DESCRIPTION: "Low stock inventory alert"
  }
};

// Get SLA configuration for a specific type
const getSLAConfig = (type) => {
  return slaConfig[type] || slaConfig.ORDER_PROCESSING;
};

// Calculate SLA deadline based on type
const calculateSLADeadline = (type, startTime = new Date()) => {
  const config = getSLAConfig(type);
  return new Date(startTime.getTime() + config.BREACH_HOURS * 60 * 60 * 1000);
};

// Calculate SLA status based on elapsed time
const calculateSLAStatus = (notification) => {
  const now = new Date();
  const created = new Date(notification.createdAt);
  const deadline = new Date(notification.slaDeadline);
  const config = getSLAConfig(notification.type);
  
  const timeElapsedHours = (now - created) / (1000 * 60 * 60);
  const timeRemainingHours = (deadline - now) / (1000 * 60 * 60);
  
  let status, indicator, priority;
  
  if (timeElapsedHours >= config.BREACH_HOURS || timeRemainingHours <= 0) {
    status = 'BREACHED';
    indicator = 'RED';
    priority = 'URGENT';
  } else if (timeElapsedHours >= config.CRITICAL_HOURS) {
    status = 'CRITICAL';
    indicator = 'ORANGE';
    priority = 'URGENT';
  } else if (timeElapsedHours >= config.WARNING_HOURS) {
    status = 'WARNING';
    indicator = 'YELLOW';
    priority = 'HIGH';
  } else {
    status = 'ON_TIME';
    indicator = 'GREEN';
    priority = 'MEDIUM';
  }
  
  return {
    status,
    indicator,
    priority,
    timeRemaining: Math.max(0, timeRemainingHours),
    timeElapsed: timeElapsedHours,
    isOverdue: timeRemainingHours <= 0,
    urgencyLevel: getUrgencyLevel(timeRemainingHours)
  };
};

// Get urgency level for prioritization
const getUrgencyLevel = (hoursRemaining) => {
  if (hoursRemaining <= 0) return 5; // Overdue
  if (hoursRemaining <= 1) return 4; // Very urgent
  if (hoursRemaining <= 4) return 3; // Urgent
  if (hoursRemaining <= 12) return 2; // Soon
  return 1; // Normal
};

module.exports = {
  slaConfig,
  getSLAConfig,
  calculateSLADeadline,
  calculateSLAStatus,
  getUrgencyLevel
};