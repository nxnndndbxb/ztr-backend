/**
 * ═══════════════════════════════════════════════════════════════════
 *  ZIC OIL — FREE WhatsApp Auto-Sender Service
 *  whatsapp-web.js (QR scan) + Express — NO Meta Cloud API,
 *  NO paid service, NO third-party paid gateway.
 * ═══════════════════════════════════════════════════════════════════
 *
 *  ⚠️ ANTI-BAN WARNING (REQUIRED — DO NOT REMOVE):
 *  "Sending too many messages too fast can cause WhatsApp to
 *   temporarily or permanently ban your number. This service queues
 *   messages with a fixed delay (MESSAGE_DELAY_MS). Do NOT lower the
 *   delay. Use a dedicated business number and keep volumes reasonable."
 *
 *  Endpoints:
 *    GET  /status        → { connected, qrImage, me, state, queueLength }
 *    POST /send-invoice  → { number, imageBase64, caption, invoiceNumber, fileName }
 *    POST /logout        → disconnect & regenerate QR
 *
 *  Setup:  npm install  →  node server.js  →  scan QR with business WhatsApp
 */

const path = require('path');
const express = require('express');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const PORT = process.env.PORT || 3001;

// ⚠️ ANTI-BAN THROTTLE — minimum 5000ms between outgoing messages.
// DO NOT lower this value. Raising it is always safe.
const MESSAGE_DELAY_MS = Math.max(5000, Number(process.env.MESSAGE_DELAY_MS) || 5000);

/* ------------------------------------------------------------------ */
/*  WhatsApp client (session persists via LocalAuth)                   */
/* ------------------------------------------------------------------ */
let connectionState = 'INITIALIZING'; // INITIALIZING | WAITING_QR | READY | DISCONNECTED
let qrImageData = null;               // base64 PNG of the QR code
let meInfo = null;                    // { wid, pushname }
let lastError = null;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }
});

client.on('qr', async (qr) => {
  connectionState = 'WAITING_QR';
  lastError = null;
  try {
    qrImageData = await qrcode.toDataURL(qr, { margin: 1, width: 280 });
    console.log('📱 New QR generated — scan it with your business WhatsApp (Linked Devices).');
  } catch (e) {
    lastError = 'QR generation failed: ' + e.message;
  }
});

client.on('ready', () => {
  connectionState = 'READY';
  qrImageData = null;
  lastError = null;
  meInfo = client.info
    ? { wid: client.info.wid ? client.info.wid.user : '', pushname: client.info.pushname || '' }
    : null;
  console.log('✅ WhatsApp connected:', meInfo);
});

client.on('disconnected', (reason) => {
  connectionState = 'DISCONNECTED';
  meInfo = null;
  console.warn('⚠️ WhatsApp disconnected:', reason, '— client will attempt to re-initialize.');
});

client.on('auth_failure', (msg) => {
  connectionState = 'DISCONNECTED';
  lastError = 'Auth failure: ' + msg;
  console.error('❌ Auth failure:', msg);
});

client.initialize().catch((err) => {
  connectionState = 'DISCONNECTED';
  lastError = err.message;
  console.error('❌ Client init error:', err);
});

/* ------------------------------------------------------------------ */
/*  Outgoing message queue (sequential + fixed delay = anti-ban)       */
/* ------------------------------------------------------------------ */
const queue = [];
let sending = false;

function enqueue(job) {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (sending) return;
  sending = true;
  while (queue.length) {
    const { job, resolve, reject } = queue.shift();
    try {
      const digits = String(job.number).replace(/\D/g, '');
      const chatId = `${digits}@c.us`;
      const media = new MessageMedia(
        'image/png',
        job.imageBase64,
        job.fileName || `${job.invoiceNumber || 'invoice'}.png`
      );
      await client.sendMessage(chatId, media, { caption: job.caption || '' });
      console.log(`📤 Sent invoice ${job.invoiceNumber || ''} → ${digits}`);
      resolve();
    } catch (e) {
      console.error(`❌ Send failed for ${job.number}:`, e.message);
      reject(e);
    }
    // ⚠️ ANTI-BAN THROTTLE — fixed delay between messages. DO NOT REMOVE.
    if (queue.length) {
      await new Promise((r) => setTimeout(r, MESSAGE_DELAY_MS));
    }
  }
  sending = false;
}

/* ------------------------------------------------------------------ */
/*  HTTP API                                                           */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json({ limit: '50mb' })); // base64 invoice images can be large

// GET /status
app.get('/status', (_req, res) => {
  res.json({
    connected: connectionState === 'READY',
    state: connectionState,
    qrImage: qrImageData,
    me: meInfo,
    error: lastError,
    queueLength: queue.length,
    messageDelayMs: MESSAGE_DELAY_MS
  });
});

// POST /send-invoice
app.post('/send-invoice', async (req, res) => {
  const { number, imageBase64, caption, invoiceNumber, fileName } = req.body || {};
  if (connectionState !== 'READY' || !client.info) {
    return res.status(503).json({
      ok: false,
      error: 'WhatsApp is not connected. Scan the QR code from the WhatsApp admin page.'
    });
  }
  const digits = String(number || '').replace(/\D/g, '');
  if (!digits || digits.length < 10 || digits.length > 15) {
    return res.status(400).json({ ok: false, error: 'Invalid WhatsApp number format' });
  }
  if (!imageBase64 || imageBase64.length < 100) {
    return res.status(400).json({ ok: false, error: 'imageBase64 is required' });
  }
  try {
    await enqueue({ number: digits, imageBase64, caption, invoiceNumber, fileName });
    res.json({ ok: true, queued: true, invoiceNumber: invoiceNumber || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /logout — disconnect & regenerate a fresh QR
app.post('/logout', async (_req, res) => {
  try {
    await client.logout();
  } catch (e) {
    console.warn('Logout warning:', e.message);
  }
  connectionState = 'DISCONNECTED';
  meInfo = null;
  qrImageData = null;
  lastError = null;
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`🚀 ZIC Oil WhatsApp service running on http://localhost:${PORT}`);
  console.log(`⏱️  Anti-ban message delay: ${MESSAGE_DELAY_MS}ms (do not lower)`);
});
