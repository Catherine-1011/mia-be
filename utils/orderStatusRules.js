const ORDER_STATUS_SEQUENCE = [
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED'
];

const TERMINAL_STATUSES = ['CANCELLED', 'REFUND', 'PARTIAL_REFUND'];

const STATUS_ALIASES = {
  confirmed: 'CONFIRMED',
  processing: 'PROCESSING',
  shipped: 'SHIPPED',
  delivered: 'DELIVERED',
  cancelled: 'CANCELLED',
  canceled: 'CANCELLED',
  refund: 'REFUND',
  refunded: 'REFUND',
  full_refund: 'REFUND',
  'full refund': 'REFUND',
  'full-refund': 'REFUND',
  fullrefund: 'REFUND',
  partial_refund: 'PARTIAL_REFUND',
  'partial refund': 'PARTIAL_REFUND',
  'partial-refund': 'PARTIAL_REFUND',
  partially_refunded: 'PARTIAL_REFUND',
  partiallyrefunded: 'PARTIAL_REFUND'
};

const VALID_TARGET_STATUSES = [...ORDER_STATUS_SEQUENCE, ...TERMINAL_STATUSES];

const normalizeOrderStatus = (status) => {
  if (!status || typeof status !== 'string') return null;

  const trimmed = status.trim();
  if (!trimmed) return null;

  const upper = trimmed.toUpperCase();
  if (VALID_TARGET_STATUSES.includes(upper)) {
    return upper;
  }

  return STATUS_ALIASES[trimmed.toLowerCase()] || null;
};

const validateStatusTransition = ({
  currentStatus,
  nextStatus,
  trackingNumber,
  estimatedDelivery,
  reason
}) => {
  if (!currentStatus || !nextStatus) {
    return {
      isValid: false,
      message: 'Current and target status are required.'
    };
  }

  if (currentStatus === nextStatus) {
    return {
      isValid: false,
      message: `Order is already in ${nextStatus} status.`
    };
  }

  if (TERMINAL_STATUSES.includes(currentStatus)) {
    return {
      isValid: false,
      message: `Order in ${currentStatus} status cannot be changed further.`
    };
  }

  const currentIndex = ORDER_STATUS_SEQUENCE.indexOf(currentStatus);
  const nextIndex = ORDER_STATUS_SEQUENCE.indexOf(nextStatus);

  if (nextIndex !== -1) {
    if (currentIndex === -1 || nextIndex !== currentIndex + 1) {
      return {
        isValid: false,
        message: `Invalid status transition from ${currentStatus} to ${nextStatus}. Allowed next status is ${ORDER_STATUS_SEQUENCE[currentIndex + 1] || 'none'}.`
      };
    }
  } else if (nextStatus === 'CANCELLED') {
    if (!['CONFIRMED', 'PROCESSING', 'SHIPPED'].includes(currentStatus)) {
      return {
        isValid: false,
        message: `Order cannot be cancelled from ${currentStatus} status.`
      };
    }
  } else if (nextStatus === 'REFUND' || nextStatus === 'PARTIAL_REFUND') {
    if (currentStatus !== 'DELIVERED') {
      return {
        isValid: false,
        message: `${nextStatus} can only be applied after DELIVERED status.`
      };
    }
  } else {
    return {
      isValid: false,
      message: 'Invalid status value.'
    };
  }

  if (nextStatus === 'SHIPPED') {
    if (!trackingNumber || typeof trackingNumber !== 'string' || !trackingNumber.trim()) {
      return {
        isValid: false,
        message: 'Tracking number is required when moving order to SHIPPED.'
      };
    }

    if (!estimatedDelivery) {
      return {
        isValid: false,
        message: 'Estimated delivery date is required when moving order to SHIPPED.'
      };
    }

    const parsedDate = new Date(estimatedDelivery);
    if (Number.isNaN(parsedDate.getTime())) {
      return {
        isValid: false,
        message: 'Estimated delivery must be a valid date.'
      };
    }
  }

  if (['CANCELLED', 'REFUND', 'PARTIAL_REFUND'].includes(nextStatus)) {
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return {
        isValid: false,
        message: `Reason is required when changing order status to ${nextStatus}.`
      };
    }
  }

  return { isValid: true };
};

module.exports = {
  ORDER_STATUS_SEQUENCE,
  TERMINAL_STATUSES,
  VALID_TARGET_STATUSES,
  normalizeOrderStatus,
  validateStatusTransition
};