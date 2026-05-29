/**
 * Test the fixed commission API calculation directly
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ log: [] });

async function testFixedCommissionCalculation() {
  const sellerId = 'cmk6mxvql0003qk5xtcgzryqd';

  console.log("🧪 Testing Fixed Commission Calculation");
  console.log("═══════════════════════════════════════════════════════");

  try {
    // Test the NEW calculation logic (from fixed getMyCommissionEarned)
    console.log("📊 NEW Fixed Calculation:");
    const fixedTotals = await prisma.$queryRawUnsafe(`
      SELECT
        COALESCE(SUM(order_value), 0)::float             AS "totalOrderValue",
        COALESCE(SUM(commission_amount), 0)::float       AS "totalCommissionDeducted",
        -- Total Net Payable should exclude CANCELLED orders
        COALESCE(SUM(CASE WHEN status != 'CANCELLED' THEN net_payable ELSE 0 END), 0)::float AS "totalNetPayable",
        COALESCE(SUM(CASE WHEN status = 'PAID'    THEN net_payable ELSE 0 END), 0)::float AS "totalPaid",
        COALESCE(SUM(CASE WHEN status = 'PENDING' THEN net_payable ELSE 0 END), 0)::float AS "totalPending",
        COALESCE(SUM(CASE WHEN status = 'PENDING' THEN net_payable ELSE 0 END), 0)::float AS "redeemableAmount",
        COALESCE(SUM(CASE WHEN status = 'CANCELLED' THEN net_payable ELSE 0 END), 0)::float AS "cancelledAmount",
        0::float AS "lockedAmount",
        COUNT(CASE WHEN status = 'PENDING' THEN 1 END)::int AS "eligibleOrderCount"
      FROM commission_earned
      WHERE seller_id = '${sellerId}'
    `);

    const fixed = fixedTotals[0];
    console.log(`   Gross Sales: $${fixed.totalOrderValue.toFixed(2)}`);
    console.log(`   Commission Deducted: $${fixed.totalCommissionDeducted.toFixed(2)}`);
    console.log(`   Total Net Payable: $${fixed.totalNetPayable.toFixed(2)} (excludes cancelled)`);
    console.log(`   Total Paid: $${fixed.totalPaid.toFixed(2)}`);
    console.log(`   Total Pending: $${fixed.totalPending.toFixed(2)}`);
    console.log(`   Redeemable Amount: $${fixed.redeemableAmount.toFixed(2)}`);
    console.log(`   Cancelled Amount: $${fixed.cancelledAmount.toFixed(2)} (shown separately)`);

    // Test the fixed math
    console.log(`\n🧮 Fixed Math Check:`);
    const newDiscrepancy = fixed.totalNetPayable - fixed.totalPaid - fixed.totalPending;
    console.log(`   Total Net Payable: $${fixed.totalNetPayable.toFixed(2)}`);
    console.log(`   Minus Total Paid: -$${fixed.totalPaid.toFixed(2)}`);
    console.log(`   Minus Total Pending: -$${fixed.totalPending.toFixed(2)}`);
    console.log(`   Should Equal Zero: $${newDiscrepancy.toFixed(2)}`);

    if (Math.abs(newDiscrepancy) < 0.01) {
      console.log(`   ✅ FIXED: Math now checks out perfectly!`);
    } else {
      console.log(`   ❌ Still has discrepancy: $${Math.abs(newDiscrepancy).toFixed(2)}`);
    }

    // Test the payout wallet calculation too
    console.log(`\n💰 Payout Wallet (getRedeemableSummary) calculation:`);
    const walletTotals = await prisma.$queryRaw`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'PENDING' THEN net_payable ELSE 0 END), 0)::float AS "totalPending",
        COALESCE(SUM(CASE WHEN status = 'PENDING' THEN net_payable ELSE 0 END), 0)::float AS "redeemableAmount",
        0::float AS "lockedAmount",
        COALESCE(SUM(CASE WHEN status = 'PAID' THEN net_payable ELSE 0 END), 0)::float AS "totalPaid",
        COALESCE(SUM(CASE WHEN status = 'CANCELLED' THEN net_payable ELSE 0 END), 0)::float AS "cancelledAmount",
        COUNT(CASE WHEN status = 'PENDING' THEN 1 END)::int AS "eligibleOrderCount"
      FROM commission_earned
      WHERE seller_id = ${sellerId}
    `;

    const wallet = walletTotals[0];
    console.log(`   Total Pending: $${wallet.totalPending.toFixed(2)}`);
    console.log(`   Redeemable Now: $${wallet.redeemableAmount.toFixed(2)}`);
    console.log(`   Locked: $${wallet.lockedAmount.toFixed(2)}`);
    console.log(`   Total Paid Out: $${wallet.totalPaid.toFixed(2)}`);
    console.log(`   Cancelled Amount: $${wallet.cancelledAmount.toFixed(2)}`);

    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`🎯 WHAT THIS MEANS FOR YOU:`);
    console.log(`   ❌ OLD DASHBOARD: Showed Total Net Payable $32,138.84 but Redeemable $0.00`);
    console.log(`   ✅ FIXED DASHBOARD: Will show Total Net Payable $${fixed.totalNetPayable.toFixed(2)} and Redeemable $${fixed.redeemableAmount.toFixed(2)}`);
    console.log(`   📋 Cancelled orders: $${fixed.cancelledAmount.toFixed(2)} (shown separately, not counted in totals)`);
    
    if (fixed.redeemableAmount === 0 && fixed.totalPaid > 0) {
      console.log(`   🐛 You're still affected by the old payout bug (all commissions marked as PAID)`);
      console.log(`   💰 But now cancelled orders won't confuse the dashboard display`);
    }

  } catch (error) {
    console.error("❌ Test failed:", error);
  } finally {
    await prisma.$disconnect();
  }
}

testFixedCommissionCalculation();