// ===== CIUE AUTO DEPOSIT SERVER - COMPLETE SINGLE FILE =====
// This file combines package.json, .env, and db.js

/*
====================================================
PACKAGE.JSON CONTENTS (for reference)
====================================================
{
  "name": "ciue-deposit-server",
  "version": "1.0.0",
  "description": "Auto deposit system for CIUE",
  "main": "server-complete.js",
  "scripts": {
    "start": "node server-complete.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "googleapis": "^118.0.0",
    "@google-cloud/local-auth": "^2.1.0",
    "puppeteer": "^19.7.0",
    "pg": "^8.9.0",
    "dotenv": "^16.0.3"
  }
}
====================================================
*/

// ========== ENVIRONMENT VARIABLES (.env) ==========
process.env.DATABASE_URL = 'postgresql://ciue_database_user:sJks4fRcEsRDcbKPRwwSKvUHbz6klggr@dpg-d6jil09drdic739ibh0g-a.singapore-postgres.render.com/ciue_database';
process.env.PORT = '3000';
process.env.GMAIL_USER = 'vallazvallax@gmail.com';
process.env.CHIPPER_URL = 'https://pay.chippercash.com/user/947dcb54-c1fc-4d82-96bd-c76c91aa8c9c';

// ========== DEPENDENCIES ==========
const express = require('express');
const { Pool } = require('pg');
const { google } = require('googleapis');
const { authenticate } = require('@google-cloud/local-auth');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

// ========== DATABASE CONNECTION (db.js) ==========
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection error:', err.stack);
  } else {
    console.log('✅ Database connected successfully');
    release();
  }
});

// Database helper functions
const db = {
  query: (text, params) => pool.query(text, params),
  
  // Create tables if they don't exist
  init: async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        phone VARCHAR(10) PRIMARY KEY,
        full_name VARCHAR(100),
        operating_wallet INTEGER DEFAULT 0,
        incentive_wallet INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS pending_deposits (
        id SERIAL PRIMARY KEY,
        user_phone VARCHAR(10) REFERENCES users(phone),
        amount INTEGER NOT NULL,
        reference VARCHAR(50),
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS processed_emails (
        email_id VARCHAR(100) PRIMARY KEY,
        processed_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Database tables initialized');
  }
};

// ========== GMAIL EMAIL MONITOR ==========
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');

async function authenticateGmail() {
  try {
    let auth;
    
    // Check if we have a saved token
    if (fs.existsSync(TOKEN_PATH)) {
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
      auth = new google.auth.OAuth2();
      auth.setCredentials(token);
      console.log('✅ Gmail authenticated using saved token');
    } else {
      // Authenticate and save token
      auth = await authenticate({
        keyfilePath: CREDENTIALS_PATH,
        scopes: SCOPES,
      });
      
      // Save token for future use
      const token = auth.credentials;
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
      console.log('✅ Gmail authenticated and token saved');
    }
    
    return auth;
  } catch (error) {
    console.error('❌ Gmail authentication failed:', error);
    throw error;
  }
}

async function extractPaymentInfo(emailBody) {
  console.log('📧 Extracting from email...');
  
  const amountMatch = emailBody.match(/(\d+[,\d]*)\s*UGX/i);
  const amount = amountMatch ? parseInt(amountMatch[1].replace(/,/g, '')) : null;
  
  const refMatch = emailBody.match(/Reference:\s*([A-Z0-9]+)/i);
  const reference = refMatch ? refMatch[1] : null;
  
  const phoneMatch = emailBody.match(/Phone:\s*\+?(\d+\s*\d+)/i);
  let phone = phoneMatch ? phoneMatch[1].replace(/\s/g, '') : null;
  
  if (phone && phone.startsWith('256')) {
    phone = '0' + phone.slice(3);
  }
  
  console.log(`📊 Extracted: Amount=${amount}, Ref=${reference}, Phone=${phone}`);
  return { amount, reference, phone };
}

async function checkForChipperEmails() {
  try {
    const auth = await authenticateGmail();
    const gmail = google.gmail({ version: 'v1', auth });
    
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'from:(no-reply@chippercash.com OR payments@chippercash.com) subject:"Payment Link Notification" is:unread',
      maxResults: 10
    });
    
    if (!res.data.messages || res.data.messages.length === 0) {
      console.log('⏳ No new Chipper emails');
      return;
    }
    
    console.log(`📨 Found ${res.data.messages.length} new email(s)`);
    
    for (const message of res.data.messages) {
      const checkProcessed = await db.query(
        'SELECT * FROM processed_emails WHERE email_id = $1',
        [message.id]
      );
      
      if (checkProcessed.rows.length > 0) {
        console.log(`⏭️ Email ${message.id} already processed`);
        continue;
      }
      
      const email = await gmail.users.messages.get({
        userId: 'me',
        id: message.id,
        format: 'full'
      });
      
      let body = '';
      if (email.data.payload.parts) {
        body = Buffer.from(email.data.payload.parts[0].body.data, 'base64').toString();
      } else if (email.data.payload.body.data) {
        body = Buffer.from(email.data.payload.body.data, 'base64').toString();
      } else {
        continue;
      }
      
      const { amount, reference, phone } = await extractPaymentInfo(body);
      
      if (amount && phone) {
        const pending = await db.query(
          'SELECT * FROM pending_deposits WHERE user_phone = $1 AND amount = $2 AND status = $3',
          [phone, amount, 'pending']
        );
        
        if (pending.rows.length > 0) {
          await db.query(
            'UPDATE users SET operating_wallet = operating_wallet + $1 WHERE phone = $2',
            [amount, phone]
          );
          
          await db.query(
            'UPDATE pending_deposits SET status = $1, reference = $2, completed_at = NOW() WHERE id = $3',
            ['completed', reference, pending.rows[0].id]
          );
          
          await db.query(
            'INSERT INTO processed_emails (email_id) VALUES ($1)',
            [message.id]
          );
          
          await gmail.users.messages.modify({
            userId: 'me',
            id: message.id,
            requestBody: {
              removeLabelIds: ['UNREAD']
            }
          });
          
          console.log(`✅✅✅ CREDITED ${amount} UGX to user ${phone}`);
        }
      }
    }
  } catch (error) {
    console.error('❌ Error monitoring emails:', error);
  }
}

// ========== PUPPETEER AUTO-FILLER ==========
async function createDepositSession(userPhone, amount, firstName, lastName, userId) {
  console.log(`🚀 Starting deposit for ${userPhone}: ${amount} UGX`);
  
  const pending = await db.query(
    'INSERT INTO pending_deposits (user_phone, amount) VALUES ($1, $2) RETURNING id',
    [userPhone, amount]
  );
  
  const depositId = pending.rows[0].id;
  
  try {
    const browser = await puppeteer.launch({ 
      headless: false,
      defaultViewport: null,
      args: ['--no-sandbox']
    });
    
    const page = await browser.newPage();
    
    console.log('🌐 Opening Chipper payment page...');
    await page.goto(process.env.CHIPPER_URL, { waitUntil: 'networkidle2' });
    
    await page.waitForSelector('input[placeholder="Amount"]', { timeout: 10000 });
    
    await page.type('input[placeholder="Amount"]', amount.toString());
    await page.type('input[placeholder="Note"]', `User: ${userId}`);
    await page.type('input[placeholder="Your first name"]', firstName);
    await page.type('input[placeholder="Your last name"]', lastName);
    
    await page.click('button:contains("Pay")');
    
    console.log('✅ Payment page ready – waiting for email confirmation');
    
    return { success: true, depositId };
    
  } catch (error) {
    console.error('❌ Puppeteer error:', error);
    
    await db.query(
      'UPDATE pending_deposits SET status = $1 WHERE id = $2',
      ['failed', depositId]
    );
    
    return { success: false, error: error.message };
  }
}

// ========== EXPRESS SERVER ==========
const app = express();
app.use(express.json());

// Start email monitor
console.log('🚀 Email monitor started – checking every 2 minutes');
setInterval(checkForChipperEmails, 120000);
checkForChipperEmails(); // Run immediately

// Initialize database tables
db.init();

// API Routes
app.post('/api/deposit', async (req, res) => {
  const { userPhone, amount, firstName, lastName, userId } = req.body;
  
  if (!userPhone || !amount || !firstName || !lastName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  if (amount < 1000) {
    return res.status(400).json({ error: 'Minimum deposit is 1000 UGX' });
  }
  
  try {
    const result = await createDepositSession(
      userPhone, amount, firstName, lastName, userId || userPhone
    );
    res.json(result);
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/deposit/:id', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT status, amount, reference, created_at, completed_at FROM pending_deposits WHERE id = $1',
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Deposit not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/wallet/:phone', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT operating_wallet, incentive_wallet FROM users WHERE phone = $1',
      [req.params.phone]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Wallet check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/test', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

console.log('✅ CIUE Auto Deposit Server - Complete single file version');
console.log('📧 Email: vallazvallax@gmail.com');
console.log('💾 Database: Connected');