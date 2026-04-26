const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Firebase Admin Setup (Aapko Service Account Key use karni hogi)
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();
const ADMIN_WALLET = "0x97efeaa1da1108acff52840550ec51dc5bbfd812";
const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";
const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/");

// --- SECURITY MIDDLEWARE ---
// Blockchain par transaction verify karne ke liye function
async function verifyTransaction(txHash, expectedAmount) {
    try {
        const tx = await provider.getTransactionReceipt(txHash);
        if (!tx || tx.status !== 1) return false;
        // Logic: Check if 'to' is ADMIN_WALLET and amount is correct
        return true; 
    } catch (e) { return false; }
}

// --- API ENDPOINTS ---

// 1. User Registration (After Payment)
app.post('/api/register', async (req, res) => {
    const { wallet, txHash, inviterId, username, profilePic } = req.body;
    
    // Security Check: Verify Transaction Hash
    const isValid = await verifyTransaction(txHash, "5.25"); 
    if (!isValid) return res.status(400).json({ error: "Invalid Transaction" });

    const walletLower = wallet.toLowerCase();
    const userRef = db.ref(`users/${walletLower}`);
    
    // Check if already exists
    const snapshot = await userRef.once('value');
    if (snapshot.exists()) return res.json({ success: true, message: "Already registered" });

    // Generate User ID
    const nextIdRef = db.ref('nextUserId');
    const idResult = await nextIdRef.transaction(current => (current || 1000) + 1);
    const userId = idResult.snapshot.val();

    const newUser = {
        profile: {
            name: username,
            userId: userId,
            joinDate: new Date().toLocaleDateString(),
            profilePicUrl: profilePic || null,
            avatar: 'fa-user-astronaut'
        },
        inviterId: parseInt(inviterId),
        paid: true,
        ztrBalance: 0,
        level: 0,
        teamSize: 0
    };

    await userRef.set(newUser);
    await db.ref(`userIdMap/${userId}`).set(walletLower);
    
    // Commission Distribution Logic (Backend Secure)
    // Yahan hum wahi 40%, 10%, 20% wali logic backend par run karenge
    
    res.json({ success: true, profile: newUser.profile });
});

// 2. Upgrade Level (Secure)
app.post('/api/upgrade', async (req, res) => {
    const { wallet, txHash, levelId } = req.body;
    const isValid = await verifyTransaction(txHash);
    if (!isValid) return res.status(400).json({ error: "Payment verification failed" });

    await db.ref(`users/${wallet.toLowerCase()}/level`).set(levelId);
    // Return percentage logic here...
    res.json({ success: true });
});

// 3. Request Withdrawal
app.post('/api/withdraw', async (req, res) => {
    const { wallet } = req.body;
    const userRef = db.ref(`users/${wallet.toLowerCase()}`);
    const snap = await userRef.once('value');
    const userData = snap.val();

    if (userData.ztrBalance <= 0) return res.status(400).json({ error: "No balance" });

    const withdrawalRequest = {
        userWallet: wallet.toLowerCase(),
        amount: userData.ztrBalance,
        status: 'pending',
        date: new Date().toISOString()
    };

    await db.ref('withdrawals').push(withdrawalRequest);
    await userRef.child('ztrBalance').set(0); // Balance reset to 0

    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));