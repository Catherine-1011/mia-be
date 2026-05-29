const PDFDocument = require('pdfkit');

/**
 * Generates an invoice PDF buffer for any order.
 * Works for both logged-in user orders and guest orders.
 *
 * @param {Object} order
 * @param {string} order.displayId
 * @param {Date}   order.createdAt
 * @param {string} order.status
 * @param {string} order.customerName
 * @param {string} order.customerEmail
 * @param {string} [order.customerPhone]
 * @param {string} [order.shippingPhone]
 * @param {string} [order.shippingAddressLine]
 * @param {string} [order.shippingCity]
 * @param {string} [order.shippingState]
 * @param {string} [order.shippingZipCode]
 * @param {string} [order.shippingCountry]
 * @param {number} order.totalAmount
 * @param {number} [order.discountAmount]
 * @param {string} [order.couponCode]
 * @param {string} [order.paymentMethod]
 * @param {Array}  order.items  — each item: { price, quantity, product: { title } }
 * @returns {Promise<Buffer>}
 */
const generateInvoiceBuffer = (order) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Page Border ─────────────────────────────────────────────────────────
    // Draw a border around the entire page
    doc.rect(20, 20, doc.page.width - 40, doc.page.height - 40)
       .lineWidth(1)
       .stroke();

    // ── Header ──────────────────────────────────────────────────────────────
    doc.fontSize(20).text('Made in Arnhem Land', 50, 50)
       .fontSize(10).text('Your Cultural Marketplace', 50, 75).moveDown();

    // ── Invoice meta ────────────────────────────────────────────────────────
    doc.fontSize(16).text('INVOICE', 50, 120)
       .fontSize(12)
       .text(`Invoice #: ${order.displayId || order.id}`, 50, 145)
       .text(`Date: ${new Date(order.createdAt).toLocaleDateString('en-AU')}`, 50, 160)
       .text('Payment Method: Credit/Debit Card', 50, 175);

    // ── Bill To ─────────────────────────────────────────────────────────────
    doc.fontSize(14).text('Bill To:', 50, 210)
       .fontSize(12)
       .text(order.customerName || '', 50, 230)
       .text(order.customerEmail || '', 50, 245)
       .text(order.shippingPhone || order.customerPhone || '', 50, 260);

    // ── Ship To ─────────────────────────────────────────────────────────────
    doc.fontSize(14).text('Ship To:', 300, 210).fontSize(12);
    if (order.shippingAddressLine || order.shippingCity) {
      doc.text(order.shippingAddressLine || '', 300, 230)
         .text(`${order.shippingCity || ''}, ${order.shippingState || ''}`, 300, 245)
         .text(order.shippingZipCode || '', 300, 260)
         .text(order.shippingCountry || '', 300, 275);
    }

    // ── Items table ──────────────────────────────────────────────────────────
    const tableTop = 320;
    doc.fontSize(12)
       .text('Item',       50,  tableTop)
       .text('Quantity',  200, tableTop)
       .text('Unit Price',280, tableTop)
       .text('GST',       360, tableTop)
       .text('Total',     450, tableTop);
    doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

    // Extract gstPercentage from summary
    let gstPercentage = 10; // Default 10%
    const summary = order.shippingAddress?.orderSummary || order.parentOrder?.shippingAddress?.orderSummary;
    if (summary && summary.gstPercentage !== undefined) {
      gstPercentage = parseFloat(summary.gstPercentage) || 0;
    }

    let yPos = tableTop + 30;
    let subtotal = 0;
    (order.items || []).forEach(item => {
      const lineTotal = Number(item.price) * item.quantity;
      subtotal += lineTotal;
      
      // Build variant-aware title
      const baseTitle = item.product?.title || 'Product';
      let itemTitle = baseTitle;
      if (item.productVariant?.variantAttributeValues?.length) {
        const attrs = item.productVariant.variantAttributeValues
          .map(av => `${av.attributeValue?.attribute?.name}: ${av.attributeValue?.value}`)
          .filter(Boolean).join(', ');
        if (attrs) itemTitle = `${baseTitle} (${attrs})`;
      }

      // Calculate GST per line item (assuming price is GST inclusive)
      const gstAmount = gstPercentage > 0 ? (lineTotal * gstPercentage) / (100 + gstPercentage) : 0;
      const unitPriceExGST = Number(item.price) / (1 + gstPercentage / 100);
      doc.text(itemTitle,                         50, yPos)
         .text(String(item.quantity),             200, yPos)
         .text(`$${unitPriceExGST.toFixed(2)}`, 280, yPos)
         .text(`$${gstAmount.toFixed(2)} (${gstPercentage}%)`, 360, yPos)
         .text(`$${lineTotal.toFixed(2)}`,          450, yPos);
      yPos += 20;
    });

    yPos += 10;
    doc.moveTo(50, yPos).lineTo(550, yPos).stroke();
    yPos += 15;

    // ── Coupon / discount ────────────────────────────────────────────────────
    if (order.discountAmount && parseFloat(order.discountAmount) > 0) {
      doc.fontSize(12)
         .text(`Coupon (${order.couponCode || ''}) Discount:`, 300, yPos)
         .text(`-$${parseFloat(order.discountAmount).toFixed(2)}`, 450, yPos);
      yPos += 20;
    }

    // ── Totals ───────────────────────────────────────────────────────────────
    doc.fontSize(12)
       .text('Subtotal:',     350, yPos)
       .text(`$${subtotal.toFixed(2)}`, 450, yPos);
    yPos += 20;
    doc.fontSize(14)
       .text('Total Amount:', 350, yPos)
       .text(`$${Number(order.totalAmount).toFixed(2)}`, 450, yPos);

    // ── Footer ───────────────────────────────────────────────────────────────
    yPos += 60;
    doc.fontSize(10)
       .text('Thank you for your business!', 50, yPos)
       .text('For questions about this invoice, contact support@miamarketplace.com.au', 50, yPos + 15);

    doc.end();
  });
};

module.exports = { generateInvoiceBuffer };
