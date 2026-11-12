const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

let qrImage = null;
let isConnected = false;

// Yeh background mein Chrome browser chalata hai
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true, 
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', async (qr) => {
    qrImage = await QRCode.toDataURL(qr);
    console.log('QR Code generated. Please scan from admin panel.');
});

client.on('ready', () => {
    isConnected = true;
    qrImage = null;
    console.log('✅ WhatsApp Connected Successfully!');
});

client.on('disconnected', (reason) => {
    isConnected = false;
    console.log('❌ WhatsApp Disconnected:', reason);
    client.initialize(); 
});

client.initialize();

app.get('/status', (req, res) => {
    res.json({ connected: isConnected, qrImage });
});

app.post('/send-invoice', async (req, res) => {
    try {
        if (!isConnected) return res.status(409).json({ error: 'WhatsApp not connected' });
        
        const { number, imageBase64, caption } = req.body;
        
        let cleanNumber = number.replace(/\D/g, '');
        if (cleanNumber.startsWith('0')) cleanNumber = '92' + cleanNumber.slice(1);
        
        const chatId = cleanNumber + '@c.us';
        const media = new MessageMedia('image/png', imageBase64, 'invoice.png');

        await client.sendMessage(chatId, media, { caption: caption || '' });
        console.log(`✅ Message sent to ${cleanNumber}`);
        
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/logout', async (req, res) => {
    try {
        await client.logout();
        isConnected = false;
        qrImage = null;
        client.initialize();
    } catch (e) {}
    res.json({ success: true });
});

app.listen(3001, () => {
    console.log('🚀 Server running on http://localhost:3001');
});
