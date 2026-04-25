const express = require('express');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
app.use(cors());
app.use(helmet());
app.use(express.json());

// Firebase Setup
if (!admin.apps.length) {
    const serviceAccount = require("../serviceAccount.json");
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://fortune-2cb70-default-rtdb.asia-southeast1.firebasedatabase.app"
    });
}
const db = admin.database();

// Blockchain Provider (BSC)
const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/");

// Levels Config
const LEVELS = [
    { id: 1, name: "Iron", price: 5, return: 5 },
    { id: 2, name: "Bronze", price: 10, return: 5 },
    { id: 3, name: "Silver", price: 15, return: 7 },
    { id: 4, name: "Gold", price: 20, return: 7 },
    { id: 5, name: "Master", price: 25, return: 10 }
];

// Authentication Middleware
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

// 1. Registration & Commission Logic
app.post('/api/register', authUser, async (req, res) => {
    const { inviteCode, username, profilePicUrl } = req.body;
    const wallet = req.userWallet;

    try {
        const snap = await db.ref(`users/${wallet}`).once('value');
        if (snap.exists()) return res.status(400).json({ error: "Already registered" });

        // Verify Inviter
        const inviterSnap = await db.ref(`inviteCodeMap/${inviteCode.toUpperCase()}`).once('value');
        if (!inviterSnap.exists()) return res.status(400).json({ error: "Invalid invite code" });
        const inviterWallet = inviterSnap.val();

        // Create User
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

        // Commission: Direct 40%, Upliner 10%, Pool 20%
        const amount = 5.25; 
        await distributeCommission(wallet, inviterWallet, amount);

        res.json({ success: true, myCode });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Commission Distribution Function
async function distributeCommission(newUser, inviter, amt) {
    // 1. Direct 40%
    await addIncome(inviter, amt * 0.40, "Direct Commission");
    await db.ref(`users/${inviter}/teamSize`).transaction(s => (s || 0) + 1);

    // 2. Upliner 10%
    const invData = (await db.ref(`users/${inviter}`).once('value')).val();
    if (invData && invData.inviterWallet) {
        await addIncome(invData.inviterWallet, amt * 0.10, "Upliner Commission");
    }

    // 3. Pool 20% (split among inviter's other directs)
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

// 2. Sequential Upgrade
app.post('/api/upgrade', authUser, async (req, res) => {
    const { levelId } = req.body;
    const wallet = req.userWallet;
    try {
        const userSnap = await db.ref(`users/${wallet}`).once('value');
        const user = userSnap.val();
        if (user.level !== levelId - 1) return res.status(400).json({ error: "Follow sequence" });

        const level = LEVELS.find(l => l.id === levelId);
        await db.ref(`users/${wallet}/level`).set(levelId);

        // Instant Return
        const retAmt = level.price * (level.return / 100);
        await addIncome(wallet, retAmt, `${level.name} Return`);

        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. Secure Withdrawal
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