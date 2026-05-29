const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function cleanPendingRegistrations() {
  try {
    console.log('🔍 Checking pending registrations...');
    
    // Get all pending registrations
    const pendingRegistrations = await prisma.pendingRegistration.findMany();
    
    console.log(`📋 Found ${pendingRegistrations.length} pending registrations:`);
    pendingRegistrations.forEach((reg, index) => {
      console.log(`${index + 1}. Email: ${reg.email}, Role: ${reg.role}, Created: ${reg.createdAt}`);
    });

    if (pendingRegistrations.length > 0) {
      console.log('\n🗑️ Clearing all pending registrations...');
      
      const result = await prisma.pendingRegistration.deleteMany({});
      
      console.log(`✅ Deleted ${result.count} pending registration(s)`);
      console.log('🎉 You can now register with any email address!');
    } else {
      console.log('✅ No pending registrations found. Database is clean.');
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

cleanPendingRegistrations();