const { Parser } = require('json2csv');

// Generate Sales Report CSV for Seller
const generateSalesReportCSV = (orders) => {
  try {
    const reportData = [];

    orders.forEach(order => {
      // Format order date
      let orderDate = 'N/A';
      try {
        if (order.createdAt) {
          if (order.createdAt.toDate) {
            // Firestore Timestamp
            orderDate = order.createdAt.toDate().toISOString().split('T')[0];
          } else if (order.createdAt instanceof Date) {
            orderDate = order.createdAt.toISOString().split('T')[0];
          } else if (typeof order.createdAt === 'string') {
            orderDate = new Date(order.createdAt).toISOString().split('T')[0];
          }
        }
      } catch (dateError) {
        console.error('Date formatting error:', dateError);
      }

      // Get seller's products from this order
      order.products.forEach(product => {
        reportData.push({
          'Order ID': order.id,
          'Order Date': orderDate,
          'Product Title': product.title || 'N/A',
          'Product ID': product.productId || 'N/A',
          'Quantity Sold': product.quantity || 0,
          'Unit Price': `$${(product.price || 0).toFixed(2)}`,
          'Total Amount': `$${((product.price || 0) * (product.quantity || 0)).toFixed(2)}`,
          'Order Status': order.status || 'N/A',
          'Payment Method': order.paymentMethod || 'N/A',
          'Customer Name': order.customerName || 'N/A',
          'Customer Phone': order.shippingPhone || order.customerPhone || order.shippingAddress?.phone || 'N/A',
          'Customer Email': order.customerEmail || 'N/A',
          'Shipping Address': order.shippingAddressLine || order.shippingAddress?.address || order.shippingAddress?.street || 'N/A',
          'Shipping City': order.shippingCity || order.shippingAddress?.city || 'N/A',
          'Shipping State': order.shippingState || order.shippingAddress?.state || 'N/A',
          'Shipping Pincode': order.shippingZipCode || order.shippingAddress?.pincode || order.shippingAddress?.zipCode || order.shippingAddress?.postalCode || 'N/A',
          'Shipping Country': order.shippingCountry || order.shippingAddress?.country || 'N/A',
          'Tracking Number': order.trackingNumber || 'Not shipped yet',
          'Estimated Delivery': order.estimatedDelivery || 'N/A'
        });
      });
    });

    const fields = [
      'Order ID',
      'Order Date',
      'Product Title',
      'Product ID',
      'Quantity Sold',
      'Unit Price',
      'Total Amount',
      'Order Status',
      'Payment Method',
      'Customer Name',
      'Customer Phone',
      'Customer Email',
      'Shipping Address',
      'Shipping City',
      'Shipping State',
      'Shipping Pincode',
      'Tracking Number',
      'Estimated Delivery'
    ];

    const parser = new Parser({ fields });
    const csv = parser.parse(reportData);

    return csv;
  } catch (error) {
    console.error("CSV generation error:", error);
    throw new Error("Failed to generate CSV report");
  }
};

// Generate Summary Sales Report
const generateSalesSummaryCSV = (orders, sellerId) => {
  try {
    const productSales = new Map();
    let totalRevenue = 0;
    let totalOrders = 0;
    let totalItemsSold = 0;

    orders.forEach(order => {
      order.products.forEach(product => {
        if (product.sellerId === sellerId) {
          const key = product.productId;
          
          if (!productSales.has(key)) {
            productSales.set(key, {
              title: product.title,
              quantitySold: 0,
              revenue: 0,
              orders: 0
            });
          }

          const productData = productSales.get(key);
          productData.quantitySold += product.quantity;
          productData.revenue += product.price * product.quantity;
          productData.orders += 1;

          totalRevenue += product.price * product.quantity;
          totalItemsSold += product.quantity;
        }
      });
      totalOrders += 1;
    });

    const summaryData = [];

    productSales.forEach((data, productId) => {
      summaryData.push({
        'Product ID': productId,
        'Product Title': data.title,
        'Total Quantity Sold': data.quantitySold,
        'Number of Orders': data.orders,
        'Total Revenue': `$${data.revenue.toFixed(2)}`,
        'Average Order Value': `$${(data.revenue / data.orders).toFixed(2)}`
      });
    });

    // Add summary row
    summaryData.push({
      'Product ID': 'TOTAL',
      'Product Title': 'Summary',
      'Total Quantity Sold': totalItemsSold,
      'Number of Orders': totalOrders,
      'Total Revenue': `$${totalRevenue.toFixed(2)}`,
      'Average Order Value': totalOrders > 0 ? `$${(totalRevenue / totalOrders).toFixed(2)}` : '$0.00'
    });

    const fields = [
      'Product ID',
      'Product Title',
      'Total Quantity Sold',
      'Number of Orders',
      'Total Revenue',
      'Average Order Value'
    ];

    const parser = new Parser({ fields });
    const csv = parser.parse(summaryData);

    return csv;
  } catch (error) {
    console.error("CSV summary generation error:", error);
    throw new Error("Failed to generate summary CSV");
  }
};

const generateGstReportCSV = (transactions) => {
  try {
    const reportData = transactions.map(t => ({
      'Order ID': t.orderId,
      'Date': t.date ? new Date(t.date).toISOString().split('T')[0] : 'N/A',
      'Time': t.date ? new Date(t.date).toISOString().split('T')[1].split('.')[0] : 'N/A',
      'Customer Name': t.customerName || 'N/A',
      'Payment Method': t.paymentMethod || 'N/A',
      'Status': t.status || 'N/A',
      'Gross Amount (inc. GST)': parseFloat(t.totalAmount || 0).toFixed(2),
      'GST Rate': `${t.gstRate || 0}%`,
      'GST Amount': parseFloat(t.gstAmount || 0).toFixed(2),
      'Net Amount (ex. GST)': parseFloat(t.netAmount || 0).toFixed(2),
      'Gateway Reference': t.ref || 'N/A'
    }));

    const parser = new Parser();
    return parser.parse(reportData);
  } catch (error) {
    console.error('Error generating GST CSV report:', error);
    throw new Error('Failed to generate GST CSV report.');
  }
};

module.exports = {
  generateSalesReportCSV,
  generateSalesSummaryCSV,
  generateGstReportCSV
};
