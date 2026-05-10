const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
require('dotenv').config();

const app = express();

// ========== SECURITY MIDDLEWARE ==========
app.use(helmet());
app.use(express.json({ limit: '10mb' }));

// Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { success: false, error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', limiter);

// Stricter CORS for production
app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// ========== FIREBASE INITIALIZATION ==========
let db;
try {
    const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!serviceAccountBase64) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64 not set");
    }
    
    const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('ascii'));
    
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DB_URL,
        databaseAuthVariableOverride: null
    });
    
    db = admin.database();
    console.log("✅ Firebase initialized");
} catch (error) {
    console.error("🔥 Firebase init failed:", error.message);
    process.exit(1);
}

// ========== BLOCKCHAIN CONFIGURATION ==========
const ADMIN_WALLET = process.env.ADMIN_WALLET || "0x97efeaa1da1108acff52840550ec51dc5bbfd812";
const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";
const BSC_RPC = process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org/";
const provider = new ethers.JsonRpcProvider(BSC_RPC);

const usdtAbi = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address owner) view returns (uint256)"
];
const usdtContract = new ethers.Contract(USDT_CONTRACT, usdtAbi, provider);

// ========== CONSTANTS ==========
const CACHE_TTL = 60000;
const MIN_WITHDRAWAL = 10;
const MAX_USERNAME_LENGTH = 30;
const MAX_INVITE_CODE_ATTEMPTS = 100;

// ========== CACHE ==========
let levelsCache = null;
let levelsCacheTime = 0;
let ztrPriceCache = null;
let ztrPriceCacheTime = 0;

// ========== HELPER FUNCTIONS ==========

async function firebaseRetry(operation, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await operation();
        } catch (error) {
            if (i === retries - 1) throw error;
            console.log(`Retry ${i + 1}/${retries}:`, error.message);
            await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
        }
    }
}

async function getLevelsConfig() {
    const now = Date.now();
    if (levelsCache && (now - levelsCacheTime) < CACHE_TTL) {
        return levelsCache;
    }
    
    try {
        const snapshot = await firebaseRetry(() => db.ref('config/levels').once('value'));
        let levels = snapshot.val();
        
        if (!levels || !Array.isArray(levels) || levels.length === 0) {
            levels = [
                { id: 0, name: "Starter", price: 5, salaryFund: 0.25, fee: 0, icon: "🌱", airdropPoints: 100, salary: 0 },
                { id: 1, name: "Iron", price: 5, salaryFund: 1, fee: 0.18, icon: "🛡️", airdropPoints: 100, salary: 0 },
                { id: 2, name: "Bronze", price: 10, salaryFund: 2, fee: 0.36, icon: "🥉", airdropPoints: 200, salary: 0 },
                { id: 3, name: "Silver", price: 15, salaryFund: 3, fee: 0.54, icon: "🥈", airdropPoints: 300, salary: 0 },
                { id: 4, name: "Gold", price: 20, salaryFund: 4, fee: 0.72, icon: "🥇", airdropPoints: 400, salary: 0 },
                { id: 5, name: "Master", price: 25, salaryFund: 5, fee: 0.9, icon: "👑", airdropPoints: 500, salary: 10 },
                { id: 6, name: "Grandmaster", price: 50, salaryFund: 10, fee: 1.8, icon: "⚔️", airdropPoints: 1000, salary: 25 },
                { id: 7, name: "Legend", price: 100, salaryFund: 20, fee: 3.6, icon: "🌟", airdropPoints: 2000, salary: 60 }
            ];
            console.warn("⚠️ Using fallback levels");
        }
        
        levelsCache = levels;
        levelsCacheTime = now;
        return levels;
    } catch (error) {
        console.error("Error getting levels:", error);
        throw error;
    }
}

async function getZTRPrice() {
    const now = Date.now();
    if (ztrPriceCache && (now - ztrPriceCacheTime) < CACHE_TTL) {
        return ztrPriceCache;
    }
    
    try {
        const snapshot = await firebaseRetry(() => db.ref('config/baseZTRPrice').once('value'));
        const price = snapshot.exists() && typeof snapshot.val() === 'number' ? snapshot.val() : 1.0;
        ztrPriceCache = price;
        ztrPriceCacheTime = now;
        return price;
    } catch (error) {
        console.error("Error getting ZTR price:", error);
        return 1.0;
    }
}

async function getRegistrationAmount() {
    const levels = await getLevelsConfig();
    const starterLevel = levels.find(l => l.id === 0);
    if (!starterLevel) throw new Error("Starter level not found");
    return starterLevel.price + starterLevel.salaryFund + starterLevel.fee;
}

async function verifyTransaction(txHash, fromWallet, toWallet, expectedAmount, tolerancePercent = 0.5) {
    try {
        if (!txHash || !ethers.isHexString(txHash, 32)) {
            return { success: false, error: "Invalid transaction hash" };
        }
        
        // Check for double spending
        const existingTx = await firebaseRetry(() => db.ref(`usedTransactions/${txHash}`).once('value'));
        if (existingTx.exists()) {
            return { success: false, error: "Transaction already used" };
        }
        
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt) {
            return { success: false, error: "Transaction not found" };
        }
        
        if (receipt.status !== 1) {
            return { success: false, error: "Transaction failed" };
        }
        
        const decimals = await usdtContract.decimals();
        const expectedAmountWei = ethers.parseUnits(expectedAmount.toFixed(Number(decimals)), decimals);
        const tolerance = (expectedAmountWei * BigInt(Math.floor(tolerancePercent * 100))) / BigInt(10000);
        const minRequired = expectedAmountWei - tolerance;
        
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === USDT_CONTRACT.toLowerCase()) {
                try {
                    const parsedLog = usdtContract.interface.parseLog(log);
                    if (parsedLog && parsedLog.name === "Transfer") {
                        const { from, to, value } = parsedLog.args;
                        if (from.toLowerCase() === fromWallet.toLowerCase() && 
                            to.toLowerCase() === toWallet.toLowerCase() && 
                            value >= minRequired) {
                            // Mark transaction as used
                            await db.ref(`usedTransactions/${txHash}`).set({
                                usedBy: fromWallet.toLowerCase(),
                                amount: expectedAmount,
                                timestamp: admin.database.ServerValue.TIMESTAMP
                            });
                            return { success: true };
                        }
                    }
                } catch (e) {
                    // Skip parsing errors
                }
            }
        }
        
        return { success: false, error: "No matching transfer found" };
    } catch (error) {
        console.error("Transaction verification error:", error);
        return { success: false, error: error.message };
    }
}

async function generateInviteCode() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    
    for (let attempt = 0; attempt < MAX_INVITE_CODE_ATTEMPTS; attempt++) {
        let code = '';
        for (let i = 0; i < 8; i++) {
            code += characters.charAt(Math.floor(Math.random() * characters.length));
        }
        
        const snapshot = await firebaseRetry(() => db.ref(`inviteCodeMap/${code}`).once('value'));
        if (!snapshot.exists()) {
            return code;
        }
    }
    
    // Fallback: add timestamp
    return 'CODE' + Date.now().toString(36).toUpperCase();
}

async function addCommission(userId, amount, type, starType, levelId, sourceUserId, starLevelId) {
    if (!userId || amount <= 0) return false;
    
    try {
        const walletSnapshot = await firebaseRetry(() => db.ref(`userIdMap/${userId}`).once('value'));
        if (!walletSnapshot.exists()) {
            console.error(`User ${userId} not found in userIdMap`);
            return false;
        }
        
        const wallet = walletSnapshot.val();
        const userRef = db.ref(`users/${wallet}`);
        
        // Update balance with transaction
        await userRef.child('ztrBalance').transaction(balance => {
            const newBalance = (balance || 0) + amount;
            return newBalance;
        });
        
        // Add to income history with enhanced data
        const historyEntry = {
            amount: amount,
            type: type,
            date: new Date().toISOString(),
            timestamp: admin.database.ServerValue.TIMESTAMP,
            fromUserId: sourceUserId || null,
            levelId: levelId || null
        };
        
        await userRef.child('incomeHistory').push(historyEntry);
        
        // Update platform stats
        await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + amount);
        
        // Add star if applicable
        if (starType && levelId !== undefined && sourceUserId) {
            const starRef = db.ref(`users/${wallet}/levelStars/level_${starLevelId !== undefined ? starLevelId : levelId}`);
            await starRef.push({
                type: starType,
                sourceUserId: sourceUserId,
                amount: amount,
                timestamp: admin.database.ServerValue.TIMESTAMP
            });
        }
        
        return true;
    } catch (error) {
        console.error(`Commission error for user ${userId}:`, error);
        return false;
    }
}

async function distributeAirdropPoints(userWallet, levelId) {
    try {
        const levels = await getLevelsConfig();
        const levelConfig = levels.find(l => l.id === levelId);
        if (!levelConfig || !(levelConfig.airdropPoints > 0)) return;
        
        const points = levelConfig.airdropPoints;
        const ztrBonus = points * 0.001;
        
        const awardPoints = async (wallet) => {
            const ref = db.ref(`users/${wallet}`);
            await ref.child('airdropPoints').transaction(p => (p || 0) + points);
            
            if (ztrBonus > 0) {
                await ref.child('ztrBalance').transaction(b => (b || 0) + ztrBonus);
                await ref.child('incomeHistory').push({
                    amount: ztrBonus,
                    type: 'Airdrop ZTR Bonus',
                    date: new Date().toISOString(),
                    timestamp: admin.database.ServerValue.TIMESTAMP,
                    levelId: levelId
                });
                await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + ztrBonus);
            }
            
            await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + points);
        };
        
        await awardPoints(userWallet);
        
        // Award inviter
        const userData = (await db.ref(`users/${userWallet}`).once('value')).val();
        if (userData && userData.inviterId) {
            const inviterWalletSnap = await db.ref(`userIdMap/${userData.inviterId}`).once('value');
            if (inviterWalletSnap.exists()) {
                await awardPoints(inviterWalletSnap.val());
            }
        }
    } catch (error) {
        console.error("Airdrop distribution error:", error);
    }
}

async function distributeRegistrationCommissions(inviterId, newUserId) {
    try {
        const levels = await getLevelsConfig();
        const starterPlan = levels.find(l => l.id === 0);
        if (!starterPlan) return;
        
        const commissionableAmount = starterPlan.price;
        const inviterWalletSnap = await db.ref(`userIdMap/${inviterId}`).once('value');
        if (!inviterWalletSnap.exists()) return;
        const inviterWallet = inviterWalletSnap.val();
        
        // 1. Direct Commission (55%)
        await addCommission(inviterId, commissionableAmount * 0.55, 'Direct Commission', 'direct', 0, newUserId, 0);
        
        // 2. Upline Commission (7%)
        const inviterData = (await db.ref(`users/${inviterWallet}`).once('value')).val();
        if (inviterData && inviterData.inviterId) {
            await addCommission(inviterData.inviterId, commissionableAmount * 0.07, 'Upline Commission', 'upline', 0, newUserId, 0);
        }
        
        // 3. Team Commission (20%)
        const teamMembersSnapshot = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
        const teamMembers = [];
        teamMembersSnapshot.forEach(snap => {
            const userId = snap.val().profile.userId;
            if (userId !== newUserId) {
                teamMembers.push(userId);
            }
        });
        
        if (teamMembers.length > 0) {
            const share = (commissionableAmount * 0.20) / teamMembers.length;
            for (const memberId of teamMembers) {
                await addCommission(memberId, share, 'Team Commission', 'downline', 0, newUserId, 0);
            }
        }
    } catch (error) {
        console.error("Registration commissions error:", error);
    }
}

async function distributeUpgradeCommissions(upgraderWallet, levelId, price) {
    try {
        const userSnap = await db.ref(`users/${upgraderWallet}`).once('value');
        const user = userSnap.val();
        if (!user || !user.inviterId) return;
        
        const inviterId = user.inviterId;
        const userId = user.profile.userId;
        
        // 1. Direct Commission (55%)
        await addCommission(inviterId, price * 0.55, `Level ${levelId} Direct Commission`, 'direct', levelId, userId, levelId);
        
        // 2. Upline Commission (7%)
        const inviterWalletSnap = await db.ref(`userIdMap/${inviterId}`).once('value');
        if (inviterWalletSnap.exists()) {
            const inviterData = (await db.ref(`users/${inviterWalletSnap.val()}`).once('value')).val();
            if (inviterData && inviterData.inviterId) {
                await addCommission(inviterData.inviterId, price * 0.07, `Level ${levelId} Upline Commission`, 'upline', levelId, userId, levelId);
            }
        }
        
        // 3. Team Commission (20%)
        const teamSnap = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
        const teamMembers = [];
        teamSnap.forEach(snap => {
            if (snap.key !== upgraderWallet) {
                teamMembers.push(snap.val().profile.userId);
            }
        });
        
        if (teamMembers.length > 0) {
            const share = (price * 0.20) / teamMembers.length;
            for (const memberId of teamMembers) {
                await addCommission(memberId, share, `Level ${levelId} Team Commission`, 'downline', levelId, userId, levelId);
            }
        }
    } catch (error) {
        console.error("Upgrade commissions error:", error);
    }
}

// ========== API ENDPOINTS ==========

// GET /api/config - Public configuration
app.get('/api/config', async (req, res) => {
    try {
        const levels = await getLevelsConfig();
        const registrationAmount = await getRegistrationAmount();
        const ztrPrice = await getZTRPrice();
        
        res.json({
            success: true,
            config: {
                levels,
                registrationAmount,
                ztrPrice,
                adminWallet: ADMIN_WALLET,
                usdtContract: USDT_CONTRACT,
                minWithdrawal: MIN_WITHDRAWAL
            }
        });
    } catch (error) {
        console.error("Config error:", error);
        res.status(500).json({ success: false, error: "Failed to load configuration" });
    }
});

// POST /api/verify-invite - Verify invite code
app.post('/api/verify-invite', async (req, res) => {
    const { inviteCode } = req.body;
    
    if (!inviteCode || typeof inviteCode !== 'string' || inviteCode.length > 10) {
        return res.status(400).json({ success: false, error: "Invalid invite code format" });
    }
    
    try {
        const codeMapSnap = await db.ref(`inviteCodeMap/${inviteCode.toUpperCase()}`).once('value');
        if (!codeMapSnap.exists()) {
            return res.status(404).json({ success: false, error: "Invite code not found" });
        }
        
        const inviterWallet = codeMapSnap.val();
        const userProfileSnap = await db.ref(`users/${inviterWallet}/profile`).once('value');
        
        if (!userProfileSnap.exists()) {
            return res.status(404).json({ success: false, error: "Inviter not found" });
        }
        
        res.json({
            success: true,
            inviter: userProfileSnap.val()
        });
    } catch (error) {
        console.error("Verify invite error:", error);
        res.status(500).json({ success: false, error: "Server error" });
    }
});

// POST /api/register - Register new user
app.post('/api/register', async (req, res) => {
    const { wallet, txHash, inviterId, username, profilePic } = req.body;
    
    // Validate input
    if (!wallet || !txHash || !inviterId || !username) {
        return res.status(400).json({ success: false, error: "Missing required fields" });
    }
    
    if (!ethers.isAddress(wallet)) {
        return res.status(400).json({ success: false, error: "Invalid wallet address" });
    }
    
    if (username.length > MAX_USERNAME_LENGTH) {
        return res.status(400).json({ success: false, error: `Username too long (max ${MAX_USERNAME_LENGTH} chars)` });
    }
    
    try {
        // Get registration amount from backend
        const registrationAmount = await getRegistrationAmount();
        
        // Verify payment
        const verification = await verifyTransaction(txHash, wallet, ADMIN_WALLET, registrationAmount);
        if (!verification.success) {
            return res.status(400).json({ success: false, error: verification.error });
        }
        
        const walletLower = wallet.toLowerCase();
        const userRef = db.ref(`users/${walletLower}`);
        
        // Check if user exists
        const existingUser = await userRef.once('value');
        if (existingUser.exists()) {
            return res.status(400).json({ success: false, error: "Wallet already registered" });
        }
        
        // Verify inviter exists
        const inviterRef = await db.ref(`userIdMap/${inviterId}`).once('value');
        if (!inviterRef.exists()) {
            return res.status(400).json({ success: false, error: "Invalid inviter ID" });
        }
        
        // Generate user ID
        const idRes = await db.ref('nextUserId').transaction(id => (id || 1000) + 1);
        const userId = idRes.snapshot.val();
        
        // Generate invite code
        const inviteCode = await generateInviteCode();
        
        // Get levels config
        const levels = await getLevelsConfig();
        const starter = levels.find(l => l.id === 0);
        
        // Add to salary fund if applicable
        if (starter && starter.salaryFund > 0) {
            await db.ref('platformStats/totalWeeklySalaryFund').transaction(p => (p || 0) + starter.salaryFund);
        }
        
        // Create user
        const userData = {
            profile: {
                name: username.trim(),
                userId: userId,
                joinDate: new Date().toISOString(),
                profilePicUrl: profilePic || null
            },
            inviteCode: inviteCode,
            inviterId: parseInt(inviterId),
            paid: true,
            ztrBalance: 0,
            airdropPoints: 0,
            level: 0,
            teamSize: 0,
            levelStars: {},
            claimedTasks: {},
            incomeHistory: {},
            salaryHistory: {},
            createdAt: admin.database.ServerValue.TIMESTAMP
        };
        
        await userRef.set(userData);
        
        // Update mappings
        await db.ref(`userIdMap/${userId}`).set(walletLower);
        await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower);
        
        // Update inviter's team size
        const inviterWalletAddr = inviterRef.val();
        await db.ref(`users/${inviterWalletAddr}/teamSize`).transaction(s => (s || 0) + 1);
        
        // Distribute commissions and airdrops
        await distributeRegistrationCommissions(parseInt(inviterId), userId);
        await distributeAirdropPoints(walletLower, 0);
        
        // Update platform stats
        await db.ref('platformStats/totalParticipants').transaction(p => (p || 0) + 1);
        await db.ref('platformStats/totalRegistrations').transaction(t => (t || 0) + 1);
        
        res.status(201).json({
            success: true,
            userId: userId,
            inviteCode: inviteCode,
            message: "Registration successful"
        });
    } catch (error) {
        console.error("Registration error:", error);
        res.status(500).json({ success: false, error: "Internal server error" });
    }
});

// POST /api/upgrade - Upgrade user level
app.post('/api/upgrade', async (req, res) => {
    const { wallet, txHash, levelId } = req.body;
    
    if (!wallet || !txHash || levelId === undefined) {
        return res.status(400).json({ success: false, error: "Missing required fields" });
    }
    
    if (!ethers.isAddress(wallet)) {
        return res.status(400).json({ success: false, error: "Invalid wallet address" });
    }
    
    try {
        const levels = await getLevelsConfig();
        const levelConfig = levels.find(l => l.id === levelId);
        
        if (!levelConfig) {
            return res.status(400).json({ success: false, error: "Invalid level" });
        }
        
        // Calculate upgrade cost (price + salaryFund + fee)
        const upgradeCost = levelConfig.price + levelConfig.salaryFund + levelConfig.fee;
        
        // Verify payment
        const verification = await verifyTransaction(txHash, wallet, ADMIN_WALLET, upgradeCost);
        if (!verification.success) {
            return res.status(400).json({ success: false, error: verification.error });
        }
        
        const walletLower = wallet.toLowerCase();
        const userRef = db.ref(`users/${walletLower}`);
        const userSnap = await userRef.once('value');
        
        if (!userSnap.exists()) {
            return res.status(404).json({ success: false, error: "User not found" });
        }
        
        const currentLevel = userSnap.val().level || 0;
        
        // Check sequential upgrade
        if (currentLevel !== levelId - 1) {
            return res.status(400).json({
                success: false,
                error: `Must upgrade sequentially. You are at level ${currentLevel}`
            });
        }
        
        // Add to salary fund
        if (levelConfig.salaryFund > 0) {
            await db.ref('platformStats/totalWeeklySalaryFund').transaction(p => (p || 0) + levelConfig.salaryFund);
        }
        
        // Update user level
        await userRef.child('level').set(levelId);
        
        // Record upgrade history
        await userRef.child('upgradeHistory').push({
            fromLevel: currentLevel,
            toLevel: levelId,
            cost: upgradeCost,
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        
        // Distribute rewards
        await distributeAirdropPoints(walletLower, levelId);
        await distributeUpgradeCommissions(walletLower, levelId, levelConfig.price);
        
        res.json({
            success: true,
            message: `Successfully upgraded to ${levelConfig.name} (Level ${levelId})`
        });
    } catch (error) {
        console.error("Upgrade error:", error);
        res.status(500).json({ success: false, error: "Internal server error" });
    }
});

// POST /api/withdraw - Request withdrawal
app.post('/api/withdraw', async (req, res) => {
    const { wallet, amount } = req.body;
    
    if (!wallet || !ethers.isAddress(wallet)) {
        return res.status(400).json({ success: false, error: "Invalid wallet address" });
    }
    
    if (!amount || amount < MIN_WITHDRAWAL) {
        return res.status(400).json({
            success: false,
            error: `Minimum withdrawal is ${MIN_WITHDRAWAL} ZTR`
        });
    }
    
    try {
        const walletLower = wallet.toLowerCase();
        const userRef = db.ref(`users/${walletLower}`);
        const userSnap = await userRef.once('value');
        
        if (!userSnap.exists()) {
            return res.status(404).json({ success: false, error: "User not found" });
        }
        
        const user = userSnap.val();
        const currentBalance = user.ztrBalance || 0;
        
        if (currentBalance < amount) {
            return res.status(400).json({
                success: false,
                error: `Insufficient balance. Available: ${currentBalance} ZTR`
            });
        }
        
        // Check for pending withdrawal
        const pendingWithdrawals = await db.ref('withdrawals')
            .orderByChild('userWallet')
            .equalTo(walletLower)
            .once('value');
        
        let hasPending = false;
        pendingWithdrawals.forEach(w => {
            if (w.val().status === 'pending') hasPending = true;
        });
        
        if (hasPending) {
            return res.status(400).json({
                success: false,
                error: "You already have a pending withdrawal request"
            });
        }
        
        // Create withdrawal request with transaction to prevent race conditions
        const result = await userRef.child('ztrBalance').transaction(balance => {
            if (balance < amount) return;
            return balance - amount;
        });
        
        if (!result.committed) {
            return res.status(400).json({ success: false, error: "Insufficient balance" });
        }
        
        // Create withdrawal request
        await db.ref('withdrawals').push({
            userWallet: walletLower,
            userId: user.profile.userId,
            username: user.profile.name,
            amount: amount,
            originalBalance: currentBalance,
            status: 'pending',
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        
        // Record withdrawal history
        await userRef.child('withdrawalHistory').push({
            amount: amount,
            status: 'pending',
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        
        res.json({
            success: true,
            message: "Withdrawal request submitted successfully",
            remainingBalance: currentBalance - amount
        });
    } catch (error) {
        console.error("Withdrawal error:", error);
        res.status(500).json({ success: false, error: "Internal server error" });
    }
});

// GET /api/user/:wallet - Get user data with full history
app.get('/api/user/:wallet', async (req, res) => {
    const { wallet } = req.params;
    
    if (!wallet || !ethers.isAddress(wallet)) {
        return res.status(400).json({ success: false, error: "Invalid wallet address" });
    }
    
    try {
        const walletLower = wallet.toLowerCase();
        const userSnap = await db.ref(`users/${walletLower}`).once('value');
        
        if (!userSnap.exists()) {
            return res.status(404).json({ success: false, error: "User not found" });
        }
        
        const user = userSnap.val();
        const levels = await getLevelsConfig();
        const levelInfo = levels.find(l => l.id === (user.level || 0));
        
        // Get income history (last 50 entries)
        let incomeHistory = [];
        if (user.incomeHistory) {
            incomeHistory = Object.entries(user.incomeHistory)
                .map(([key, value]) => ({ id: key, ...value }))
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
                .slice(0, 50);
        }
        
        // Get withdrawal history
        let withdrawalHistory = [];
        if (user.withdrawalHistory) {
            withdrawalHistory = Object.entries(user.withdrawalHistory)
                .map(([key, value]) => ({ id: key, ...value }))
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
                .slice(0, 20);
        }
        
        // Get upgrade history
        let upgradeHistory = [];
        if (user.upgradeHistory) {
            upgradeHistory = Object.entries(user.upgradeHistory)
                .map(([key, value]) => ({ id: key, ...value }))
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        }
        
        // Get salary history
        let salaryHistory = [];
        if (user.salaryHistory) {
            salaryHistory = Object.entries(user.salaryHistory)
                .map(([key, value]) => ({ id: key, ...value }))
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
                .slice(0, 20);
        }
        
        // Get team members
        const teamSnap = await db.ref('users').orderByChild('inviterId').equalTo(user.profile.userId).once('value');
        const teamMembers = [];
        teamSnap.forEach(snap => {
            teamMembers.push({
                wallet: snap.key,
                profile: snap.val().profile,
                level: snap.val().level || 0,
                joinDate: snap.val().createdAt
            });
        });
        
        res.json({
            success: true,
            user: {
                ...user,
                levelInfo,
                incomeHistory,
                withdrawalHistory,
                upgradeHistory,
                salaryHistory,
                teamMembers,
                teamSize: teamMembers.length
            }
        });
    } catch (error) {
        console.error("Get user error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch user data" });
    }
});

// GET /api/team/:userId - Get user's team
app.get('/api/team/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    
    if (isNaN(userId)) {
        return res.status(400).json({ success: false, error: "Invalid user ID" });
    }
    
    try {
        const teamSnapshot = await db.ref('users')
            .orderByChild('inviterId')
            .equalTo(userId)
            .once('value');
        
        const team = [];
        const promises = [];
        
        teamSnapshot.forEach(snap => {
            const userData = snap.val();
            promises.push(
                db.ref(`withdrawals`)
                    .orderByChild('userId')
                    .equalTo(userData.profile.userId)
                    .once('value')
                    .then(withdrawals => {
                        let totalWithdrawn = 0;
                        withdrawals.forEach(w => {
                            if (w.val().status === 'completed') {
                                totalWithdrawn += w.val().amount;
                            }
                        });
                        
                        team.push({
                            wallet: snap.key,
                            profile: userData.profile,
                            level: userData.level || 0,
                            ztrBalance: userData.ztrBalance || 0,
                            teamSize: userData.teamSize || 0,
                            totalWithdrawn: totalWithdrawn,
                            joinDate: userData.createdAt || userData.profile.joinDate
                        });
                    })
            );
        });
        
        await Promise.all(promises);
        
        // Sort by join date
        team.sort((a, b) => new Date(b.joinDate) - new Date(a.joinDate));
        
        res.json({ success: true, team });
    } catch (error) {
        console.error("Get team error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch team data" });
    }
});

// GET /api/platform-data - Platform statistics
app.get('/api/platform-data', async (req, res) => {
    try {
        const statsSnap = await db.ref('platformStats').once('value');
        const stats = statsSnap.val() || {};
        
        // Get active salary members (level 5+)
        const salaryActiveSnap = await db.ref('users')
            .orderByChild('level')
            .startAt(5)
            .once('value');
        stats.salaryActiveMembers = salaryActiveSnap.numChildren();
        
        // Get total users count
        const usersSnap = await db.ref('users').once('value');
        stats.totalUsers = usersSnap.numChildren();
        
        // Leaderboard - top 100 by ZTR balance
        const leaderboard = [];
        const topUsersSnap = await db.ref('users')
            .orderByChild('ztrBalance')
            .limitToLast(100)
            .once('value');
        
        const leaderboardPromises = [];
        topUsersSnap.forEach(u => {
            const val = u.val();
            if (val.profile) {
                leaderboardPromises.push(
                    db.ref(`withdrawals`)
                        .orderByChild('userId')
                        .equalTo(val.profile.userId)
                        .once('value')
                        .then(withdrawals => {
                            let totalWithdrawn = 0;
                            withdrawals.forEach(w => {
                                if (w.val().status === 'completed') {
                                    totalWithdrawn += w.val().amount;
                                }
                            });
                            
                            leaderboard.push({
                                name: val.profile.name,
                                userId: val.profile.userId,
                                profilePicUrl: val.profile.profilePicUrl || null,
                                earnings: val.ztrBalance || 0,
                                totalWithdrawn: totalWithdrawn,
                                level: val.level || 0
                            });
                        })
                );
            }
        });
        
        await Promise.all(leaderboardPromises);
        leaderboard.reverse();
        
        // Recent activities (last 20 registrations)
        const recentUsers = [];
        const recentUsersSnap = await db.ref('users')
            .orderByChild('createdAt')
            .limitToLast(20)
            .once('value');
        
        recentUsersSnap.forEach(u => {
            const val = u.val();
            if (val.profile) {
                recentUsers.push({
                    name: val.profile.name,
                    userId: val.profile.userId,
                    level: val.level || 0,
                    joinDate: val.createdAt || val.profile.joinDate
                });
            }
        });
        recentUsers.reverse();
        
        res.json({
            success: true,
            stats,
            leaderboard,
            recentUsers
        });
    } catch (error) {
        console.error("Platform data error:", error);
        res.status(500).json({ success: false, error: "Failed to load platform data" });
    }
});

// POST /api/claim-task-reward - Claim task reward
app.post('/api/claim-task-reward', async (req, res) => {
    const { wallet, taskRequired, taskPoints } = req.body;
    
    if (!wallet || !ethers.isAddress(wallet) || !taskRequired || !taskPoints) {
        return res.status(400).json({ success: false, error: "Missing required fields" });
    }
    
    try {
        const walletLower = wallet.toLowerCase();
        const userRef = db.ref(`users/${walletLower}`);
        const userSnap = await userRef.once('value');
        
        if (!userSnap.exists()) {
            return res.status(404).json({ success: false, error: "User not found" });
        }
        
        const user = userSnap.val();
        const teamSize = user.teamSize || 0;
        
        if (teamSize < taskRequired) {
            return res.status(400).json({
                success: false,
                error: `Need ${taskRequired} team members. You have ${teamSize}`
            });
        }
        
        const taskKey = `task_${taskRequired}`;
        if (user.claimedTasks && user.claimedTasks[taskKey]) {
            return res.status(400).json({ success: false, error: "Reward already claimed" });
        }
        
        const ztrBonus = taskPoints * 0.001;
        
        // Mark as claimed
        await userRef.child(`claimedTasks/${taskKey}`).set({
            claimedAt: admin.database.ServerValue.TIMESTAMP,
            teamSize: teamSize,
            points: taskPoints,
            ztrBonus: ztrBonus
        });
        
        // Add points and ZTR
        await userRef.child('airdropPoints').transaction(p => (p || 0) + taskPoints);
        await userRef.child('ztrBalance').transaction(b => (b || 0) + ztrBonus);
        
        // Record in income history
        await userRef.child('incomeHistory').push({
            amount: ztrBonus,
            type: 'Task Reward',
            taskRequired: taskRequired,
            taskPoints: taskPoints,
            date: new Date().toISOString(),
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        
        // Update platform stats
        await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + taskPoints);
        await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + ztrBonus);
        
        res.json({
            success: true,
            message: `Claimed ${taskPoints} points and ${ztrBonus} ZTR!`,
            points: taskPoints,
            ztrBonus: ztrBonus
        });
    } catch (error) {
        console.error("Claim task error:", error);
        res.status(500).json({ success: false, error: "Failed to claim reward" });
    }
});

// GET /api/user-income/:wallet - Get user's income history only
app.get('/api/user-income/:wallet', async (req, res) => {
    const { wallet } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    
    if (!wallet || !ethers.isAddress(wallet)) {
        return res.status(400).json({ success: false, error: "Invalid wallet address" });
    }
    
    try {
        const walletLower = wallet.toLowerCase();
        const userSnap = await db.ref(`users/${walletLower}/incomeHistory`).once('value');
        
        if (!userSnap.exists()) {
            return res.json({ success: true, history: [], total: 0 });
        }
        
        let history = Object.entries(userSnap.val())
            .map(([key, value]) => ({ id: key, ...value }))
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        
        const total = history.length;
        history = history.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
        
        res.json({ success: true, history, total });
    } catch (error) {
        console.error("Get income error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch income history" });
    }
});

// GET /api/leaderboard - Get leaderboard with pagination
app.get('/api/leaderboard', async (req, res) => {
    const { type = 'earnings', limit = 50 } = req.query;
    
    try {
        let leaderboard = [];
        
        if (type === 'earnings') {
            const usersSnap = await db.ref('users')
                .orderByChild('ztrBalance')
                .limitToLast(parseInt(limit))
                .once('value');
            
            const promises = [];
            usersSnap.forEach(u => {
                const val = u.val();
                if (val.profile) {
                    promises.push(
                        db.ref(`withdrawals`)
                            .orderByChild('userId')
                            .equalTo(val.profile.userId)
                            .once('value')
                            .then(withdrawals => {
                                let totalWithdrawn = 0;
                                withdrawals.forEach(w => {
                                    if (w.val().status === 'completed') {
                                        totalWithdrawn += w.val().amount;
                                    }
                                });
                                
                                leaderboard.push({
                                    rank: 0,
                                    name: val.profile.name,
                                    userId: val.profile.userId,
                                    profilePicUrl: val.profile.profilePicUrl || null,
                                    value: val.ztrBalance || 0,
                                    totalWithdrawn: totalWithdrawn,
                                    level: val.level || 0
                                });
                            })
                    );
                }
            });
            
            await Promise.all(promises);
            leaderboard.sort((a, b) => b.value - a.value);
            
        } else if (type === 'team') {
            const usersSnap = await db.ref('users')
                .orderByChild('teamSize')
                .limitToLast(parseInt(limit))
                .once('value');
            
            usersSnap.forEach(u => {
                const val = u.val();
                if (val.profile && val.profile.name) {
                    leaderboard.push({
                        rank: 0,
                        name: val.profile.name,
                        userId: val.profile.userId,
                        profilePicUrl: val.profile.profilePicUrl || null,
                        value: val.teamSize || 0,
                        level: val.level || 0
                    });
                }
            });
            leaderboard.sort((a, b) => b.value - a.value);
        }
        
        // Assign ranks
        leaderboard.forEach((item, index) => {
            item.rank = index + 1;
        });
        
        res.json({ success: true, leaderboard, type });
    } catch (error) {
        console.error("Leaderboard error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch leaderboard" });
    }
});

// GET /api/check-registration-amount - Get current registration amount
app.get('/api/check-registration-amount', async (req, res) => {
    try {
        const amount = await getRegistrationAmount();
        const levels = await getLevelsConfig();
        const starterLevel = levels.find(l => l.id === 0);
        
        res.json({
            success: true,
            amount: amount,
            breakdown: {
                price: starterLevel.price,
                salaryFund: starterLevel.salaryFund,
                fee: starterLevel.fee
            }
        });
    } catch (error) {
        console.error("Registration amount error:", error);
        res.status(500).json({ success: false, error: "Failed to get registration amount" });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ success: false, error: "Endpoint not found" });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
