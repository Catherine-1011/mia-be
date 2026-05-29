# Admin Analytics API Updates - Frontend Integration Guide

## Overview
Two admin analytics endpoints have been updated with date filtering capabilities. Both APIs now accept `startDate` and `endDate` query parameters and default to the last 30 days when no dates are provided.

---

## 1. Sales Analytics API

### Endpoint
```
GET /api/admin/sales/analytics?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
```

### Purpose
Comprehensive sales analytics with business metrics and summaries.

### Request Parameters
- `startDate` (optional): Start date in YYYY-MM-DD format
- `endDate` (optional): End date in YYYY-MM-DD format
- **Default**: Last 30 days if no dates provided

### Response Structure
```json
{
  "success": true,
  "analytics": {
    "totalRevenue": "12450.75",
    "totalOrders": 85,
    "totalItemsSold": 142,
    "averageOrderValue": "146.48",
    "statusBreakdown": {
      "PENDING": 5,
      "CONFIRMED": 12,
      "PROCESSING": 8,
      "SHIPPED": 15,
      "DELIVERED": 35,
      "CANCELLED": 7,
      "REFUND": 2,
      "PARTIAL_REFUND": 1
    },
    "topProducts": [
      {
        "productId": "123",
        "title": "Product Name",
        "sellerId": "sel_456",
        "sellerName": "Store Name",
        "quantity": 25,
        "revenue": 1250.00
      }
    ],
    "period": {
      "startDate": "2024-01-01",
      "endDate": "2024-01-31"
    }
  }
}
```

### Frontend Integration Example
```javascript
// Fetch sales analytics with date range
const fetchSalesAnalytics = async (startDate, endDate) => {
  try {
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    
    const response = await fetch(`/api/admin/sales/analytics?${params}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    const data = await response.json();
    if (data.success) {
      return data.analytics;
    }
    throw new Error(data.message);
  } catch (error) {
    console.error('Sales analytics error:', error);
    throw error;
  }
};

// Usage examples
const last30Days = await fetchSalesAnalytics(); // Default last 30 days
const january2024 = await fetchSalesAnalytics('2024-01-01', '2024-01-31');
const lastWeek = await fetchSalesAnalytics('2024-01-15', '2024-01-22');
```

---

## 2. Revenue Chart API

### Endpoint
```
GET /api/admin/analytics/revenue-chart?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
```

### Purpose
Time-series data for revenue/order charts visualization.

### Request Parameters
- `startDate` (optional): Start date in YYYY-MM-DD format
- `endDate` (optional): End date in YYYY-MM-DD format
- **Default**: Last 30 days if no dates provided

### Response Structure
```json
{
  "success": true,
  "period": {
    "startDate": "2024-01-01",
    "endDate": "2024-01-31",
    "groupBy": "day"
  },
  "note": "Revenue and order counts are based on all orders from the date they were placed (createdAt).",
  "data": [
    {
      "date": "2024-01-01",
      "orders": 5,
      "revenue": 1250.00
    },
    {
      "date": "2024-01-02",
      "orders": 3,
      "revenue": 875.50
    }
  ]
}
```

### Grouping Logic
- **Daily data**: For date ranges ≤ 90 days
- **Monthly data**: For date ranges > 90 days

**Note**: Both APIs now track all orders from when they were placed (createdAt), ensuring consistent data between analytics and charts.

### Frontend Integration Example
```javascript
// Fetch revenue chart data
const fetchRevenueChart = async (startDate, endDate) => {
  try {
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    
    const response = await fetch(`/api/admin/analytics/revenue-chart?${params}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    const data = await response.json();
    if (data.success) {
      return data;
    }
    throw new Error(data.message);
  } catch (error) {
    console.error('Revenue chart error:', error);
    throw error;
  }
};

// Chart.js integration example
const renderRevenueChart = async (chartRef, startDate, endDate) => {
  const chartData = await fetchRevenueChart(startDate, endDate);
  
  const config = {
    type: 'line',
    data: {
      labels: chartData.data.map(item => item.date),
      datasets: [
        {
          label: 'Revenue',
          data: chartData.data.map(item => item.revenue),
          borderColor: 'rgb(75, 192, 192)',
          backgroundColor: 'rgba(75, 192, 192, 0.1)',
          yAxisID: 'y'
        },
        {
          label: 'Orders',
          data: chartData.data.map(item => item.orders),
          borderColor: 'rgb(255, 99, 132)',
          backgroundColor: 'rgba(255, 99, 132, 0.1)',
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      scales: {
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          title: { display: true, text: 'Revenue ($)' }
        },
        y1: {
          type: 'linear',
          display: true,
          position: 'right',
          title: { display: true, text: 'Orders' },
          grid: { drawOnChartArea: false }
        }
      }
    }
  };
  
  chartRef.current = new Chart(canvas, config);
};
```

---

## Frontend UI Components Needed

### 1. Date Range Picker Component
```jsx
const DateRangePicker = ({ onDateChange, defaultDays = 30 }) => {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  
  // Set default dates (last N days)
  useEffect(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - defaultDays);
    
    setStartDate(start.toISOString().split('T')[0]);
    setEndDate(end.toISOString().split('T')[0]);
  }, [defaultDays]);
  
  const handleDateChange = () => {
    onDateChange(startDate, endDate);
  };
  
  return (
    <div className="date-range-picker">
      <input 
        type="date" 
        value={startDate}
        onChange={(e) => setStartDate(e.target.value)}
        max={endDate}
      />
      <input 
        type="date" 
        value={endDate}
        onChange={(e) => setEndDate(e.target.value)}
        min={startDate}
      />
      <button onClick={handleDateChange}>Apply</button>
    </div>
  );
};
```

### 2. Quick Date Presets
```jsx
const DatePresets = ({ onPresetSelect }) => {
  const presets = [
    { label: 'Last 7 days', days: 7 },
    { label: 'Last 30 days', days: 30 },
    { label: 'Last 90 days', days: 90 },
    { label: 'This year', custom: true, startDate: '2024-01-01', endDate: '2024-12-31' }
  ];
  
  const handlePresetClick = (preset) => {
    if (preset.custom) {
      onPresetSelect(preset.startDate, preset.endDate);
    } else {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - preset.days);
      
      onPresetSelect(
        start.toISOString().split('T')[0],
        end.toISOString().split('T')[0]
      );
    }
  };
  
  return (
    <div className="date-presets">
      {presets.map((preset) => (
        <button 
          key={preset.label}
          onClick={() => handlePresetClick(preset)}
        >
          {preset.label}
        </button>
      ))}
    </div>
  );
};
```

---

## Error Handling

### Common Error Responses
```json
{
  "success": false,
  "message": "Invalid date format. Use YYYY-MM-DD format."
}

{
  "success": false,
  "message": "Start date cannot be after end date."
}

{
  "message": "Access denied. Admins only."
}
```

### Frontend Error Handling
```javascript
const handleApiError = (error) => {
  if (error.message?.includes('date format')) {
    showToast('Please use valid date format (YYYY-MM-DD)', 'error');
  } else if (error.message?.includes('Access denied')) {
    redirectToLogin();
  } else {
    showToast('An error occurred while fetching data', 'error');
  }
};
```

---

## Complete Dashboard Integration Example

```jsx
const AdminAnalyticsDashboard = () => {
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const [salesData, setSalesData] = useState(null);
  const [chartData, setChartData] = useState(null);
  const [loading, setLoading] = useState(false);
  
  const fetchDashboardData = async (startDate, endDate) => {
    setLoading(true);
    try {
      const [sales, chart] = await Promise.all([
        fetchSalesAnalytics(startDate, endDate),
        fetchRevenueChart(startDate, endDate)
      ]);
      
      setSalesData(sales);
      setChartData(chart);
      setDateRange({ start: startDate, end: endDate });
    } catch (error) {
      handleApiError(error);
    } finally {
      setLoading(false);
    }
  };
  
  // Load last 30 days on mount
  useEffect(() => {
    const end = new Date().toISOString().split('T')[0];
    const start = new Date();
    start.setDate(start.getDate() - 30);
    const startDate = start.toISOString().split('T')[0];
    
    fetchDashboardData(startDate, end);
  }, []);
  
  return (
    <div className="analytics-dashboard">
      <DateRangePicker onDateChange={fetchDashboardData} />
      <DatePresets onPresetSelect={fetchDashboardData} />
      
      {loading ? (
        <LoadingSpinner />
      ) : (
        <>
          <SalesMetrics data={salesData} />
          <RevenueChart data={chartData} />
        </>
      )}
    </div>
  );
};
```

---

## Migration Notes

### Existing API Calls
- Both APIs maintain backward compatibility
- No date parameters = defaults to last 30 days (previous behavior was all-time data)
- **Action Required**: Update existing calls if you need all-time data instead of 30-day default

### New Features Available
1. **Custom date ranges** for better analytics control
2. **Period information** included in responses
3. **Consistent 30-day defaults** across both endpoints
4. **Smart grouping** in chart API (daily vs monthly based on range)

### Testing
```bash
# Test sales analytics
curl "http://localhost:3000/api/admin/sales/analytics?startDate=2024-01-01&endDate=2024-01-31" \
  -H "Authorization: Bearer YOUR_TOKEN"

# Test revenue chart
curl "http://localhost:3000/api/admin/analytics/revenue-chart?startDate=2024-01-01&endDate=2024-01-31" \
  -H "Authorization: Bearer YOUR_TOKEN"
```