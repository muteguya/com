// ===== CIUE AUTO DEPOSIT SERVER - COMPLETE WITH OAUTH =====
// Just upload this file - everything is ready!

// ========== ENVIRONMENT VARIABLES ==========
process.env.DATABASE_URL = 'postgresql://ciue_database_lnrk_user:VnIE8Robcw6M6tGHeDuH0VOvZKBLg6Ay@dpg-d6jkfi7kijhs73cinlbg-a.singapore-postgres.render.com/ciue_database_lnrk';
process.env.PORT = '3000';
process.env.GMAIL_USER = 'vallazvallax@gmail.com';
process.env.CHIPPER_URL = 'https://pay.chippercash.com/user/947dcb54-c1fc-4d82-96bd-c76c91aa8c9c';

// ========== DEPENDENCIES ==========
const express = require('express');
const { Pool } = require('pg');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

// ========== DATABASE CONNECTION ==========
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection error:', err.stack);
  } else {
    console.log('✅ Database connected successfully');
    release();
  }
});

const db = {
  query: (text, params) => pool.query(text, params),
  init: async () => {
    try {
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
    } catch (err) {
      console.log('⚠️ Tables may already exist:', err.message);
    }
  }
};

// ========== GMAIL AUTHENTICATION ==========
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');

// Load credentials
let credentials = null;
try {
  if (fs.existsSync(CREDENTIALS_PATH)) {
    credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    console.log('✅ credentials.json loaded');
  }
} catch (err) {
  console.log('⚠️ Could not load credentials.json:', err.message);
}

// OAuth2 client setup
let oauth2Client = null;
if (credentials && credentials.installed) {
  oauth2Client = new google.auth.OAuth2(
    credentials.installed.client_id,
    credentials.installed.client_secret,
    'https://clue-deposit-server.onrender.com/oauth2callback'
  );
}

// Try to load existing token
if (oauth2Client && fs.existsSync(TOKEN_PATH)) {
  try {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oauth2Client.setCredentials(token);
    console.log('✅ Gmail token loaded');
  } catch (err) {
    console.log('⚠️ Could not load token.json:', err.message);
  }
}

// ========== EXPRESS SERVER ==========
const app = express();
app.use(express.json());

// OAuth2 callback route
app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.send(`
      <h1>❌ Authorization Failed</h1>
      <p>No authorization code received.</p>
    `);
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    
    res.send(`
      <h1>✅ Authorization Successful!</h1>
      <p>Gmail has been authorized. You can close this window.</p>
      <p>Token saved as <code>token.json</code></p>
    `);
    console.log('✅ Gmail tokens saved successfully');
  } catch (error) {
    console.error('❌ Token exchange failed:', error);
    res.send(`<h1>❌ Token Exchange Failed</h1><p>Error: ${error.message}</p>`);
  }
});

// Home route
app.get('/', (req, res) => {
  const authStatus = oauth2Client && oauth2Client.credentials ? '✅ Authorized' : '❌ Not Authorized';
  
  res.json({
    status: 'ok',
    message: 'CIUE Auto Deposit Server Running',
    gmail: authStatus,
    endpoints: {
      auth: '/oauth2callback',
      test: '/api/test',
      deposit: '/api/deposit (POST)',
      check: '/api/deposit/:id',
      wallet: '/api/wallet/:phone'
    }
  });
});

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
    const pending = await db.query(
      'INSERT INTO pending_deposits (user_phone, amount) VALUES ($1, $2) RETURNING id',
      [userPhone, amount]
    );
    
    const depositId = pending.rows[0].id;
    
    const browser = await puppeteer.launch({ 
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.goto(process.env.CHIPPER_URL, { waitUntil: 'networkidle2' });
    await page.waitForSelector('input[placeholder="Amount"]', { timeout: 10000 });
    await page.type('input[placeholder="Amount"]', amount.toString());
    await page.type('input[placeholder="Note"]', `User: ${userId}`);
    await page.type('input[placeholder="Your first name"]', firstName);
    await page.type('input[placeholder="Your last name"]', lastName);
    await page.click('button:contains("Pay")');
    
    res.json({ success: true, depositId, message: 'Payment page opened. Will auto-credit when email arrives.' });
    
  } catch (error) {
    console.error('❌ Puppeteer error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/deposit/:id', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT status, amount, reference, created_at, completed_at FROM pending_deposits WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Deposit not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/wallet/:phone', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT operating_wallet, incentive_wallet FROM users WHERE phone = $1',
      [req.params.phone]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/test', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Email monitoring function
async function checkForChipperEmails() {
  try {
    if (!oauth2Client || !oauth2Client.credentials) return;
    
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'from:(no-reply@chippercash.com OR payments@chippercash.com) subject:"Payment Link Notification" is:unread',
      maxResults: 10
    });
    
    if (!res.data.messages) return;
    
    for (const message of res.data.messages) {
      const checkProcessed = await db.query('SELECT * FROM processed_emails WHERE email_id = $1', [message.id]);
      if (checkProcessed.rows.length > 0) continue;
      
      const email = await gmail.users.messages.get({ userId: 'me', id: message.id, format: 'full' });
      
      let body = '';
      if (email.data.payload.parts) {
        body = Buffer.from(email.data.payload.parts[0].body.data, 'base64').toString();
      } else if (email.data.payload.body.data) {
        body = Buffer.from(email.data.payload.body.data, 'base64').toString();
      } else {
        continue;
      }
      
      const amountMatch = body.match(/(\d+[,\d]*)\s*UGX/i);
      const amount = amountMatch ? parseInt(amountMatch[1].replace(/,/g, '')) : null;
      
      const refMatch = body.match(/Reference:\s*([A-Z0-9]+)/i);
      const reference = refMatch ? refMatch[1] : null;
      
      const phoneMatch = body.match(/Phone:\s*\+?(\d+\s*\d+)/i);
      let phone = phoneMatch ? phoneMatch[1].replace(/\s/g, '') : null;
      if (phone && phone.startsWith('256')) phone = '0' + phone.slice(3);
      
      if (amount && phone) {
        const pending = await db.query(
          'SELECT * FROM pending_deposits WHERE user_phone = $1 AND amount = $2 AND status = $3',
          [phone, amount, 'pending']
        );
        
        if (pending.rows.length > 0) {
          await db.query('UPDATE users SET operating_wallet = operating_wallet + $1 WHERE phone = $2', [amount, phone]);
          await db.query('UPDATE pending_deposits SET status = $1, reference = $2, completed_at = NOW() WHERE id = $3', 
            ['completed', reference, pending.rows[0].id]);
          await db.query('INSERT INTO processed_emails (email_id) VALUES ($1)', [message.id]);
          
          await gmail.users.messages.modify({ 
            userId: 'me', 
            id: message.id, 
            requestBody: { removeLabelIds: ['UNREAD'] } 
          });
          
          console.log(`✅✅✅ CREDITED ${amount} UGX to user ${phone}`);
        }
      }
    }
  } catch (error) {
    console.error('❌ Error monitoring emails:', error.message);
  }
}

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📧 Gmail: ${process.env.GMAIL_USER}`);
  console.log(`💾 Database: Connected`);
  console.log(`🌐 Chipper URL: ${process.env.CHIPPER_URL}`);
  
  if (oauth2Client && oauth2Client.credentials) {
    console.log('✅ Gmail already authorized');
  } else if (oauth2Client) {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent'
    });
    console.log('\n📧 Please visit this URL to authorize Gmail:');
    console.log('\x1b[34m%s\x1b[0m', authUrl);
    console.log('\n');
  }
});

db.init();
setInterval(checkForChipperEmails, 120000);
setTimeout(checkForChipperEmails, 10000);

console.log('✅ CIUE Auto Deposit Server - Ready');