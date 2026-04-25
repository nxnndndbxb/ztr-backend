const express = require('express');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
app.use(cors());
app.use(helmet());
app.use(express.json());

// --- AAPKA FIREBASE DATA SEEDHA YAHA ---
const serviceAccount = {
  "type": "service_account",
  "project_id": "fortune-2cb70",
  "private_key_id": "4dafeda9f7025d1ff392e04bc58b0fa44ee2d340",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCgQm/8vKX7l9RF\nfi3m6SbLeL3s70/0gGJfiomwWwB/O5MXfBqWmyF5AsLokdHvoa8K91hMUVBb/iYz\nscBhNXScjP7GALHxrb/d3ojFgBpk0JdZGYHP2TYBM11EgqGcVLEHRHDOV7r1UCKU\nwj9QTUMPrR4DekeqwcWXQukBYDmX/4miQndBVvcmszEyWCVXDpv2LJe3vaS65Sbq\nYWVIGzvvA61MCkYyRb3+FOb6Pt84EiO/U2x6IhPvJJa7WxKMzxUjeM9IsyyclK2+\nYXzRAsIgmpn3LBcy3UiHQiEcS0C9tLvz3vZb9kpQznLb2Tr6+6wht39tuUPOVYox\nL0ZO5BXhAgMBAAECggEAGFSV129VnMmbfNRwCBlYHjaN0SGxCBwQs1QfXNKoE+j5\nxyw8hiZ1sb9JU5FF5+VqY5YTRfznYBwI9Tq0jB2XP2hJisqSuXApS7gsGB3/g9RG\nUgzlECb4Q7zmWU8i1Y7nFIUfwjgABpvcsCyAe8LLHl9oSdtf84z5IGKUaPTQsaJo\n04zkxt4sg84KgJDf69uNOZMzH8jcA+XdXI2atxkmRlyw2aOBnDS2b86X172uqvcv\nFnZzkBARAbonzm7QI7t4It6wi/cVDipnbCNizqGIZhsjDCiik+0Q7TOhnM2Hp3u4\nTEPVU46RheGV4K7csL3cd1XbeTw7HxWUqhj4150R9QKBgQDUKABBKwkpWc+BIn5y\ns0rDzoeF5mQEvae/P3h9EoREwK2MqoaLUCHB9BpVAbtjM+eEijWcCz6KiJA4b+Op\n/7xzCBOGSNy3/TwRebKjOC3vwQlvNWzzGeWGy2pYzZQ2Jg/3Bi4LNY71+5D68HaE\nyD4C/12ukngICK17djewPE8obQKBgQDBYN77+iuS+ItMuzKf/9GU6HmTVuRX2BcA\n9VoYnsZHTuKG2EvBh2eDiQxtzLV3Rz15QmrhEr4StdqQO6pjncZUeRfkwrBRWqS/\nX/RdkYqMBp63Sf3McVTSyrTdvDi8xhaWoQb8s0FBI+UdI77xDSE2/naI3rXMGvTs\nf9Z0ctmixQKBgQDOiIJ27qZkkwHm/OWMU+6c4BoeyELmOptrGyb422XYaJqLLhb8\n2G2Em1ZnGuCJmqXv6Xx3BJtF0dxUlNhVTpjugxY+y//TPbuUZ5z4OGC/3nSIxsHh\nh3xi1PQar0dxz2wLVwDL+L/Lx7NEF4PJkAaOdHuGzx/68jew0U01TADjoQKBgAwR\neZkMIdAIRtlBDYXCt1etsnipgZKh372lkjvbHNCycZysvv2S77jbwrTPg7uv7Hw2\n0ui8/LO6OauqrZWN8SSwcfdK1yocmA+Bc4SrYpQejaUurvIlWH/XOrZj2r6dNies\nYP1ASqBAFzpcUrxEb4A5HTipfXsBa6uexsl5qW9pAoGAdC51f2ln1pl4/NocxQVH\nA0b/4+QfHvrGq/WcgyDY22nrY9HlCLr5ipYimjUXYWuv2qIzJ+udOQC1jBkZwcWc\nI55+aj6OSEb7T1JPOOZI1iIU50XNL5OkIOSbyUtvQKSlPW8JbpNtzeYdBgvlcW9i\n1VoxDy6NKbL1h43K7jOXhBo=\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-fbsvc@fortune-2cb70.iam.gserviceaccount.com",
  "client_id": "102872628676620405811",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40fortune-2cb70.iam.gserviceaccount.com",
  "universe_domain": "googleapis.com"
};

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://fortune-2cb70-default-rtdb.asia-southeast1.firebasedatabase.app"
    });
}
const db = admin.database();

const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/");

const LEVELS = [
    { id: 1, name: "Iron", price: 5, return: 5 },
    { id: 2, name: "Bronze", price: 10, return: 5 },
    { id: 3, name: "Silver", price: 15, return: 7 },
    { id: 4, name: "Gold", price: 20, return: 7 },
    { id: 5, name: "Master", price: 25, return: 10 }
];

async function authUser(req, res, next) {
    const { address, signature, message } = req.headers;
    if (!address || !signature || !message) return res.status(401).json({ error: "Missing Auth Headers" });
    try {
        const recovered = ethers.verifyMessage(message, signature);
        if (recovered.toLowerCase() !== address.toLowerCase()) throw new Error();
        req.userWallet = address.toLowerCase();
        next();
    } catch (e) { res.status(401).json({ error: "Auth Failed" }); }
}

app.get('/api', (req, res) => {
    res.send("ZTR Backend is Running!");
});

app.post('/api/register', authUser, async (req, res) => {
    const { inviteCode, username, profilePicUrl } = req.body;
    const wallet = req.userWallet;
    try {
        const snap = await db.ref(`users/${wallet}`).once('value');
        if (snap.exists()) return res.status(400).json({ error: "Already registered" });

        const inviterSnap = await db.ref(`inviteCodeMap/${inviteCode.toUpperCase()}`).once('value');
        if (!inviterSnap.exists()) return res.status(400).json({ error: "Invalid invite code" });
        const inviterWallet = inviterSnap.val();

        const nextIdSnap = await db.ref('nextUserId').transaction(c => (c || 1000) + 1);
        const userId = nextIdSnap.snapshot.val();
        const myCode = Math.random().toString(36).substring(2, 10).toUpperCase();

        const userData = {
            profile: { name: username, userId, profilePicUrl, joinDate: new Date().toLocaleDateString() },
            inviteCode: myCode,
            inviterWallet: inviterWallet,
            ztrBalance: 0,
            level: 0,
            teamSize: 0,
            paid: true
        };

        await db.ref(`users/${wallet}`).set(userData);
        await db.ref(`inviteCodeMap/${myCode}`).set(wallet);
        await db.ref(`userIdMap/${userId}`).set(wallet);

        await distributeCommission(wallet, inviterWallet, 5.25);
        res.json({ success: true, myCode });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

async function distributeCommission(newUser, inviter, amt) {
    await addIncome(inviter, amt * 0.40, "Direct Commission");
    await db.ref(`users/${inviter}/teamSize`).transaction(s => (s || 0) + 1);
    const invData = (await db.ref(`users/${inviter}`).once('value')).val();
    if (invData && invData.inviterWallet) {
        await addIncome(invData.inviterWallet, amt * 0.10, "Upliner Commission");
    }
    const directsSnap = await db.ref('users').orderByChild('inviterWallet').equalTo(inviter).once('value');
    if (directsSnap.exists()) {
        const wallets = Object.keys(directsSnap.val()).filter(w => w !== newUser);
        if (wallets.length > 0) {
            const share = (amt * 0.20) / wallets.length;
            for (const w of wallets) await addIncome(w, share, "Pool Share");
        }
    }
}

async function addIncome(wallet, amount, type) {
    await db.ref(`users/${wallet}/ztrBalance`).transaction(b => (b || 0) + amount);
    await db.ref(`users/${wallet}/incomeHistory`).push({ amount, type, date: new Date().toISOString() });
}

app.post('/api/upgrade', authUser, async (req, res) => {
    const { levelId } = req.body;
    const wallet = req.userWallet;
    try {
        const userSnap = await db.ref(`users/${wallet}`).once('value');
        const user = userSnap.val();
        if (user.level !== levelId - 1) return res.status(400).json({ error: "Follow sequence" });
        const level = LEVELS.find(l => l.id === levelId);
        await db.ref(`users/${wallet}/level`).set(levelId);
        const retAmt = level.price * (level.return / 100);
        await addIncome(wallet, retAmt, `${level.name} Return`);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/withdraw', authUser, async (req, res) => {
    try {
        const snap = await db.ref(`users/${req.userWallet}`).once('value');
        const bal = snap.val().ztrBalance;
        if (bal <= 0) return res.status(400).json({ error: "No ZTR" });
        await db.ref(`users/${req.userWallet}/ztrBalance`).set(0);
        await db.ref('withdrawals').push({ wallet: req.userWallet, amount: bal, status: 'pending', date: new Date().toISOString() });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = app;
