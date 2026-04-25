const express = require('express');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
app.use(cors());
app.use(helmet());
app.use(express.json());

// --- FIREBASE ADMIN SETUP ---
const serviceAccount = {
  "type": "service_account",
  "project_id": "fortune-2cb70",
  "private_key_id": "4dafeda9f7025d1ff392e04bc58b0fa44ee2d340",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCgQm/8vKX7l9RF\nfi3m6SbLeL3s70/0gGJfiomwWwB/O5MXfBqWmyF5AsLokdHvoa8K91hMUVBb/iYz\nscBhNXScjP7GALHxrb/d3ojFgBpk0JdZGYHP2TYBM11EgqGcVLEHRHDOV7r1UCKU\nwj9QTUMPrR4DekeqwcWXQukBYDmX/4miQndBVvcmszEyWCVXDpv2LJe3vaS65Sbq\nYWVIGzvvA61MCkYyRb3+FOb6Pt84EiO/U2x6IhPvJJa7WxKMzxUjeM9IsyyclK2+\nYXzRAsIgmpn3LBcy3UiHQiEcS0C9tLvz3vZb9kpQznLb2Tr6+6wht39tuUPOVYox\nL0ZO5BXhAgMBAAECggEAGFSV129VnMmbfNRwCBlYHjaN0SGxCBwQs1QfXNKoE+j5\nxyw8hiZ1sb9JU5FF5+VqY5YTRfznYBwI9Tq0jB2XP2hJisqSuXApS7gsGB3/g9RG\nUgzlECb4Q7zmWU8i1Y7nFIUfwjgABpvcsCyAe8LLHl9oSdtf84z5IGKUaPTQsaJo\n04zkxt4sg84KgJDf69uNOZMzH8jcA+XdXI2atxkmRlyw2aOBnDS2b86X172uqvcv\nFnZzkBARAbonzm7QI7t4It6wi/cVDipnbCNizqGIZhsjDCiik+0Q7TOhnM2Hp3u4\nTEPVU46RheGV4K7csL3cd1XbeTw7HxWUqhj4150R9QKBgQDUKABBKwkpWc+BIn5y\ns0rDzoeF5mQEvae/P3h9EoREwK2MqoaLUCHB9BpVAbtjM+eEijWcCz6KiJA4b+Op\n/7xzCBOGSNy3/TwRebKjOC3vwQlvNWzzGeWGy2pYzZQ2Jg/3Bi4LNY71+5D68HaE\nyD4C/12ukngICK17djewPE8obQKBgQDBYN77+iuS+ItMuzKf/9GU6HmTVuRX2BcA\n9VoYnsZHTuKG2EvBh2eDiQxtzLV3Rz15QmrhEr4StdqQO6pjncZUeRfkwrBRWqS/\nX/RdkYqMBp63Sf3McVTSyrTdvDi8xhaWoQb8s0FBI+UdI77xDSE2/naI3rXMGvTs\nf9Z0ctmixQKBgQDOiIJ27qZkkwHm/OWMU+6c4BoeyELmOptrGyb422XYaJqLLhb8\n2G2Em1ZnGuCJmqXv6Xx3BJtF0dxUlNhVTpjugxY+y//TPbuUZ5z4OGC/3nSIxsHh\nh3xi1PQar0dxz2wLVwDL+L/Lx7NEF4PJkAaOdHuGzx/68jew0U01TADjoQKBgAwR\neZkMIdAIRtlBDYXCt1etsnipgZKh372lkjvbHNCycZysvv2S77jbwrTPg7uv7Hw2\n0ui8/LO6OauqrZWN8SSwcfdK1yocmA+Bc4SrYpQejaUurvIlWH/XOrZj2r6dNies\nYP1ASqBAFzpcUrxEb4A5HTipfXsBa6uexsl5qW9pAoGAdC51f2ln1pl4/NocxQVH\nA0b/4+QfHvrGq/WcgyDY22nrY9HlCLr5ipYimjUXYWuv2qIzJ+udOQC1jBkZwcWc\nI55+aj6OSEb7T1JPOOZI1iIU50XNL5OkIOSbyUtvQKSlPW8JbpNtzeYdBgvlcW9i\n1VoxDy6NKbL1h43K7jOXhBo=\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-fbsvc@fortune-2cb70.iam.gserviceaccount.com",
  "databaseURL": "https://fortune-2cb70-default-rtdb.asia-southeast1.firebasedatabase.app"
};

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: serviceAccount.databaseURL
    });
}
const db = admin.database();

// --- AUTH MIDDLEWARE ---
// Ye function hacker ko rokega kyunki har request ko user ke wallet se "Sign" hona padega
async function verifyUser(req, res, next) {
    const { address, signature, message } = req.headers;
    if (!address || !signature || !message) return res.status(401).json({ error: "Security Check Failed" });
    try {
        const recovered = ethers.verifyMessage(message, signature);
        if (recovered.toLowerCase() !== address.toLowerCase()) throw new Error();
        req.userAddress = address.toLowerCase();
        next();
    } catch (e) { res.status(401).json({ error: "Unauthorized Attempt" }); }
}

// --- CONFIG ---
const JOIN_FEE = 5.25;
const LEVELS = [
    { id: 1, name: "Iron", price: 5, return: 5 },
    { id: 2, name: "Bronze", price: 10, return: 5 },
    { id: 3, name: "Silver", price: 15, return: 7 },
    { id: 4, name: "Gold", price: 20, return: 7 },
    { id: 5, name: "Master", price: 25, return: 10 }
];

// --- ROUTES ---

app.get('/api', (req, res) => res.send("ZTR Secure Backend Live"));

// 1. Secure Registration
app.post('/api/register', verifyUser, async (req, res) => {
    const { inviteCode, username, txHash } = req.body;
    const wallet = req.userAddress;

    try {
        const userRef = db.ref(`users/${wallet}`);
        const snap = await userRef.once('value');
        if (snap.exists()) return res.status(400).json({ error: "Already Registered" });

        // Verify Inviter
        const inviterSnap = await db.ref(`inviteCodeMap/${inviteCode.toUpperCase()}`).once('value');
        if (!inviterSnap.exists()) return res.status(400).json({ error: "Invalid Invite Code" });
        const inviterWallet = inviterSnap.val();

        // Create User Data
        const nextIdSnap = await db.ref('nextUserId').transaction(c => (c || 1000) + 1);
        const userId = nextIdSnap.snapshot.val();
        const myCode = Math.random().toString(36).substring(2, 10).toUpperCase();

        const userData = {
            profile: { name: username, userId, joinDate: new Date().toLocaleDateString() },
            inviteCode: myCode,
            inviterWallet: inviterWallet,
            ztrBalance: 0,
            level: 0,
            teamSize: 0,
            paid: true,
            registrationTx: txHash
        };

        await userRef.set(userData);
        await db.ref(`inviteCodeMap/${myCode}`).set(wallet);
        await db.ref(`userIdMap/${userId}`).set(wallet);

        // --- Commission Distribution (SERVER SIDE) ---
        // 40% Direct Inviter
        await updateBalance(inviterWallet, JOIN_FEE * 0.40, "Direct Commission");
        await db.ref(`users/${inviterWallet}/teamSize`).transaction(s => (s || 0) + 1);

        // 10% Upliner (Inviter's Inviter)
        const inviterData = (await db.ref(`users/${inviterWallet}`).once('value')).val();
        if (inviterData.inviterWallet) {
            await updateBalance(inviterData.inviterWallet, JOIN_FEE * 0.10, "Upliner Commission");
        }

        // 20% Pool Share (Inviter's other directs)
        const othersSnap = await db.ref('users').orderByChild('inviterWallet').equalTo(inviterWallet).once('value');
        if (othersSnap.exists()) {
            const others = Object.keys(othersSnap.val()).filter(w => w !== wallet);
            if (others.length > 0) {
                const share = (JOIN_FEE * 0.20) / others.length;
                for (const w of others) await updateBalance(w, share, "Downline Pool Share");
            }
        }

        res.json({ success: true, myCode });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. Secure Level Upgrade
app.post('/api/upgrade', verifyUser, async (req, res) => {
    const { levelId, txHash } = req.body;
    const wallet = req.userAddress;

    try {
        const userSnap = await db.ref(`users/${wallet}`).once('value');
        const user = userSnap.val();
        if (user.level !== levelId - 1) return res.status(400).json({ error: "Upgrade sequentially" });

        const level = LEVELS.find(l => l.id === levelId);
        await db.ref(`users/${wallet}/level`).set(levelId);

        // Instant Reward (%)
        const reward = level.price * (level.return / 100);
        await updateBalance(wallet, reward, `${level.name} Level Return`);

        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. Secure Withdrawal
app.post('/api/withdraw', verifyUser, async (req, res) => {
    const wallet = req.userAddress;
    try {
        const snap = await db.ref(`users/${wallet}`).once('value');
        const balance = snap.val().ztrBalance;
        if (balance <= 0) return res.status(400).json({ error: "No Balance" });

        // Transactional Update
        await db.ref(`users/${wallet}/ztrBalance`).set(0);
        await db.ref('withdrawals').push({
            wallet,
            amount: balance,
            status: 'pending',
            date: new Date().toISOString()
        });

        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

async function updateBalance(wallet, amount, type) {
    await db.ref(`users/${wallet}/ztrBalance`).transaction(b => (b || 0) + amount);
    await db.ref(`users/${wallet}/incomeHistory`).push({
        amount, type, date: new Date().toISOString()
    });
}

module.exports = app;
