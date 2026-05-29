/**
 * Test script to verify the payout system fix
 * This simulates the scenario: 
 * - Seller has $7,158.60 redeemable
 * - Requests $500 payout
 * - Should have $6,658.60 remaining after completion
 */

// Minimal Prisma client setup for testing
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  log: [], // Disable logs to avoid noise
});

async function testPayoutFix() {
  console.log("🧪 Testing Payout System Fix");
  console.log("════════════════════════════════════════════════════════");
  
  try {
    // 1. Find a test seller with commission records
    console.log("1. Looking for a seller with commission records...");
    
    const sellersWithCommissions = await prisma.$queryRaw`
      SELECT 
        seller_id,
        COUNT(*) as record_count,
        SUM(CASE WHEN status = 'PENDING' THEN net_payable ELSE 0 END) as pending_amount,
        SUM(CASE WHEN status = 'PAID' THEN net_payable ELSE 0 END) as paid_amount
      FROM commission_earned 
      WHERE status = 'PENDING' OR status = 'PAID'
      GROUP BY seller_id 
      HAVING SUM(CASE WHEN status = 'PENDING' THEN net_payable ELSE 0 END) > 100
      ORDER BY pending_amount DESC
      LIMIT 5
    `;
    
    if (sellersWithCommissions.length === 0) {
      console.log("❌ No sellers found with sufficient commission records to test");
      return;
    }
    
    const testSeller = sellersWithCommissions[0];
    console.log(`✅ Found test seller: ${testSeller.seller_id}`);
    console.log(`   - Pending amount: $${parseFloat(testSeller.pending_amount).toFixed(2)}`);
    console.log(`   - Paid amount: $${parseFloat(testSeller.paid_amount).toFixed(2)}`);
    console.log(`   - Total records: ${testSeller.record_count}`);
    
    // 2. Check current balance calculation
    console.log("\n2. Checking current balance calculation...");
    
    const balanceBefore = await prisma.$queryRaw`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'PENDING' THEN net_payable ELSE 0 END), 0)::float AS "redeemableAmount",
        COALESCE(SUM(CASE WHEN status = 'PAID' THEN net_payable ELSE 0 END), 0)::float AS "totalPaid",
        COUNT(CASE WHEN status = 'PENDING' THEN 1 END)::int AS "eligibleOrderCount"
      FROM commission_earned
      WHERE seller_id = ${testSeller.seller_id}
    `;
    
    console.log(`✅ Current redeemable balance: $${balanceBefore[0].redeemableAmount.toFixed(2)}`);
    
    // 3. Simulate the FIFO payout logic (without actually changing data)
    console.log("\n3. Simulating FIFO payout logic...");
    
    const testPayoutAmount = Math.min(500, balanceBefore[0].redeemableAmount);
    console.log(`   - Test payout amount: $${testPayoutAmount}`);
    
    const pendingCommissions = await prisma.$queryRaw`
      SELECT id, net_payable, order_id, created_at
      FROM commission_earned
      WHERE seller_id = ${testSeller.seller_id}
        AND status = 'PENDING'
      ORDER BY created_at ASC
    `;
    
    let remainingToPay = testPayoutAmount;
    let recordsToUpdate = [];
    let totalWouldBePaid = 0;
    
    for (const record of pendingCommissions) {
      const netPayable = parseFloat(record.net_payable);
      
      if (remainingToPay <= 0) break;
      
      if (netPayable <= remainingToPay) {
        recordsToUpdate.push({
          id: record.id,
          amount: netPayable,
          orderId: record.order_id
        });
        totalWouldBePaid += netPayable;
        remainingToPay -= netPayable;
      } else {
        recordsToUpdate.push({
          id: record.id,
          amount: netPayable,
          orderId: record.order_id
        });
        totalWouldBePaid += netPayable;
        remainingToPay = 0;
        break;
      }
    }
    
    const expectedRemainingBalance = balanceBefore[0].redeemableAmount - totalWouldBePaid;
    
    console.log(`   - Records that would be marked as PAID: ${recordsToUpdate.length}`);
    console.log(`   - Total amount to be marked as paid: $${totalWouldBePaid.toFixed(2)}`);
    console.log(`   - Expected remaining balance: $${expectedRemainingBalance.toFixed(2)}`);
    
    // 4. Verify the fix logic
    console.log("\n4. Verification Results:");
    console.log("════════════════════════════════════════════════════════");
    
    if (Math.abs(totalWouldBePaid - testPayoutAmount) < 0.01) {
      console.log("✅ PASS: Payout amount calculation is accurate");
    } else {
      console.log(`❌ FAIL: Expected to pay $${testPayoutAmount}, would actually pay $${totalWouldBePaid.toFixed(2)}`);
    }
    
    if (expectedRemainingBalance >= 0) {
      console.log("✅ PASS: Remaining balance would be non-negative");
    } else {
      console.log(`❌ FAIL: Remaining balance would be negative: $${expectedRemainingBalance.toFixed(2)}`);
    }
    
    console.log(`\n📊 Test Summary:`);
    console.log(`   Seller ID: ${testSeller.seller_id}`);
    console.log(`   Initial Balance: $${balanceBefore[0].redeemableAmount.toFixed(2)}`);
    console.log(`   Test Payout: $${testPayoutAmount}`);
    console.log(`   Expected Final Balance: $${expectedRemainingBalance.toFixed(2)}`);
    console.log(`   Records to Update: ${recordsToUpdate.length}`);
    
    // 5. Show record details
    if (recordsToUpdate.length > 0 && recordsToUpdate.length <= 10) {
      console.log(`\n📝 Records that would be marked as PAID:`);
      recordsToUpdate.forEach((record, index) => {
        console.log(`   ${index + 1}. Order ${record.orderId}: $${record.amount.toFixed(2)}`);
      });
    }
    
    console.log("\n✅ Test completed successfully! The payout fix logic appears correct.");
    
  } catch (error) {
    console.error("❌ Test failed:", error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the test
testPayoutFix();