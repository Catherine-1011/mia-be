# Monthly GST Transaction Summary - Frontend Integration Guide

## 📡 API Endpoint
`GET /admin/sales/gst-report`

### Query Parameters (Optional)
- `month` (number): 1-12 (e.g., `3` for March).
- `year` (number): e.g., `2026`.
*If omitted, the API defaults to the current month and year.*

---

## 📦 API Response Reference

The API returns a highly structured, analysis-ready JSON payload matching the exact table layouts discussed earlier.

```json
{
  "success": true,
  "report": {
    "period": {
      "month": 3,
      "year": 2026,
      "startDate": "2026-03-01T00:00:00.000Z",
      "endDate": "2026-03-31T23:59:59.999Z"
    },
    "executiveSummary": {
      "totalOrders": 1247,
      "grossRevenue": 148750.00,
      "netRevenue": 135227.27,
      "gstCollected": 13522.73
    },
    "trend": {
      "prevOrders": 1089,
      "prevNetRevenue": 121818.18,
      "prevGstCollected": 12181.82,
      "growthPercentage": 18.5
    },
    "gstBreakdown": [
      {
        "rate": 10,
        "transactions": 1180,
        "netAmount": 130454.55,
        "gstAmount": 13045.45,
        "grossAmount": 143500.00
      }
    ],
    "paymentMethods": [
      {
        "method": "Stripe",
        "transactions": 456,
        "netAmount": 52272.73,
        "gstAmount": 5227.27,
        "grossAmount": 57500.00,
        "fees": 1725.00,
        "netReceived": 55775.00
      }
    ],
    "topSellers": [
      {
        "sellerName": "ArtCraft Studio",
        "orders": 156,
        "netSales": 14545.45,
        "gstCollected": 1454.55
      }
    ],
    "transactions": [
      {
        "orderId": "ORD-A1B2C3",
        "date": "2026-03-15T14:32:00.000Z",
        "customerName": "John Smith",
        "paymentMethod": "Stripe",
        "netAmount": 45.45,
        "gstRate": 10,
        "gstAmount": 4.55,
        "totalAmount": 50.00,
        "status": "DELIVERED",
        "ref": "pi_1a2b3c4d"
      }
    ]
  }
}
```

---

## 💻 Frontend Implementation (React/Next.js Example)

### 1. Data Fetching Hook
```typescript
import { useState, useEffect } from 'react';
import axios from 'axios'; // Or your custom API client

export const useGstReport = (month: number, year: number) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchReport = async () => {
      setLoading(true);
      try {
        const response = await axios.get(`/admin/sales/gst-report`, {
          params: { month, year }
        });
        setData(response.data.report);
      } catch (error) {
        console.error("Failed to fetch GST report", error);
      } finally {
        setLoading(false);
      }
    };
    fetchReport();
  }, [month, year]);

  return { data, loading };
};
```

### 2. Format Currency Utility
Since the backend sends raw numbers, process them in the UI to format as Australian Dollars:
```javascript
const formatCurrency = (amount) => {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD'
  }).format(amount);
};
```

### 3. Dashboard Component Map

Map the JSON response directly to the tables we designed conceptually:

- **Executive Summary Cards**: Use `report.executiveSummary`. Combine with `report.trend.growthPercentage` to show month-over-month indicators (green up arrow if `> 0`).
- **GST Breakdown by Rate**: Iterate `report.gstBreakdown`.
- **Detailed Transaction Table**: Render rows from `report.transactions`. (Note: backend caps this at 1000 to prevent payload lag).
- **Payment Method Reconciliation**: Map `report.paymentMethods`. `fees` and `netReceived` provide the exact breakdown needed by your finance team for bank reconciliation.
- **Seller Performance**: Iterate `report.topSellers`.

### Important Notes
- **Authentication**: Ensure you send your admin Bearer token, as the endpoint requires `ADMIN` or `SUPER_ADMIN` privileges.
- **Calculations**: The API computes the GST retroactively on the total (`Gross / 1.1` style algorithm as outlined by ATO standards for standard 10% GST environments).