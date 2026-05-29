/**
 * Analyze the specific seller's commission breakdown to understand the dashboard discrepancy
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ log: [] });

async function analyzeSellerCommissions() {
  const sellerId = 'cmk6mxvql0003qk5xtcgzryqd'; // The user's seller ID we identified

  console.log("🔍 Analyzing Commission Breakdown for Seller Dashboard");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`Seller ID: ${sellerId}`);

  try {
    // 1. Get the exact same totals calculation as used in the dashboard
    const dashboardTotals = await prisma.$queryRawUnsafe(`
      SELECT
        COALESCE(SUM(order_value), 0)::float             AS "totalOrderValue",
        COALESCE(SUM(commission_amount), 0)::float       AS "totalCommissionDeducted",
        COALESCE(SUM(net_payable), 0)::float             AS "totalNetPayable",
        COALESCE(SUM(CASE WHEN status = 'PAID'    THEN net_payable ELSE 0 END), 0)::float AS "totalPaid",
        COALESCE(SUM(CASE WHEN status = 'PENDING' THEN net_payable ELSE 0 END), 0)::float AS "totalPending",
        COALESCE(SUM(CASE WHEN status = 'PENDING' THEN net_payable ELSE 0 END), 0)::float AS "redeemableAmount",
        0::float AS "lockedAmount",
        COUNT(CASE WHEN status = 'PENDING' THEN 1 END)::int AS "eligibleOrderCount"
      FROM commission_earned
      WHERE seller_id = '${sellerId}'
    `);

    console.log("\n📊 Dashboard Totals (from API):");
    const totals = dashboardTotals[0];
    console.log(`   Gross Sales: $${totals.totalOrderValue.toFixed(2)}`);
    console.log(`   Commission Deducted: $${totals.totalCommissionDeducted.toFixed(2)}`);
    console.log(`   Total Net Payable: $${totals.totalNetPayable.toFixed(2)}`);
    console.log(`   Total Paid: $${totals.totalPaid.toFixed(2)}`);
    console.log(`   Total Pending: $${totals.totalPending.toFixed(2)}`);
    console.log(`   Redeemable Amount: $${totals.redeemableAmount.toFixed(2)}`);
    console.log(`   Eligible Order Count: ${totals.eligibleOrderCount}`);

    // 2. Break down by status to find the missing amount
    console.log("\n🔍 Commission Status Breakdown:");
    const statusBreakdown = await prisma.$queryRaw`
      SELECT 
        status,
        COUNT(*) as record_count,
        COALESCE(SUM(net_payable), 0)::float as total_amount
      FROM commission_earned 
      WHERE seller_id = ${sellerId}
      GROUP BY status
      ORDER BY total_amount DESC
    `;

    let totalFromStatuses = 0;
    statusBreakdown.forEach(row => {
      const amount = parseFloat(row.total_amount);
      totalFromStatuses += amount;
      console.log(`   ${row.status}: ${row.record_count} records = $${amount.toFixed(2)}`);
    });

    console.log(`\n📋 Status Totals Sum: $${totalFromStatuses.toFixed(2)}`);

    // 3. Calculate the discrepancy
    const discrepancy = totals.totalNetPayable - totals.totalPaid - totals.totalPending;
    console.log(`\n🧮 Math Check:`);
    console.log(`   Total Net Payable: $${totals.totalNetPayable.toFixed(2)}`);
    console.log(`   Minus Total Paid: -$${totals.totalPaid.toFixed(2)}`);
    console.log(`   Minus Total Pending: -$${totals.totalPending.toFixed(2)}`);
    console.log(`   Should Equal Zero: $${discrepancy.toFixed(2)}`);

    if (Math.abs(discrepancy) > 0.01) {
      console.log(`   🚨 DISCREPANCY FOUND: $${Math.abs(discrepancy).toFixed(2)}`);
      
      // Find records that are neither PAID nor PENDING
      const otherStatuses = await prisma.$queryRaw`
        SELECT 
          status,
          COUNT(*) as count,
          COALESCE(SUM(net_payable), 0)::float as amount,
          array_agg(order_id) as order_ids
        FROM commission_earned 
        WHERE seller_id = ${sellerId} 
          AND status != 'PAID' 
          AND status != 'PENDING'
        GROUP BY status
      `;

      if (otherStatuses.length > 0) {
        console.log(`\n🔍 Found records with other statuses:`);
        otherStatuses.forEach(row => {
          console.log(`   ${row.status}: ${row.count} records = $${parseFloat(row.amount).toFixed(2)}`);
          console.log(`     Order IDs: ${row.order_ids.slice(0, 3).join(', ')}${row.order_ids.length > 3 ? '...' : ''}`);
        });
      }
    } else {
      console.log(`   ✅ Math checks out - no missing amounts in calculation`);
    }

    // 4. Check recent payout history for this seller
    console.log(`\n📈 Recent Payout History:`);
    const payouts = await prisma.$queryRaw`
      SELECT 
        id,
        requested_amount::float,
        redeemable_at_request::float,
        status,
        created_at,
        processed_at
      FROM payout_requests 
      WHERE seller_id = ${sellerId}
      ORDER BY created_at DESC
      LIMIT 5
    `;

    payouts.forEach(payout => {
      const date = new Date(payout.created_at).toLocaleDateString();
      console.log(`   ${date}: $${parseFloat(payout.requested_amount).toFixed(2)} (${payout.status}) - Had $${parseFloat(payout.redeemable_at_request || 0).toFixed(2)} redeemable`);
    });

    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`💡 CONCLUSION:`);
    
    if (Math.abs(discrepancy) > 0.01) {
      console.log(`   🚨 Dashboard calculation is incorrect!`);
      console.log(`   🔧 There are commission records with non-standard statuses`);
      console.log(`   💰 Missing amount: $${Math.abs(discrepancy).toFixed(2)}`);
    } else if (totals.totalPending === 0 && totals.totalPaid > 10000) {
      console.log(`   🐛 This seller was definitely affected by the old payout bug`);
      console.log(`   📊 All commissions were incorrectly marked as PAID`);
    } else {
      console.log(`   ✅ Dashboard calculations appear correct`);
    }

  } catch (error) {
    console.error("❌ Analysis failed:", error);
  } finally {
    await prisma.$disconnect();
  }
}

analyzeSellerCommissions();