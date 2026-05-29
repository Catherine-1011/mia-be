/**
 * Investigate the specific cancelled commission records for the user
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ log: [] });

async function investigateCancelledCommissions() {
  const sellerId = 'cmk6mxvql0003qk5xtcgzryqd';

  console.log("🔍 Investigating Your Cancelled Commission Records");
  console.log("═══════════════════════════════════════════════════════");

  try {
    // Get detailed info about cancelled commissions
    const cancelledRecords = await prisma.$queryRaw`
      SELECT 
        ce.id,
        ce.order_id,
        ce.sub_order_id,
        ce.customer_name,
        ce.order_value::float,
        ce.commission_rate::float,
        ce.commission_amount::float,
        ce.net_payable::float,
        ce.status,
        ce.created_at,
        ce.updated_at,
        -- Try to get order details
        o.status as order_status,
        o."displayId" as display_order_id
      FROM commission_earned ce
      LEFT JOIN orders o ON o.id = ce.order_id
      WHERE ce.seller_id = ${sellerId} 
        AND ce.status = 'CANCELLED'
      ORDER BY ce.created_at DESC
    `;

    console.log(`📋 Found ${cancelledRecords.length} cancelled commission records:\n`);

    let totalCancelledAmount = 0;

    cancelledRecords.forEach((record, index) => {
      const orderValue = parseFloat(record.order_value || 0);
      const commissionRate = parseFloat(record.commission_rate || 0);
      const netPayable = parseFloat(record.net_payable || 0);
      const createdDate = new Date(record.created_at).toLocaleDateString();
      const updatedDate = new Date(record.updated_at).toLocaleDateString();
      
      totalCancelledAmount += netPayable;

      console.log(`${index + 1}. Order: ${record.display_order_id || record.order_id}`);
      console.log(`   Customer: ${record.customer_name || 'Unknown'}`);
      console.log(`   Order Value: $${orderValue.toFixed(2)}`);
      console.log(`   Commission Rate: ${commissionRate.toFixed(2)}%`);
      console.log(`   Your Commission: $${netPayable.toFixed(2)}`);
      console.log(`   Order Status: ${record.order_status || 'Unknown'}`);
      console.log(`   Commission Created: ${createdDate}`);
      console.log(`   Commission Cancelled: ${updatedDate}`);
      console.log('');
    });

    console.log(`💰 Total Cancelled Commission: $${totalCancelledAmount.toFixed(2)}`);

    // Check if these orders still exist and their current status
    console.log(`\n🔍 Checking current order statuses...`);
    
    const orderIds = cancelledRecords.map(r => r.order_id).filter(Boolean);
    if (orderIds.length > 0) {
      const currentOrderStatuses = await prisma.$queryRaw`
        SELECT 
          id,
          "displayId",
          status,
          "totalAmount"::float as total_amount,
          created_at,
          updated_at
        FROM orders 
        WHERE id = ANY(${orderIds})
      `;

      console.log(`📊 Current Order Status Check:`);
      currentOrderStatuses.forEach(order => {
        const matchingCommission = cancelledRecords.find(c => c.order_id === order.id);
        console.log(`   Order ${order.displayId}: ${order.status} (Total: $${order.total_amount?.toFixed(2) || 'N/A'})`);
        console.log(`     Commission was: $${parseFloat(matchingCommission?.net_payable || 0).toFixed(2)}`);
      });
    }

    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`💡 WHAT THIS MEANS:`);
    console.log(`   ❌ These orders were completed initially (you earned commission)`);
    console.log(`   🔄 Later, the orders were cancelled/refunded for some reason`);
    console.log(`   💸 Your commission was revoked since the sale didn't stick`);
    console.log(`   📊 This $${totalCancelledAmount.toFixed(2)} is not available for payout`);
    console.log(`   ✅ This is normal business practice - no commission on failed sales`);

    console.log(`\n🔍 Common reasons for cancellation:`);
    console.log(`   • Customer requested refund after delivery`);
    console.log(`   • Payment was disputed/charged back`);
    console.log(`   • Product was returned due to defects`);
    console.log(`   • Order was flagged for fraud`);
    console.log(`   • Admin cancelled due to policy violations`);

  } catch (error) {
    console.error("❌ Investigation failed:", error);
  } finally {
    await prisma.$disconnect();
  }
}

investigateCancelledCommissions();