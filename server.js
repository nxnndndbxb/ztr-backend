const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

let sock = null;
let qrImage = null;
let isConnected = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrImage = await QRCode.toDataURL(qr);
        }
        if (connection === 'close') {
            isConnected = false;
            qrImage = null;
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Connected Successfully!');
            isConnected = true;
            qrImage = null;
        }
    });
}

connectToWhatsApp();

app.get('/status', (req, res) => {
    res.json({ connected: isConnected, qrImage });
});

app.post('/send-invoice', async (req, res) => {
    try {
        if (!isConnected) return res.status(409).json({ error: 'WhatsApp not connected' });
        const { number, imageBase64, caption } = req.body;
        
        let jid = number.replace(/\D/g, '');
        if (jid.startsWith('0')) jid = '92' + jid.slice(1);
        jid = jid + '@s.whatsapp.net';

        const media = Buffer.from(imageBase64, 'base64');

        await sock.sendMessage(jid, { image: media, caption: caption || '' });
        console.log(`Message sent to ${jid}`);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/logout', async (req, res) => {
    if (sock) await sock.logout();
    fs.rmSync('auth_info', { recursive: true, force: true });
    isConnected = false;
    qrImage = null;
    connectToWhatsApp();
    res.json({ success: true });
});

app.listen(3001, () => {
    console.log('Server running on http://localhost:3001');
});
