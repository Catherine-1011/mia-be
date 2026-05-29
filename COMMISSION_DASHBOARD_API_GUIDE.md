# Commission Dashboard API Documentation

## 📊 **Correct API Endpoints for Dashboard**

### 1. **Main Commission Dashboard Data**
```
GET /api/commissions/earned/my
```

**Use this for**: Commission records table, lifetime statistics, and detailed breakdowns.

**Response Format**:
```json
{
  "success": true,
  "data": [...], // Individual commission records
  "totals": {
    "totalOrderValue": 35709.80,        // Gross Sales
    "totalCommissionDeducted": 3570.96, // Platform Fee
    "totalNetPayable": 30478.34,        // Total Net Payable (excludes CANCELLED)
    "totalPaid": 30478.34,             // Total Paid Out  
    "totalPending": 0.00,               // Total Pending
    "redeemableAmount": 0.00,           // Redeemable Now
    "cancelledAmount": 1660.50,         // Cancelled Orders (NEW FIELD)
    "lockedAmount": 0.00,               // Locked (always 0)
    "eligibleOrderCount": 0             // Pending Order Count
  },
  "pagination": {...}
}
```

### 2. **Payout Wallet Widget**
```
GET /api/commissions/payout/redeemable
```

**Use this for**: Payout wallet summary at top of page.

**Response Format**:
```json
{
  "success": true,
  "summary": {
    "totalPending": 0.00,           // Total Pending
    "redeemableAmount": 0.00,       // Redeemable Now
    "lockedAmount": 0.00,           // Locked (always 0)  
    "totalPaid": 30478.34,         // Total Paid Out
    "cancelledAmount": 1660.50,    // Cancelled Amount (NEW FIELD)
    "eligibleOrderCount": 0         // Eligible Orders
  },
  "pendingPayoutRequest": null      // Current pending payout
}
```

## 🎨 **Frontend Dashboard Layout**

### **Top Payout Wallet Section**
```jsx
// ✅ CORRECT - Use API values directly
<PayoutWallet>
  <Stat label="Total Pending" value={summary.totalPending} color="gray" />
  <Stat label="Redeemable Now" value={summary.redeemableAmount} color="green" />
  <Stat label="Locked" value={summary.lockedAmount} color="orange" />
  <Stat label="Total Paid Out" value={summary.totalPaid} color="blue" />
</PayoutWallet>

// 🆕 OPTIONAL - Show cancelled separately  
{summary.cancelledAmount > 0 && (
  <Alert type="info">
    ${summary.cancelledAmount.toFixed(2)} in cancelled orders (not included in totals)
  </Alert>
)}
```

### **Commission Records Section**
```jsx
// ✅ CORRECT - Use API totals
<CommissionSummary>
  <Card title="Gross Sales" value={totals.totalOrderValue} icon="📈" />
  <Card title="Commission Deducted" value={totals.totalCommissionDeducted} icon="%" />
  <Card title="Total Net Payable" value={totals.totalNetPayable} icon="$" />
  <Card title="Pending Payout" value={totals.totalPending} icon="⏳" />
</CommissionSummary>

// Bottom summary bar
<SummaryBar>
  Gross Sales: ${totals.totalOrderValue.toFixed(2)} - 
  Commission: ${totals.totalCommissionDeducted.toFixed(2)} = 
  Net Payable: ${totals.totalNetPayable.toFixed(2)} | 
  Paid out: ${totals.totalPaid.toFixed(2)}
</SummaryBar>
```

## ❌ **AVOID Frontend Calculations**

### **DON'T Calculate These in Frontend:**
```jsx
// ❌ WRONG - Don't calculate totals in frontend
const totalNetPayable = commissionRecords.reduce((sum, record) => 
  sum + record.netPayable, 0);

// ❌ WRONG - Don't calculate redeemable amount  
const redeemableAmount = commissionRecords
  .filter(r => r.status === 'PENDING')
  .reduce((sum, record) => sum + record.netPayable, 0);

// ❌ WRONG - Don't calculate paid amount
const totalPaid = commissionRecords
  .filter(r => r.status === 'PAID')
  .reduce((sum, record) => sum + record.netPayable, 0);
```

### **✅ DO Use API Values:**
```jsx
// ✅ CORRECT - Use backend-calculated totals
const { totals } = await api.getCommissionRecords();
const { summary } = await api.getPayoutSummary();

// Display directly from API
<DisplayValue>{totals.totalNetPayable}</DisplayValue>
<DisplayValue>{summary.redeemableAmount}</DisplayValue>
<DisplayValue>{summary.totalPaid}</DisplayValue>
```

## 🔍 **Field Explanations**

| Field | Description | Where Used | Status Calculation |
|-------|-------------|------------|-------------------|
| `totalOrderValue` | Gross sales before commission | Main dashboard | Includes all order values |
| `totalCommissionDeducted` | Platform fees deducted | Main dashboard | Commission amounts taken |
| `totalNetPayable` | What seller should receive | Main dashboard | **Excludes CANCELLED orders** |
| `totalPaid` | Amount already paid out | Both widgets | Only PAID status records |
| `totalPending` | Amount ready for payout | Both widgets | Only PENDING status records |
| `redeemableAmount` | Available for immediate payout | Payout wallet | Same as totalPending |
| `cancelledAmount` | Cancelled order amounts | Info display | Only CANCELLED status records |
| `eligibleOrderCount` | Number of pending orders | Counters | Count of PENDING records |

## 🚨 **Critical Implementation Notes**

### **1. Status Handling**
```jsx
// Commission statuses and what they mean:
// PENDING  = Ready for payout (included in redeemable)
// PAID     = Already paid out (included in totalPaid)  
// CANCELLED = Order cancelled (excluded from totals, shown separately)
```

### **2. Math Validation**
```jsx
// ✅ This should ALWAYS be true:
totalNetPayable === totalPaid + totalPending

// If not true, there's a backend bug or data inconsistency
if (Math.abs(totals.totalNetPayable - (totals.totalPaid + totals.totalPending)) > 0.01) {
  console.error('Commission calculation mismatch detected');
  // Show error to admin
}
```

### **3. Cancelled Orders Display**
```jsx
// Show cancelled amounts for transparency but don't include in main totals
{totals.cancelledAmount > 0 && (
  <InfoBox type="neutral">
    <Icon name="info" />
    ${totals.cancelledAmount.toFixed(2)} from cancelled orders
    <small>Not included in payout calculations</small>
  </InfoBox>
)}
```

## 📱 **Mobile Responsive Considerations**

```jsx
// Stack widgets vertically on mobile
<ResponsiveGrid>
  <PayoutWallet />
  <QuickStats />
  <CommissionTable />
</ResponsiveGrid>

// Simplify mobile display
<MobileView>
  <Stat label="Available" value={summary.redeemableAmount} primary />
  <Stat label="Paid Out" value={summary.totalPaid} />
  <ActionButton>Request Payout</ActionButton>
</MobileView>
```

## 🛠️ **Testing Your Implementation**

### **API Test Commands**
```bash
# Test main commission endpoint
curl -X GET "http://localhost:3000/api/commissions/earned/my" \
  -H "Authorization: Bearer YOUR_TOKEN"

# Test payout summary endpoint  
curl -X GET "http://localhost:3000/api/commissions/payout/redeemable" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### **Frontend Validation**
```jsx
// Add this validation in development
useEffect(() => {
  if (process.env.NODE_ENV === 'development') {
    const sum = totals.totalPaid + totals.totalPending;
    const diff = Math.abs(totals.totalNetPayable - sum);
    if (diff > 0.01) {
      console.warn(`Commission math error: ${totals.totalNetPayable} ≠ ${sum}`);
    }
  }
}, [totals]);
```

## 🎯 **Key Takeaway**

**NEVER calculate commission totals in the frontend.** Always use the API-provided values from:
- `/api/commissions/earned/my` for detailed breakdowns
- `/api/commissions/payout/redeemable` for payout wallet

This ensures your dashboard shows the same mathematically correct values that our backend fixes provide.

---
*Last Updated: May 2026 - After fixing payout bug and dashboard calculation issues*