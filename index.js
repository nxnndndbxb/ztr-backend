// File: index.js

// ===================================================================
// ==================== ZTR PLATFORM BACKEND API =====================
// ===================================================================
// Version: 2.1.0
// Description: Handles all core logic for the ZTR platform, including
// user registration, level upgrades, commission distribution, and withdrawals.
// This server-side approach ensures security and data integrity.
// ===================================================================

// --- Dependencies ---
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
const crypto = require('crypto');
require('dotenv').config();

// --- Express App Initialization ---
const app = express();

// --- Middlewares ---
app.use(cors({
    origin: '*', // Production mein isko apne frontend URL se badal dein
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key']
}));
app.options('*', cors());
app.use(express.json());

// ===================================================================
// ======================= SECURITY MIDDLEWARES ======================
// ===================================================================

const API_KEY = process.env.API_KEY || crypto.randomBytes(32).toString('hex');

// Middleware to protect routes with an API key
const requireApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== API_KEY) {
        return res.status(403).json({ success: false, error: "Forbidden: Invalid API Key" });
    }
    next();
};

// Simple IP-based rate limiting to prevent abuse
const rateLimitMap = new Map();
function rateLimiter(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const limit = 60; // 60 requests per minute
    const windowMs = 60000; // 1 minute

    if (!rateLimitMap.has(ip)) {
        rateLimitMap.set(ip, { count: 1, startTime: now });
        return next();
    }
    
    const clientData = rateLimitMap.get(ip);
    if (now - clientData.startTime > windowMs) {
        clientData.count = 1;
        clientData.startTime = now;
        return next();
    }
    
    clientData.count++;
    if (clientData.count > limit) {
        return res.status(429).json({ success: false, error: "Too many requests. Please try again later." });
    }
    next();
}
app.use(rateLimiter);


// ===================================================================
// =================== FIREBASE & BLOCKCHAIN SETUP ===================
// ===================================================================

// --- Firebase Admin SDK Initialization ---
let db;
try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable not set.");
    }
    const serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('ascii'));
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DB_URL
    });
    db = admin.database();
    console.log("✅ Firebase Admin SDK connected successfully.");
} catch (error) {
    console.error("🔥 Firebase Initialization Error:", error.message);
    process.exit(1);
}

// --- Ethers.js & Blockchain Configuration ---
const ADMIN_WALLET = (process.env.ADMIN_WALLET || "0x97efeaa1da1108acff52840550ec51dc5bbfd812").toLowerCase();
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
const USDT_CONTRACT_ADDRESS = (process.env.USDT_CONTRACT || "0x55d398326f99059fF775485246999027B3197955").toLowerCase();
const BSC_RPC_URL = process.env.BSC_RPC || "https://bsc-dataseed.binance.org/";

const provider = new ethers.JsonRpcProvider(BSC_RPC_URL);
let adminSigner = null;

if (ADMIN_PRIVATE_KEY) {
    try {
        adminSigner = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);
        console.log("✅ Admin wallet loaded for processing withdrawals.");
    } catch (e) {
        console.error("⚠️ Could not load admin wallet from private key. Automatic withdrawals will be disabled.", e.message);
    }
} else {
    console.log("⚠️ ADMIN_PRIVATE_KEY not found. Automatic withdrawals are disabled.");
}

const USDT_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address, uint256) returns (bool)"
];
const usdtContract = new ethers.Contract(USDT_CONTRACT_ADDRESS, USDT_ABI, provider);

// ===================================================================
// ======================== HELPER FUNCTIONS =========================
// ===================================================================

/**
 * Generates a unique 8-character alphanumeric invitation code.
 * @returns {Promise<string>} A unique invitation code.
 */
async function generateUniqueInviteCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < 50; i++) { // Try 50 times to find a unique code
        const code = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        const snapshot = await db.ref(`inviteCodeMap/${code}`).once('value');
        if (!snapshot.exists()) {
            return code;
        }
    }
    // As a fallback if a unique code isn't found after 50 tries
    return 'ZTR' + Date.now().toString(36).slice(-5).toUpperCase();
}


/**
 * Fetches the level configuration from Firebase, with a fallback.
 * @returns {Promise<Array<Object>>} The array of level configurations.
 */
async function getLevelsConfig() {
    const snapshot = await db.ref('config/Levels').once('value');
    if (snapshot.exists() && Array.isArray(snapshot.val())) {
        return snapshot.val();
    }
    // Fallback default configuration
    return [
        { id: 0, name: "Starter", price: 0.1, salaryFund: 0, fee: 0, icon: "🌱", airdropPoints: 100, requiredTeamSize: 0 },
        // ... (add other default levels if needed)
    ];
}

/**
 * Calculates the total registration fee in ZTR from level 0 config.
 * @returns {Promise<number>} The registration fee in ZTR.
 */
async function getRegistrationFeeInZTR() {
    const levels = await getLevelsConfig();
    const starterLevel = levels.find(l => l.id === 0);
    if (!starterLevel) return 0.1; // Fallback fee
    return (starterLevel.price || 0) + (starterLevel.salaryFund || 0) + (starterLevel.fee || 0);
}

/**
 * Fetches the current base price of ZTR from Firebase.
 * @returns {Promise<number>} The price of 1 ZTR in USDT.
 */
async function getZTRPrice() {
    const snapshot = await db.ref('config/baseZTRPrice').once('value');
    return snapshot.exists() ? snapshot.val() : 1.0;
}

/**
 * Verifies a USDT transfer transaction on the blockchain.
 * @param {string} txHash - The transaction hash.
 * @param {string} fromWallet - The expected sender's wallet address.
 * @param {string} toWallet - The expected receiver's wallet address.
 * @param {number|string} expectedAmount - The expected amount in USDT.
 * @param {number} tolerancePercent - The allowed percentage deviation in amount.
 * @returns {Promise<boolean>} True if the transaction is valid, false otherwise.
 */
async function verifyTransaction(txHash, fromWallet, toWallet, expectedAmount, tolerancePercent = 0.5) {
    try {
        if (!txHash || !ethers.isHexString(txHash, 32)) return false;
        if (!ethers.isAddress(fromWallet) || !ethers.isAddress(toWallet)) return false;

        const txUsedSnapshot = await db.ref(`usedTransactions/${txHash}`).once('value');
        if (txUsedSnapshot.exists()) {
            console.log(`Transaction verification failed: ${txHash} has already been used.`);
            return false;
        }

        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) {
            console.log(`Transaction verification failed: Receipt not found or transaction failed for ${txHash}.`);
            return false;
        }

        const decimals = await usdtContract.decimals();
        const expectedWei = ethers.parseUnits(String(expectedAmount), decimals);
        const tolerance = (expectedWei * BigInt(Math.floor(tolerancePercent * 100))) / 10000n;
        const minRange = expectedWei - tolerance;
        const maxRange = expectedWei + tolerance;

        const fromAddressLower = fromWallet.toLowerCase();
        const toAddressLower = toWallet.toLowerCase();

        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === USDT_CONTRACT_ADDRESS) {
                try {
                    const parsedLog = usdtContract.interface.parseLog(log);
                    if (parsedLog && parsedLog.name === "Transfer") {
                        const { from, to, value } = parsedLog.args;
                        if (from.toLowerCase() === fromAddressLower && to.toLowerCase() === toAddressLower && value >= minRange && value <= maxRange) {
                            await db.ref(`usedTransactions/${txHash}`).set(true);
                            console.log(`✅ Transaction verified successfully: ${txHash}`);
                            return true;
                        }
                    }
                } catch (e) {
                    // Ignore logs that can't be parsed by the USDT ABI
                }
            }
        }
        
        console.log(`Transaction verification failed: No matching USDT transfer found for ${txHash}.`);
        return false;
    } catch (error) {
        console.error("Error during transaction verification:", error.message);
        return false;
    }
}

// ... (Other helper functions like getUserByWallet, addCommission etc. will be here)
// For brevity, the core logic is in the routes.

// ===================================================================
// =========================== API ROUTES ============================
// ===================================================================

// --- Public Route: Get Platform Configuration ---
app.get('/api/config', async (req, res) => {
    try {
        const ztrPrice = await getZTRPrice();
        const registrationFeeZTR = await getRegistrationFeeInZTR();
        const registrationFeeUSDT = (registrationFeeZTR * ztrPrice).toFixed(2);
        
        res.json({
            success: true,
            config: {
                ztrPrice,
                registrationFeeUSDT,
                adminWallet: ADMIN_WALLET,
                usdtContract: USDT_CONTRACT_ADDRESS
            }
        });
    } catch (error) {
        console.error("Error fetching config:", error);
        res.status(500).json({ success: false, error: "Could not fetch platform configuration." });
    }
});


// --- Public Route: Get Inviter Info ---
app.get('/api/invite-info/:inviteCode', async (req, res) => {
    try {
        const inviteCode = req.params.inviteCode.toUpperCase();
        const inviterWalletSnapshot = await db.ref(`inviteCodeMap/${inviteCode}`).once('value');
        if (!inviterWalletSnapshot.exists()) {
            return res.status(404).json({ success: false, error: "Invitation code not found." });
        }
        const inviterWallet = inviterWalletSnapshot.val();
        const inviterProfileSnapshot = await db.ref(`users/${inviterWallet.toLowerCase()}/profile`).once('value');
        if (!inviterProfileSnapshot.exists()) {
            return res.status(404).json({ success: false, error: "Inviter profile not found." });
        }
        res.json({ success: true, inviter: inviterProfileSnapshot.val() });
    } catch (error) {
        console.error("Error fetching invite info:", error);
        res.status(500).json({ success: false, error: "Internal server error." });
    }
});


// --- POST Route: Register New User ---
app.post('/api/register', async (req, res) => {
    const { wallet, txHash, inviteCode, username, profilePicUrl } = req.body;

    // 1. Validation
    if (!wallet || !txHash || !inviteCode || !username) {
        return res.status(400).json({ success: false, error: "Missing required fields." });
    }
    if (!ethers.isAddress(wallet)) {
        return res.status(400).json({ success: false, error: "Invalid wallet address." });
    }
    if (username.length < 3 || username.length > 30) {
        return res.status(400).json({ success: false, error: "Username must be between 3 and 30 characters." });
    }

    try {
        const walletLower = wallet.toLowerCase();
        
        // 2. Check if user or inviter exists
        const userSnapshot = await db.ref(`users/${walletLower}`).once('value');
        if (userSnapshot.exists()) {
            return res.status(400).json({ success: false, error: "This wallet is already registered." });
        }
        
        const inviterWalletSnapshot = await db.ref(`inviteCodeMap/${inviteCode.toUpperCase()}`).once('value');
        if (!inviterWalletSnapshot.exists()) {
            return res.status(400).json({ success: false, error: "Invalid invitation code." });
        }
        const inviterWallet = inviterWalletSnapshot.val().toLowerCase();
        const inviterDataSnapshot = await db.ref(`users/${inviterWallet}`).once('value');
        if(!inviterDataSnapshot.exists()){
             return res.status(400).json({ success: false, error: "Inviter data not found." });
        }
        const inviterId = inviterDataSnapshot.val().profile.userId;

        // 3. Verify Payment
        const ztrPrice = await getZTRPrice();
        const registrationFeeZTR = await getRegistrationFeeInZTR();
        const expectedAmountUSDT = (registrationFeeZTR * ztrPrice).toFixed(2);

        const isPaymentValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, expectedAmountUSDT);
        if (!isPaymentValid) {
            return res.status(400).json({ success: false, error: "Payment verification failed. Please check the transaction hash or wait for more confirmations." });
        }

        // 4. Generate New User Data
        const idTransaction = await db.ref('nextUserId').transaction(currentId => (currentId || 1000) + 1);
        if (!idTransaction.committed) {
            throw new Error("Could not generate a unique user ID.");
        }
        const newUserId = idTransaction.snapshot.val();
        const newInviteCode = await generateUniqueInviteCode();
        
        const newUser = {
            profile: {
                name: username,
                userId: newUserId,
                joinDate: new Date().toLocaleDateString('en-GB'),
                profilePicUrl: profilePicUrl || null
            },
            inviteCode: newInviteCode,
            inviterId: inviterId,
            ztrBalance: 0,
            airdropPoints: 0,
            level: 0,
            teamSize: 0,
            registeredAt: admin.database.ServerValue.TIMESTAMP
        };

        // 5. Save data to Firebase in one atomic operation
        const updates = {};
        updates[`users/${walletLower}`] = newUser;
        updates[`userIdMap/${newUserId}`] = walletLower;
        updates[`inviteCodeMap/${newInviteCode}`] = walletLower;
        updates[`users/${inviterWallet}/teamSize`] = admin.database.ServerValue.increment(1);
        updates['platformStats/totalParticipants'] = admin.database.ServerValue.increment(1);
        
        await db.ref().update(updates);

        // 6. Distribute Commissions & Airdrop (run asynchronously, don't hold up the response)
        distributeRegistrationCommissions(inviterId, newUserId, registrationFeeZTR);
        distributeAirdropPoints(walletLower, 0); // Level 0 airdrop

        console.log(`✅ New user registered: ${username} (ID: ${newUserId})`);
        res.status(201).json({ success: true, user: newUser });

    } catch (error) {
        console.error("Registration Error:", error);
        res.status(500).json({ success: false, error: "An unexpected error occurred during registration." });
    }
});


// Helper functions for commission and airdrop distribution
async function distributeRegistrationCommissions(inviterId, newUserId, totalFeeZTR) {
    // This is a simplified example. You should use the detailed commission structure.
    // 55% to direct inviter, 7% to upline, 20% to team.
    const levels = await getLevelsConfig();
    const price = levels.find(l=>l.id===0)?.price || 0.1;

    const directCommission = price * 0.55;

    const inviterWallet = await db.ref(`userIdMap/${inviterId}`).once('value').then(s => s.val());
    if (inviterWallet) {
        db.ref(`users/${inviterWallet.toLowerCase()}/ztrBalance`).transaction(balance => (balance || 0) + directCommission);
        // ... (add logic for upline and team commissions)
    }
}

async function distributeAirdropPoints(wallet, levelId) {
     const levels = await getLevelsConfig();
     const level = levels.find(l => l.id === levelId);
     if (level && level.airdropPoints > 0) {
        db.ref(`users/${wallet.toLowerCase()}/airdropPoints`).transaction(p => (p || 0) + level.airdropPoints);
        // ... (add logic for giving points to inviter too)
     }
}


// --- All Other Routes (Upgrade, Withdraw, Claim, etc.) would follow a similar pattern ---
// For brevity, they are omitted here but would be implemented with the same
// secure, server-side validation and logic.


// ===================================================================
// ========================= SERVER STARTUP ==========================
// ===================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 ZTR Backend Server is running on port ${PORT}`);
    console.log(`🔑 API Key Hint: ${API_KEY.substring(0, 8)}...`);
});
