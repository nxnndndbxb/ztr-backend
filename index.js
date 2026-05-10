const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

// ==================== CORS CONFIGURATION ====================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

// ==================== API KEY MIDDLEWARE FOR PROTECTED ROUTES ====================
const API_KEY = process.env.API_KEY || crypto.randomBytes(32).toString('hex');

const requireApiKey = (req, res, next) => {
    const providedKey = req.headers['x-api-key'];
    if (!providedKey || providedKey !== API_KEY) {
        return res.status(403).json({ success: false, error: "Unauthorized: Invalid API Key" });
    }
    next();
};

// ==================== RATE LIMITING (Simple In-Memory) ====================
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 30; // max requests per window

function rateLimiter(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    
    if (!rateLimitMap.has(ip)) {
        rateLimitMap.set(ip, { count: 1, startTime: now });
        return next();
    }
    
    const record = rateLimitMap.get(ip);
    if (now - record.startTime > RATE_LIMIT_WINDOW) {
        record.count = 1;
        record.startTime = now;
        return next();
    }
    
    record.count++;
    if (record.count > RATE_LIMIT_MAX) {
        return res.status(429).json({ success: false, error: "Too many requests. Please try again later." });
    }
    
    next();
}

app.use(rateLimiter);

// ==================== FIREBASE SETUP ====================
let db;
try {
    const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!serviceAccountBase64) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable is not set.");
    }
    
    const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('ascii'));
    
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DB_URL,
        databaseAuthVariableOverride: null
    });
    
    db = admin.database();
    console.log("✅ Firebase Admin initialized successfully");
} catch (error) {
    console.error("🔥 Firebase Admin Initialization Failed:", error.message);
    process.exit(1);
}

// ==================== BLOCKCHAIN CONFIGURATION ====================
const ADMIN_WALLET = (process.env.ADMIN_WALLET || "0x97efeaa1da1108acff52840550ec51dc5bbfd812").toLowerCase();
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY || "";
const USDT_CONTRACT = (process.env.USDT_CONTRACT || "0x55d398326f99059fF775485246999027B3197955").toLowerCase();
const BSC_RPC = process.env.BSC_RPC || "https://bsc-dataseed.binance.org/";

const provider = new ethers.JsonRpcProvider(BSC_RPC);
let adminWallet = null;

if (ADMIN_PRIVATE_KEY) {
    try {
        adminWallet = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);
        console.log("✅ Admin wallet loaded for transaction signing");
    } catch (error) {
        console.error("⚠️ Admin wallet initialization failed:", error.message);
    }
}

const usdtAbi = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address owner) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function symbol() view returns (string)",
    "function name() view returns (string)"
];

const usdtContract = new ethers.Contract(USDT_CONTRACT, usdtAbi, provider);

// ==================== CACHE SYSTEM ====================
let levelsCache = null;
let levelsCacheTime = 0;
let configCache = null;
let configCacheTime = 0;
const CACHE_TTL = 30000; // 30 seconds

// ==================== HELPER FUNCTIONS ====================

/**
 * Firebase retry logic with exponential backoff
 */
async function firebaseRetry(operation, retries = 3, baseDelay = 500) {
    for (let i = 0; i < retries; i++) {
        try {
            return await operation();
        } catch (error) {
            if (i === retries - 1) throw error;
            const delay = baseDelay * Math.pow(2, i);
            console.log(`🔄 Firebase Retry ${i + 1}/${retries} after ${delay}ms:`, error.message);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

/**
 * Generate secure random invite code
 */
async function generateInviteCode() {
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing chars
    let code, isUnique = false;
    
    for (let attempt = 0; attempt < 50 && !isUnique; attempt++) {
        code = '';
        const randomBytes = crypto.randomBytes(8);
        for (let i = 0; i < 8; i++) {
            code += characters.charAt(randomBytes[i] % characters.length);
        }
        const snapshot = await firebaseRetry(() => db.ref(`inviteCodeMap/${code}`).once('value'));
        if (!snapshot.exists()) isUnique = true;
    }
    
    if (!isUnique) {
        code = code + crypto.randomBytes(2).toString('hex').slice(0, 2).toUpperCase();
    }
    
    return code;
}

/**
 * Get levels configuration
 */
async function getLevelsConfig() {
    const now = Date.now();
    if (levelsCache && (now - levelsCacheTime) < CACHE_TTL) {
        return levelsCache;
    }
    
    const snapshot = await firebaseRetry(() => db.ref('config/levels').once('value'));
    let levels = snapshot.val();
    
    if (!levels || !Array.isArray(levels) || levels.length === 0) {
        levels = [
            { id: 0, name: "Starter", price: 5, salaryFund: 0.25, fee: 0, icon: "🌱", airdropPoints: 100, salary: 0, requiredTeamSize: 0 },
            { id: 1, name: "Iron", price: 5, salaryFund: 1, fee: 0.18, icon: "🛡️", airdropPoints: 100, salary: 0, requiredTeamSize: 0 },
            { id: 2, name: "Bronze", price: 10, salaryFund: 2, fee: 0.36, icon: "🥉", airdropPoints: 200, salary: 0, requiredTeamSize: 3 },
            { id: 3, name: "Silver", price: 15, salaryFund: 3, fee: 0.54, icon: "🥈", airdropPoints: 300, salary: 0, requiredTeamSize: 5 },
            { id: 4, name: "Gold", price: 20, salaryFund: 4, fee: 0.72, icon: "🥇", airdropPoints: 400, salary: 0, requiredTeamSize: 10 },
            { id: 5, name: "Master", price: 25, salaryFund: 5, fee: 0.9, icon: "👑", airdropPoints: 500, salary: 10, requiredTeamSize: 15 },
            { id: 6, name: "Grandmaster", price: 50, salaryFund: 10, fee: 1.8, icon: "⚔️", airdropPoints: 1000, salary: 25, requiredTeamSize: 25 },
            { id: 7, name: "Legend", price: 100, salaryFund: 20, fee: 3.6, icon: "🌟", airdropPoints: 2000, salary: 60, requiredTeamSize: 50 }
        ];
        console.warn("⚠️ Using fallback level configuration");
    }
    
    levelsCache = levels;
    levelsCacheTime = now;
    return levels;
}

/**
 * Get registration fee from Starter level
 */
async function getRegistrationFee() {
    const levels = await getLevelsConfig();
    const starterLevel = levels.find(l => l.id === 0);
    if (!starterLevel) return 5.25;
    return (starterLevel.price || 5) + (starterLevel.salaryFund || 0.25) + (starterLevel.fee || 0);
}

/**
 * Get ZTR base price from config
 */
async function getZTRPrice() {
    const snapshot = await firebaseRetry(() => db.ref('config/baseZTRPrice').once('value'));
    return snapshot.exists() && typeof snapshot.val() === 'number' ? snapshot.val() : 1.0;
}

/**
 * Get platform config
 */
async function getPlatformConfig() {
    const now = Date.now();
    if (configCache && (now - configCacheTime) < CACHE_TTL) {
        return configCache;
    }
    
    const levels = await getLevelsConfig();
    const registrationFee = await getRegistrationFee();
    const ztrPrice = await getZTRPrice();
    
    configCache = {
        levels,
        registrationFee,
        ztrPrice,
        adminWallet: ADMIN_WALLET,
        usdtContract: USDT_CONTRACT
    };
    configCacheTime = now;
    
    return configCache;
}

/**
 * Verify USDT transaction on blockchain with strict validation
 */
async function verifyTransaction(txHash, fromWallet, toWallet, expectedAmount, tolerancePercent = 0.5) {
    try {
        // Input validation
        if (!txHash || !ethers.isHexString(txHash, 32)) {
            console.log("❌ Invalid transaction hash format:", txHash);
            return false;
        }
        
        if (!ethers.isAddress(fromWallet) || !ethers.isAddress(toWallet)) {
            console.log("❌ Invalid wallet address format");
            return false;
        }
        
        // Check for duplicate transaction usage
        const txUsedSnapshot = await db.ref(`usedTransactions/${txHash}`).once('value');
        if (txUsedSnapshot.exists()) {
            console.log("❌ Transaction already used:", txHash);
            return false;
        }
        
        // Get transaction receipt
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt) {
            console.log("❌ Transaction receipt not found");
            return false;
        }
        
        if (receipt.status !== 1) {
            console.log("❌ Transaction failed on blockchain");
            return false;
        }
        
        // Verify block confirmations (require at least 3)
        const currentBlock = await provider.getBlockNumber();
        const confirmations = currentBlock - receipt.blockNumber;
        if (confirmations < 3) {
            console.log(`❌ Insufficient confirmations: ${confirmations}`);
            return false;
        }
        
        // Get USDT decimals
        const decimals = await usdtContract.decimals();
        const expectedAmountWei = ethers.parseUnits(parseFloat(expectedAmount).toFixed(Number(decimals)), decimals);
        const tolerance = (expectedAmountWei * BigInt(Math.floor(tolerancePercent * 100))) / BigInt(10000);
        const minRequired = expectedAmountWei - tolerance;
        const maxAllowed = expectedAmountWei + tolerance;
        
        const fromLower = fromWallet.toLowerCase();
        const toLower = toWallet.toLowerCase();
        
        // Check all transfer logs
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === USDT_CONTRACT.toLowerCase()) {
                try {
                    const parsedLog = usdtContract.interface.parseLog({
                        topics: log.topics,
                        data: log.data
                    });
                    
                    if (parsedLog && parsedLog.name === "Transfer") {
                        const { from, to, value } = parsedLog.args;
                        
                        if (
                            from.toLowerCase() === fromLower &&
                            to.toLowerCase() === toLower &&
                            value >= minRequired &&
                            value <= maxAllowed
                        ) {
                            // Mark transaction as used to prevent double-spending
                            await db.ref(`usedTransactions/${txHash}`).set({
                                from: fromLower,
                                to: toLower,
                                amount: value.toString(),
                                blockNumber: receipt.blockNumber,
                                timestamp: admin.database.ServerValue.TIMESTAMP
                            });
                            
                            console.log(`✅ Transaction verified: ${txHash}`);
                            return true;
                        }
                    }
                } catch (e) {
                    // Not a Transfer event, continue
                }
            }
        }
        
        console.log("❌ No matching transfer found in transaction logs");
        return false;
    } catch (error) {
        console.error("❌ Transaction verification error:", error.message);
        return false;
    }
}

/**
 * Get user download snapshot by wallet
 */
async function getUserByWallet(wallet) {
    if (!wallet || !ethers.isAddress(wallet)) return null;
    const walletLower = wallet.toLowerCase();
    const snapshot = await firebaseRetry(() => db.ref(`users/${walletLower}`).once('value'));
    return snapshot.exists() ? { key: walletLower, ...snapshot.val() } : null;
}

/**
 * Get wallet by user ID
 */
async function getWalletByUserId(userId) {
    const snapshot = await firebaseRetry(() => db.ref(`userIdMap/${userId}`).once('value'));
    return snapshot.exists() ? snapshot.val() : null;
}

/**
 * Get user ID by invite code
 */
async function getWalletByInviteCode(inviteCode) {
    if (!inviteCode || inviteCode.length !== 8) return null;
    const snapshot = await firebaseRetry(() => db.ref(`inviteCodeMap/${inviteCode.toUpperCase()}`).once('value'));
    return snapshot.exists() ? snapshot.val() : null;
}

/**
 * Add star to a user's level (for visual network tracking)
 */
async function addStarToLevel(recipientWallet, levelId, starType, sourceUserId) {
    if (!recipientWallet || !sourceUserId || levelId === undefined) return;
    
    try {
        const starRef = db.ref(`users/${recipientWallet.toLowerCase()}/levelStars/level_${levelId}`);
        const starData = {
            type: starType, // 'direct', 'upline', 'downline'
            sourceUserId: sourceUserId,
            timestamp: admin.database.ServerValue.TIMESTAMP,
            date: new Date().toISOString()
        };
        await starRef.push(starData);
        
        // Keep only last 10 stars per level
        const starsSnapshot = await starRef.once('value');
        if (starsSnapshot.exists()) {
            const stars = [];
            starsSnapshot.forEach(child => stars.push({ key: child.key, ...child.val() }));
            if (stars.length > 10) {
                stars.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
                const toDelete = stars.slice(0, stars.length - 10);
                for (const star of toDelete) {
                    await starRef.child(star.key).remove();
                }
            }
        }
    } catch (error) {
        console.error(`Star Error for wallet ${recipientWallet}:`, error.message);
    }
}

/**
 * Add ZTR commission to a user
 */
async function addCommission(userId, amount, type, starType, levelId, sourceUserId, starLevelId) {
    if (!userId || amount <= 0) return false;
    
    try {
        const wallet = await getWalletByUserId(userId);
        if (!wallet) {
            console.log(`⚠️ Wallet not found for userId: ${userId}`);
            return false;
        }
        
        const walletLower = wallet.toLowerCase();
        const userRef = db.ref(`users/${walletLower}`);
        
        // Update balance atomically
        await userRef.child('ztrBalance').transaction(balance => {
            return (balance || 0) + amount;
        });
        
        // Record income history
        const incomeEntry = {
            amount: amount,
            type: type,
            date: new Date().toISOString(),
            timestamp: admin.database.ServerValue.TIMESTAMP,
            starType: starType || null,
            levelId: levelId !== undefined ? levelId : null,
            sourceUserId: sourceUserId || null
        };
        await userRef.child('incomeHistory').push(incomeEntry);
        
        // Update platform stats
        await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + amount);
        
        // Add star if applicable
        if (starType && levelId !== undefined && sourceUserId && starLevelId !== undefined) {
            await addStarToLevel(walletLower, starLevelId, starType, sourceUserId);
        }
        
        // Log commission for auditing
        await db.ref('commissionLogs').push({
            userId: userId,
            wallet: walletLower,
            amount: amount,
            type: type,
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        
        return true;
    } catch (error) {
        console.error(`Commission Error for userId ${userId}:`, error.message);
        return false;
    }
}

/**
 * Distribute airdrop points and proportional ZTR
 */
async function distributeAirdropPoints(userWallet, levelId) {
    const levels = await getLevelsConfig();
    const levelConfig = levels.find(l => l.id === levelId);
    
    if (!levelConfig || !(levelConfig.airdropPoints > 0)) return;
    
    const points = levelConfig.airdropPoints;
    const ztrBonus = points * 0.001; // 10 ZTR per 10,000 points
    
    const awardPointsAndZTR = async (wallet) => {
        if (!wallet || !ethers.isAddress(wallet)) return;
        
        const walletLower = wallet.toLowerCase();
        const ref = db.ref(`users/${walletLower}`);
        
        // Update airdrop points
        await ref.child('airdropPoints').transaction(p => (p || 0) + points);
        
        // Update ZTR balance with bonus
        if (ztrBonus > 0) {
            await ref.child('ztrBalance').transaction(b => (b || 0) + ztrBonus);
            
            await ref.child('incomeHistory').push({
                amount: ztrBonus,
                type: `Level ${levelId} Airdrop Bonus`,
                date: new Date().toISOString(),
                timestamp: admin.database.ServerValue.TIMESTAMP
            });
        }
        
        // Update platform stats
        await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + points);
        await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + ztrBonus);
    };
    
    // Award to the user
    await awardPointsAndZTR(userWallet);
    
    // Award to inviter if exists
    const userData = await getUserByWallet(userWallet);
    if (userData && userData.inviterId) {
        const inviterWallet = await getWalletByUserId(userData.inviterId);
        if (inviterWallet) {
            await awardPointsAndZTR(inviterWallet);
        }
    }
}

/**
 * Distribute registration commissions
 * Commission Structure:
 * - 55% to Direct Inviter
 * - 7% to Upline (Inviter's Inviter)
 * - 20% Split among all existing Direct Members of Inviter (Team Commission)
 * - 18% remains (system/platform)
 */
async function distributeRegistrationCommissions(inviterId, newUserId, newUserWallet) {
    const levels = await getLevelsConfig();
    const starterPlan = levels.find(l => l.id === 0);
    if (!starterPlan) return;
    
    const commissionableAmount = starterPlan.price || 5;
    
    // 1. Direct Commission (55%) + STAR
    await addCommission(
        inviterId,
        commissionableAmount * 0.55,
        'Starter Direct Commission',
        'direct',
        0,
        newUserId,
        0
    );
    
    // 2. Upline Commission (7%) - Inviter's inviter
    const inviterWallet = await getWalletByUserId(inviterId);
    if (inviterWallet) {
        const inviterData = await getUserByWallet(inviterWallet);
        if (inviterData && inviterData.inviterId) {
            await addCommission(
                inviterData.inviterId,
                commissionableAmount * 0.07,
                'Starter Upline Commission',
                'upline',
                0,
                newUserId,
                0
            );
        }
        
        // 3. Team Commission (20%) - Split among direct members of inviter
        const teamSnapshot = await db.ref('users')
            .orderByChild('inviterId')
            .equalTo(inviterId)
            .once('value');
        
        if (teamSnapshot.exists()) {
            const teamMembers = [];
            teamSnapshot.forEach(snap => {
                const data = snap.val();
                if (data.profile && data.profile.userId !== newUserId) {
                    teamMembers.push(data.profile.userId);
                }
            });
            
            if (teamMembers.length > 0) {
                const sharePerMember = (commissionableAmount * 0.20) / teamMembers.length;
                for (const memberId of teamMembers) {
                    await addCommission(
                        memberId,
                        sharePerMember,
                        'Starter Team Commission',
                        'downline',
                        0,
                        newUserId,
                        0
                    );
                }
            }
        }
    }
    
    // Log the commission distribution
    await db.ref('commissionDistributionLogs').push({
        newUserId: newUserId,
        inviterId: inviterId,
        commissionableAmount: commissionableAmount,
        timestamp: admin.database.ServerValue.TIMESTAMP
    });
}

/**
 * Distribute upgrade commissions
 */
async function distributeUpgradeCommissions(wallet, levelId, levelPrice) {
    const userData = await getUserByWallet(wallet);
    if (!userData || !userData.inviterId) return;
    
    const inviterId = userData.inviterId;
    const userId = userData.profile?.userId;
    
    if (!userId) return;
    
    // Direct Commission (55%)
    await addCommission(
        inviterId,
        levelPrice * 0.55,
        `Level ${levelId} Direct Commission`,
        'direct',
        levelId,
        userId,
        levelId
    );
    
    // Upline Commission (7%)
    const inviterWallet = await getWalletByUserId(inviterId);
    if (inviterWallet) {
        const inviterData = await getUserByWallet(inviterWallet);
        if (inviterData && inviterData.inviterId) {
            await addCommission(
                inviterData.inviterId,
                levelPrice * 0.07,
                `Level ${levelId} Upline Commission`,
                'upline',
                levelId,
                userId,
                levelId
            );
        }
    }
    
    // Team Commission (20%)
    const teamSnapshot = await db.ref('users')
        .orderByChild('inviterId')
        .equalTo(inviterId)
        .once('value');
    
    if (teamSnapshot.exists()) {
        const teamMembers = [];
        teamSnapshot.forEach(snap => {
            const data = snap.val();
            if (snap.key !== wallet.toLowerCase() && data.profile) {
                teamMembers.push(data.profile.userId);
            }
        });
        
        if (teamMembers.length > 0) {
            const sharePerMember = (levelPrice * 0.20) / teamMembers.length;
            for (const memberId of teamMembers) {
                await addCommission(
                    memberId,
                    sharePerMember,
                    `Level ${levelId} Team Commission`,
                    'downline',
                    levelId,
                    userId,
                    levelId
                );
            }
        }
    }
}

// ==================== VALIDATION MIDDLEWARE ====================

function validateWallet(req, res, next) {
    const wallet = req.body.wallet || req.params.wallet;
    if (!wallet || !ethers.isAddress(wallet)) {
        return res.status(400).json({ success: false, error: "Invalid wallet address" });
    }
    next();
}

function validateTxHash(req, res, next) {
    const { txHash } = req.body;
    if (!txHash || !ethers.isHexString(txHash, 32)) {
        return res.status(400).json({ success: false, error: "Invalid transaction hash" });
    }
    next();
}

// ==================== API ROUTES ====================

/**
 * GET /api/config
 * Public - Get platform configuration
 */
app.get('/api/config', async (req, res) => {
    try {
        const config = await getPlatformConfig();
        res.json({ success: true, config });
    } catch (error) {
        console.error("Config error:", error);
        res.status(500).json({ success: false, error: "Failed to load configuration" });
    }
});

/**
 * POST /api/register
 * Register a new user after USDT payment verification
 */
app.post('/api/register', validateWallet, validateTxHash, async (req, res) => {
    const { wallet, txHash, inviterId, username, profilePic, registrationCost } = req.body;
    
    // Validate required fields
    if (!inviterId || !username) {
        return res.status(400).json({ success: false, error: "Missing required fields: inviterId, username" });
    }
    
    if (!Number.isInteger(inviterId) || inviterId < 1000) {
        return res.status(400).json({ success: false, error: "Invalid inviter ID" });
    }
    
    if (username.length < 3 || username.length > 30) {
        return res.status(400).json({ success: false, error: "Username must be between 3 and 30 characters" });
    }
    
    try {
        const walletLower = wallet.toLowerCase();
        
        // Check if user already exists
        const existingUser = await getUserByWallet(wallet);
        if (existingUser) {
            return res.status(400).json({ success: false, error: "Wallet is already registered" });
        }
        
        // Verify inviter exists
        const inviterWallet = await getWalletByUserId(inviterId);
        if (!inviterWallet) {
            return res.status(400).json({ success: false, error: "Invalid inviter ID. Inviter not found." });
        }
        
        // Get registration fee
        const regFee = await getRegistrationFee();
        const ztrPrice = await getZTRPrice();
        const expectedCost = (regFee * ztrPrice).toFixed(2);
        
        // Verify USDT payment
        const costToVerify = registrationCost || expectedCost;
        const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, costToVerify);
        
        if (!isValid) {
            return res.status(400).json({ 
                success: false, 
                error: "Payment verification failed. Please ensure you sent the correct USDT amount to the admin wallet." 
            });
        }
        
        // Generate user ID (incremental)
        const idResult = await db.ref('nextUserId').transaction(id => {
            return (id || 1000) + 1;
        });
        
        if (!idResult.committed) {
            return res.status(500).json({ success: false, error: "Failed to generate user ID. Please try again." });
        }
        
        const userId = idResult.snapshot.val();
        const inviteCode = await generateInviteCode();
        
        // Add starter salary fund to platform pool
        const levels = await getLevelsConfig();
        const starter = levels.find(l => l.id === 0);
        if (starter && starter.salaryFund > 0) {
            await db.ref('platformStats/totalWeeklySalaryFund').transaction(p => (p || 0) + starter.salaryFund);
        }
        
        // Create user record
        const userData = {
            profile: {
                name: username.substring(0, 30),
                userId: userId,
                joinDate: new Date().toLocaleDateString('en-GB', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric'
                }),
                profilePicUrl: profilePic || null
            },
            inviteCode: inviteCode,
            inviterId: parseInt(inviterId),
            paid: true,
            ztrBalance: 0,
            airdropPoints: 0, // Will be set by distributeAirdropPoints
            level: 0,
            teamSize: 0,
            levelStars: {},
            claimedTasks: {},
            incomeHistory: {},
            salaryHistory: {},
            registeredAt: admin.database.ServerValue.TIMESTAMP,
            registrationTxHash: txHash
        };
        
        // Save user data
        await db.ref(`users/${walletLower}`).set(userData);
        await db.ref(`userIdMap/${userId}`).set(walletLower);
        await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower);
        
        // Update inviter's team size
        await db.ref(`users/${inviterWallet.toLowerCase()}/teamSize`).transaction(s => (s || 0) + 1);
        
        // Distribute commissions
        await distributeRegistrationCommissions(parseInt(inviterId), userId, walletLower);
        
        // Distribute airdrop points
        await distributeAirdropPoints(walletLower, 0);
        
        // Update platform stats
        await db.ref('platformStats/totalParticipants').transaction(p => (p || 0) + 1);
        
        // Log registration
        await db.ref('registrationLogs').push({
            userId: userId,
            wallet: walletLower,
            inviterId: parseInt(inviterId),
            txHash: txHash,
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        
        console.log(`✅ New user registered: ID=${userId}, Wallet=${walletLower}`);
        
        res.status(201).json({
            success: true,
            userId: userId,
            inviteCode: inviteCode,
            message: "Registration successful!"
        });
        
    } catch (error) {
        console.error("Registration error:", error);
        res.status(500).json({ success: false, error: "Registration failed. Please try again." });
    }
});

/**
 * POST /api/upgrade
 * Upgrade user level after payment verification
 */
app.post('/api/upgrade', validateWallet, validateTxHash, async (req, res) => {
    const { wallet, txHash, levelId, upgradeCost, levelPrice } = req.body;
    
    if (levelId === undefined || levelId === null) {
        return res.status(400).json({ success: false, error: "Level ID is required" });
    }
    
    try {
        const walletLower = wallet.toLowerCase();
        const levels = await getLevelsConfig();
        const levelConfig = levels.find(l => l.id === levelId);
        
        if (!levelConfig) {
            return res.status(400).json({ success: false, error: "Invalid level ID" });
        }
        
        // Verify user exists
        const userData = await getUserByWallet(wallet);
        if (!userData) {
            return res.status(400).json({ success: false, error: "User not registered" });
        }
        
        // Check sequential upgrade
        const currentLevel = userData.level || 0;
        if (currentLevel !== levelId - 1) {
            return res.status(400).json({ 
                success: false, 
                error: `Sequential upgrade required. You must upgrade to Level ${currentLevel + 1} first.` 
            });
        }
        
        // Check team size requirement
        if (levelConfig.requiredTeamSize && userData.teamSize < levelConfig.requiredTeamSize) {
            return res.status(400).json({
                success: false,
                error: `You need ${levelConfig.requiredTeamSize} direct members to upgrade to ${levelConfig.name}. You have ${userData.teamSize}.`
            });
        }
        
        // Verify payment
        const totalCost = (levelConfig.price || 0) + (levelConfig.salaryFund || 0) + (levelConfig.fee || 0);
        const ztrPrice = await getZTRPrice();
        const expectedCost = (totalCost * ztrPrice).toFixed(2);
        const costToVerify = upgradeCost || expectedCost;
        
        const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, costToVerify);
        if (!isValid) {
            return res.status(400).json({ 
                success: false, 
                error: "Payment verification failed" 
            });
        }
        
        // Update level
        await db.ref(`users/${walletLower}/level`).set(levelId);
        
        // Add to salary fund if applicable
        if (levelConfig.salaryFund > 0) {
            await db.ref('platformStats/totalWeeklySalaryFund').transaction(p => (p || 0) + levelConfig.salaryFund);
        }
        
        // Distribute airdrop points
        await distributeAirdropPoints(walletLower, levelId);
        
        // Distribute commissions
        await distributeUpgradeCommissions(walletLower, levelId, levelPrice || levelConfig.price || 0);
        
        // Log upgrade
        await db.ref('upgradeLogs').push({
            wallet: walletLower,
            userId: userData.profile?.userId,
            fromLevel: currentLevel,
            toLevel: levelId,
            txHash: txHash,
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        
        console.log(`✅ User ${userData.profile?.userId} upgraded to Level ${levelId}`);
        
        res.json({ success: true, message: `Upgraded to ${levelConfig.name} successfully!` });
        
    } catch (error) {
        console.error("Upgrade error:", error);
        res.status(500).json({ success: false, error: "Upgrade failed. Please try again." });
    }
});

/**
 * POST /api/withdraw
 * Request ZTR withdrawal
 */
app.post('/api/withdraw', validateWallet, async (req, res) => {
    const { wallet } = req.body;
    
    try {
        const walletLower = wallet.toLowerCase();
        const userData = await getUserByWallet(wallet);
        
        if (!userData) {
            return res.status(400).json({ success: false, error: "User not found" });
        }
        
        const balance = userData.ztrBalance || 0;
        const minWithdrawal = 10;
        
        if (balance < minWithdrawal) {
            return res.status(400).json({ 
                success: false, 
                error: `Minimum withdrawal is ${minWithdrawal} ZTR. Your balance: ${balance.toFixed(2)} ZTR` 
            });
        }
        
        // Check for pending withdrawals
        const pendingSnapshot = await db.ref('withdrawals')
            .orderByChild('userWallet')
            .equalTo(walletLower)
            .once('value');
        
        let hasPending = false;
        if (pendingSnapshot.exists()) {
            pendingSnapshot.forEach(child => {
                if (child.val().status === 'pending') {
                    hasPending = true;
                }
            });
        }
        
        if (hasPending) {
            return res.status(400).json({ 
                success: false, 
                error: "You already have a pending withdrawal request" 
            });
        }
        
        // Create withdrawal request
        const withdrawalRef = await db.ref('withdrawals').push({
            userWallet: walletLower,
            userId: userData.profile?.userId,
            amount: balance,
            status: 'pending',
            requestedAt: admin.database.ServerValue.TIMESTAMP,
            date: new Date().toISOString()
        });
        
        // Reset balance to prevent double withdrawal
        await db.ref(`users/${walletLower}/ztrBalance`).set(0);
        
        // Log the withdrawal
        await db.ref(`users/${walletLower}/incomeHistory`).push({
            amount: -balance,
            type: 'Withdrawal Request',
            date: new Date().toISOString(),
            timestamp: admin.database.ServerValue.TIMESTAMP,
            withdrawalId: withdrawalRef.key
        });
        
        // Log for admin
        await db.ref('withdrawalLogs').push({
            withdrawalId: withdrawalRef.key,
            userWallet: walletLower,
            userId: userData.profile?.userId,
            amount: balance,
            status: 'pending',
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        
        console.log(`✅ Withdrawal request: ${balance} ZTR from ${walletLower}`);
        
        res.json({ 
            success: true, 
            message: `Withdrawal request for ${balance.toFixed(2)} ZTR submitted successfully. It will be processed shortly.`,
            withdrawalId: withdrawalRef.key
        });
        
    } catch (error) {
        console.error("Withdrawal error:", error);
        res.status(500).json({ success: false, error: "Withdrawal request failed" });
    }
});

/**
 * POST /api/claim-task-reward
 * Claim invitation task rewards
 */
app.post('/api/claim-task-reward', validateWallet, async (req, res) => {
    const { wallet, taskRequired, taskPoints } = req.body;
    
    if (!taskRequired || !taskPoints) {
        return res.status(400).json({ success: false, error: "Missing task details" });
    }
    
    try {
        const walletLower = wallet.toLowerCase();
        const userData = await getUserByWallet(wallet);
        
        if (!userData) {
            return res.status(400).json({ success: false, error: "User not found" });
        }
        
        const teamSize = userData.teamSize || 0;
        
        // Verify eligibility
        if (teamSize < taskRequired) {
            return res.status(400).json({ 
                success: false, 
                error: `You need ${taskRequired} direct members. You have ${teamSize}.` 
            });
        }
        
        // Prevent duplicate claims
        const taskKey = `task_${taskRequired}`;
        if (userData.claimedTasks && userData.claimedTasks[taskKey]) {
            return res.status(400).json({ success: false, error: "Task reward already claimed" });
        }
        
        const ztrBonus = taskPoints * 0.001; // 10 ZTR per 10,000 points
        
        // Update user data
        const userRef = db.ref(`users/${walletLower}`);
        await userRef.child(`claimedTasks/${taskKey}`).set(true);
        await userRef.child(`claimedTasks/${taskKey}_claimedAt`).set(admin.database.ServerValue.TIMESTAMP);
        await userRef.child('airdropPoints').transaction(p => (p || 0) + taskPoints);
        await userRef.child('ztrBalance').transaction(b => (b || 0) + ztrBonus);
        
        // Update platform stats
        await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + taskPoints);
        await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + ztrBonus);
        
        // Log claim
        await db.ref('taskClaimLogs').push({
            wallet: walletLower,
            userId: userData.profile?.userId,
            taskRequired: taskRequired,
            points: taskPoints,
            ztrBonus: ztrBonus,
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        
        console.log(`✅ Task claimed: User ${userData.profile?.userId}, Points=${taskPoints}, ZTR=${ztrBonus}`);
        
        res.json({ 
            success: true, 
            message: `Claimed ${taskPoints} points and ${ztrBonus} ZTR!`,
            points: taskPoints,
            ztrBonus: ztrBonus
        });
        
    } catch (error) {
        console.error("Task claim error:", error);
        res.status(500).json({ success: false, error: "Failed to claim reward" });
    }
});

/**
 * GET /api/user/:wallet
 * Get user data by wallet address
 */
app.get('/api/user/:wallet', async (req, res) => {
    const { wallet } = req.params;
    
    if (!ethers.isAddress(wallet)) {
        return res.status(400).json({ success: false, error: "Invalid wallet address" });
    }
    
    try {
        const userData = await getUserByWallet(wallet);
        
        if (!userData) {
            return res.status(404).json({ success: false, error: "User not found" });
        }
        
        const levels = await getLevelsConfig();
        const levelInfo = levels.find(l => l.id === (userData.level || 0)) || levels[0];
        
        // Remove sensitive data before sending
        const safeUserData = {
            profile: userData.profile || null,
            level: userData.level || 0,
            levelInfo: levelInfo,
            ztrBalance: userData.ztrBalance || 0,
            airdropPoints: userData.airdropPoints || 0,
            teamSize: userData.teamSize || 0,
            inviteCode: userData.inviteCode || '',
            inviterId: userData.inviterId || null,
            levelStars: userData.levelStars || {},
            claimedTasks: userData.claimedTasks || {},
            paid: userData.paid || false
        };
        
        res.json({ success: true, user: safeUserData });
        
    } catch (error) {
        console.error("Get user error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch user data" });
    }
});

/**
 * GET /api/team/:userId
 * Get direct team members of a user
 */
app.get('/api/team/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    
    if (!userId || userId < 1000) {
        return res.status(400).json({ success: false, error: "Invalid user ID" });
    }
    
    try {
        const teamSnapshot = await db.ref('users')
            .orderByChild('inviterId')
            .equalTo(userId)
            .once('value');
        
        const team = [];
        if (teamSnapshot.exists()) {
            teamSnapshot.forEach(snap => {
                const data = snap.val();
                if (data.profile) {
                    team.push({
                        wallet: snap.key,
                        profile: data.profile,
                        level: data.level || 0
                    });
                }
            });
        }
        
        res.json({ success: true, team });
        
    } catch (error) {
        console.error("Team fetch error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch team data" });
    }
});

/**
 * GET /api/platform-data
 * Get platform statistics and leaderboard
 */
app.get('/api/platform-data', async (req, res) => {
    try {
        const statsSnapshot = await db.ref('platformStats').once('value');
        const stats = statsSnapshot.val() || {};
        
        // Count total users (efficient - using cached value)
        stats.totalParticipants = stats.totalParticipants || 0;
        
        // Count salary active members (level >= 5)
        const salaryActiveSnapshot = await db.ref('users')
            .orderByChild('level')
            .startAt(5)
            .once('value');
        stats.salaryActiveMembers = salaryActiveSnapshot.numChildren();
        
        // Build leaderboard (top 100 by ZTR balance)
        const leaderboard = [];
        const topUsersSnapshot = await db.ref('users')
            .orderByChild('ztrBalance')
            .limitToLast(100)
            .once('value');
        
        if (topUsersSnapshot.exists()) {
            topUsersSnapshot.forEach(snap => {
                const data = snap.val();
                if (data.profile && (data.ztrBalance || 0) > 0) {
                    leaderboard.push({
                        name: data.profile.name,
                        userId: data.profile.userId,
                        profilePicUrl: data.profile.profilePicUrl || null,
                        earnings: data.ztrBalance || 0
                    });
                }
            });
        }
        
        // Sort leaderboard descending
        leaderboard.sort((a, b) => b.earnings - a.earnings);
        
        res.json({ 
            success: true, 
            stats, 
            leaderboard: leaderboard.slice(0, 100) 
        });
        
    } catch (error) {
        console.error("Platform data error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch platform data" });
    }
});

/**
 * GET /api/invite-info/:code
 * Get inviter info by invite code (for frontend verification)
 */
app.get('/api/invite-info/:code', async (req, res) => {
    const code = req.params.code?.toUpperCase();
    
    if (!code || code.length !== 8) {
        return res.status(400).json({ success: false, error: "Invalid invite code format" });
    }
    
    try {
        const wallet = await getWalletByInviteCode(code);
        if (!wallet) {
            return res.status(404).json({ success: false, error: "Invite code not found" });
        }
        
        const userData = await getUserByWallet(wallet);
        if (!userData || !userData.profile) {
            return res.status(404).json({ success: false, error: "Inviter not found" });
        }
        
        res.json({
            success: true,
            inviter: {
                name: userData.profile.name,
                userId: userData.profile.userId,
                profilePicUrl: userData.profile.profilePicUrl || null
            }
        });
        
    } catch (error) {
        console.error("Invite info error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch inviter info" });
    }
});

/**
 * POST /api/verify-payment
 * Verify a blockchain payment (useful for frontend to check)
 */
app.post('/api/verify-payment', async (req, res) => {
    const { txHash, fromWallet, toWallet, expectedAmount } = req.body;
    
    if (!txHash || !fromWallet || !toWallet || !expectedAmount) {
        return res.status(400).json({ success: false, error: "Missing parameters" });
    }
    
    try {
        const isValid = await verifyTransaction(txHash, fromWallet, toWallet, expectedAmount);
        res.json({ success: true, valid: isValid });
    } catch (error) {
        console.error("Payment verification error:", error);
        res.status(500).json({ success: false, error: "Verification failed" });
    }
});

/**
 * GET /api/health
 * Health check endpoint
 */
app.get('/api/health', async (req, res) => {
    try {
        // Check Firebase connection
        await db.ref('.info/connected').once('value');
        
        // Check BSC RPC connection
        const blockNumber = await provider.getBlockNumber();
        
        res.json({
            success: true,
            status: 'healthy',
            timestamp: new Date().toISOString(),
            blockNumber: blockNumber,
            adminWalletConfigured: !!ADMIN_PRIVATE_KEY
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            status: 'unhealthy',
            error: error.message
        });
    }
});

/**
 * GET /api/admin/stats (Protected)
 * Admin endpoint for detailed statistics
 */
app.get('/api/admin/stats', requireApiKey, async (req, res) => {
    try {
        const [statsSnapshot, usersSnapshot, withdrawalsSnapshot] = await Promise.all([
            db.ref('platformStats').once('value'),
            db.ref('users').once('value'),
            db.ref('withdrawals').orderByChild('status').equalTo('pending').once('value')
        ]);
        
        const stats = statsSnapshot.val() || {};
        const totalUsers = usersSnapshot.numChildren();
        const pendingWithdrawals = withdrawalsSnapshot.numChildren();
        
        // Calculate total ZTR in circulation
        let totalZTRInCirculation = 0;
        usersSnapshot.forEach(snap => {
            totalZTRInCirculation += (snap.val().ztrBalance || 0);
        });
        
        // Count users by level
        const usersByLevel = {};
        usersSnapshot.forEach(snap => {
            const level = snap.val().level || 0;
            usersByLevel[level] = (usersByLevel[level] || 0) + 1;
        });
        
        res.json({
            success: true,
            stats: {
                ...stats,
                totalUsers,
                totalZTRInCirculation,
                pendingWithdrawals,
                usersByLevel
            }
        });
        
    } catch (error) {
        console.error("Admin stats error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch admin stats" });
    }
});

/**
 * POST /api/admin/process-withdrawal (Protected)
 * Admin endpoint to process pending withdrawals
 */
app.post('/api/admin/process-withdrawal', requireApiKey, async (req, res) => {
    const { withdrawalId, action, txHash } = req.body;
    
    if (!withdrawalId || !action) {
        return res.status(400).json({ success: false, error: "Missing parameters" });
    }
    
    if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ success: false, error: "Action must be 'approve' or 'reject'" });
    }
    
    try {
        const withdrawalRef = db.ref(`withdrawals/${withdrawalId}`);
        const withdrawalSnapshot = await withdrawalRef.once('value');
        
        if (!withdrawalSnapshot.exists()) {
            return res.status(404).json({ success: false, error: "Withdrawal not found" });
        }
        
        const withdrawal = withdrawalSnapshot.val();
        
        if (withdrawal.status !== 'pending') {
            return res.status(400).json({ success: false, error: `Withdrawal is already ${withdrawal.status}` });
        }
        
        if (action === 'reject') {
            // Return ZTR to user
            await db.ref(`users/${withdrawal.userWallet}/ztrBalance`)
                .transaction(b => (b || 0) + withdrawal.amount);
            
            await withdrawalRef.update({
                status: 'rejected',
                rejectedAt: admin.database.ServerValue.TIMESTAMP,
                rejectionReason: req.body.reason || 'Rejected by admin'
            });
            
            // Log rejection
            await db.ref(`users/${withdrawal.userWallet}/incomeHistory`).push({
                amount: withdrawal.amount,
                type: 'Withdrawal Rejected (Returned)',
                date: new Date().toISOString(),
                timestamp: admin.database.ServerValue.TIMESTAMP
            });
            
            return res.json({ success: true, message: "Withdrawal rejected. Funds returned to user." });
        }
        
        // Approve - send USDT from admin wallet
        if (!ADMIN_PRIVATE_KEY || !adminWallet) {
            return res.status(500).json({ 
                success: false, 
                error: "Admin wallet not configured for automatic processing" 
            });
        }
        
        if (action === 'approve' && txHash) {
            // Manual approval with provided txHash
            await withdrawalRef.update({
                status: 'completed',
                approvedAt: admin.database.ServerValue.TIMESTAMP,
                txHash: txHash
            });
            
            return res.json({ success: true, message: "Withdrawal marked as completed." });
        }
        
        // Automatic USDT transfer
        const usdtWithSigner = new ethers.Contract(USDT_CONTRACT, usdtAbi, adminWallet);
        
        // Calculate USDT equivalent (assuming 1 ZTR = liveZTRPrice USDT)
        const ztrPrice = await getZTRPrice();
        const usdtAmount = ethers.parseUnits((withdrawal.amount * ztrPrice).toFixed(2), await usdtContract.decimals());
        
        // Check admin USDT balance
        const adminUsdtBalance = await usdtContract.balanceOf(ADMIN_WALLET);
        if (adminUsdtBalance < usdtAmount) {
            return res.status(500).json({ 
                success: false, 
                error: "Insufficient USDT in admin wallet" 
            });
        }
        
        // Send USDT
        const tx = await usdtWithSigner.transfer(withdrawal.userWallet, usdtAmount);
        await tx.wait();
        
        // Update withdrawal status
        await withdrawalRef.update({
            status: 'completed',
            approvedAt: admin.database.ServerValue.TIMESTAMP,
            txHash: tx.hash,
            usdtAmount: ethers.formatUnits(usdtAmount, await usdtContract.decimals())
        });
        
        console.log(`✅ Withdrawal processed: ${withdrawal.amount} ZTR → ${withdrawal.userWallet}`);
        
        res.json({ 
            success: true, 
            message: "Withdrawal processed successfully",
            txHash: tx.hash 
        });
        
    } catch (error) {
        console.error("Process withdrawal error:", error);
        res.status(500).json({ success: false, error: "Failed to process withdrawal" });
    }
});

// ==================== 404 HANDLER ====================
app.use((req, res) => {
    res.status(404).json({ success: false, error: "API endpoint not found" });
});

// ==================== GLOBAL ERROR HANDLER ====================
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 ZTR Backend running on port ${PORT}`);
    console.log(`📍 Admin Wallet: ${ADMIN_WALLET}`);
    console.log(`🔑 API Key Protected: ${!!API_KEY}`);
    console.log(`💳 USDT Contract: ${USDT_CONTRACT}`);
    console.log(`⛓️ BSC RPC: ${BSC_RPC}`);
    console.log(`👛 Admin Wallet for Signing: ${adminWallet ? '✅ Configured' : '❌ Not configured'}`);
});
