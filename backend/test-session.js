// Test script to validate WhatsApp session persistence
import { validateSession, recoverSession, getWhatsAppStatus } from './src/services/whatsappservice.js';

async function testSessionPersistence() {
  console.log('🧪 Testing WhatsApp session persistence...\n');
  
  // 1. Check current status
  console.log('1️⃣ Current WhatsApp status:');
  const status = getWhatsAppStatus();
  console.log(JSON.stringify(status, null, 2));
  console.log();
  
  // 2. Validate session
  console.log('2️⃣ Validating session...');
  try {
    const path = process.env.WHATSAPP_DATA_PATH || './.wwebjs_auth';
    const validation = await validateSession(path);
    console.log('Session validation result:', validation);
    console.log();
  } catch (error) {
    console.error('Session validation error:', error.message);
    console.log();
  }
  
  // 3. Try recovery if needed
  if (!status.ready) {
    console.log('3️⃣ Attempting session recovery...');
    try {
      const recovery = await recoverSession();
      console.log('Recovery result:', recovery);
      console.log();
    } catch (error) {
      console.error('Recovery error:', error.message);
      console.log();
    }
  }
  
  console.log('✅ Session persistence test completed');
}

testSessionPersistence().catch(console.error);