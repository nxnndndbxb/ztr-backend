const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();

// --- Enhanced CORS Configuration ---
app.use(cors({
    origin: '*',
    methods:['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());
app.use(express.json());

// --- Firebase Admin Setup ---
let db;
try {
    const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!serviceAccountBase64) {
        throw new Error("FATAL ERROR: FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable is not set.");
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

// --- Blockchain & Contract Configuration ---
const ADMIN_WALLET = "0x97efeaa1da1108acff52840550ec51dc5bbfd812";
const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";
const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/");

const usdtAbi =[
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address owner) view returns (uint256)"
];

const usdtContract = new ethers.Contract(USDT_CONTRACT, usdtAbi, provider);

// --- Cache for frequently accessed data ---
let levelsCache = null;
let levelsCacheTime = 0;
const CACHE_TTL = 60000; // 1 minute

// --- Helper Functions with Retry Logic ---
async function firebaseRetry(operation, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await operation();
        } catch (error) {
            if (i === retries - 1) throw error;
            console.log(`Retry ${i + 1}/${retries} after error:`, error.message);
            await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
        }
    }
}

async function getLevelsConfig() {
    const now = Date.now();
    if (levelsCache && (now - levelsCacheTime) < CACHE_TTL) {
        return levelsCache;
    }
    
    const snapshot = await firebaseRetry(() => db.ref('config/levels').once('value'));
    let levels = snapshot.val();
    
    if (!levels || !Array.isArray(levels) || levels.length === 0) {
        // Fallback configuration updated to include Level 0 (Starter)
        levels =[
            { id: 0, name: "Starter", price: 5, salaryFund: 0, fee: 0.25, icon: "🌱", airdropPoints: 100, salary: 0 },
            { id: 1, name: "Iron", price: 5, salaryFund: 1, fee: 0.18, icon: "🛡️", airdropPoints: 100, salary: 0 },
            { id: 2, name: "Bronze", price: 10, salaryFund: 2, fee: 0.36, icon: "🥉", airdropPoints: 200, salary: 0 },
            { id: 3, name: "Silver", price: 15, salaryFund: 3, fee: 0.54, icon: "🥈", airdropPoints: 300, salary: 0 },
            { id: 4, name: "Gold", price: 20, salaryFund: 4, fee: 0.72, icon: "🥇", airdropPoints: 400, salary: 0 },
            { id: 5, name: "Master", price: 25, salaryFund: 5, fee: 0.9, icon: "👑", airdropPoints: 500, salary: 10 },
            { id: 6, name: "Grandmaster", price: 50, salaryFund: 10, fee: 1.8, icon: "⚔️", airdropPoints: 1000, salary: 25 },
            { id: 7, name: "Legend", price: 100, salaryFund: 20, fee: 3.6, icon: "🌟", airdropPoints: 2000, salary: 60 }
        ];
        console.warn("⚠️ Using fallback level configuration");
    }
    
    levelsCache = levels;
    levelsCacheTime = now;
    return levels;
}

async function getRegistrationFee() {
    const levels = await getLevelsConfig();
    const level0 = levels.find(l => l.id === 0);
    const price = level0 ? (level0.price || 0) : 5;
    const salaryFund = level0 ? (level0.salaryFund || 0) : 0;
    const fee = level0 ? (level0.fee || 0) : 0.25;
    return price + salaryFund + fee;
}

async function getZTRPrice() {
    const snapshot = await firebaseRetry(() => db.ref('config/baseZTRPrice').once('value'));
    return snapshot.exists() && typeof snapshot.val() === 'number' ? snapshot.val() : 1.0;
}

/**
 * Verifies a USDT transaction with improved validation
 */
async function verifyTransaction(txHash, fromWallet, toWallet, expectedAmount, tolerancePercent = 0.5) {
    try {
        if (!txHash || !ethers.isHexString(txHash, 32)) {
            console.log(`Invalid transaction hash format: ${txHash}`);
            return false;
        }
        
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt) {
            console.log(`No receipt found for ${txHash}`);
            return false;
        }
        
        if (receipt.status !== 1) {
            console.log(`Transaction ${txHash} failed on-chain (status: ${receipt.status})`);
            return false;
        }
        
        const decimals = await usdtContract.decimals();
        const expectedAmountWei = ethers.parseUnits(parseFloat(expectedAmount).toFixed(Number(decimals)), decimals);
        
        // Calculate tolerance (0.5% default)
        const tolerance = (expectedAmountWei * BigInt(Math.floor(tolerancePercent * 100))) / BigInt(10000);
        const minRequired = expectedAmountWei - tolerance;
        
        // Search through logs for Transfer event
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === USDT_CONTRACT.toLowerCase()) {
                try {
                    const parsedLog = usdtContract.interface.parseLog(log);
                    if (parsedLog && parsedLog.name === "Transfer") {
                        const { from, to, value } = parsedLog.args;
                        if (from.toLowerCase() === fromWallet.toLowerCase() &&
                            to.toLowerCase() === toWallet.toLowerCase() &&
                            value >= minRequired) {
                            console.log(`✅ Transaction ${txHash} verified: ${ethers.formatUnits(value, decimals)} USDT transferred`);
                            return true;
                        }
                    }
                } catch (e) {
                    // Skip non-Transfer events
                }
            }
        }
        
        console.log(`❌ No matching USDT Transfer event found in ${txHash}`);
        return false;
    } catch (error) {
        console.error(`Error verifying transaction ${txHash}:`, error);
        return false;
    }
}

/**
 * Generates a unique invite code
 */
async function generateInviteCode() {
    let code, isUnique = false;
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const maxAttempts = 100;
    
    for (let attempt = 0; attempt < maxAttempts && !isUnique; attempt++) {
        code = '';
        for (let i = 0; i < 8; i++) {
            code += characters.charAt(Math.floor(Math.random() * characters.length));
        }
        
        const snapshot = await firebaseRetry(() => db.ref(`inviteCodeMap/${code}`).once('value'));
        if (!snapshot.exists()) {
            isUnique = true;
        }
    }
    
    if (!isUnique) {
        // Fallback: add timestamp to ensure uniqueness
        code = code + Date.now().toString(36).slice(-2);
    }
    
    return code;
}

/**
 * Adds a star to level matrix
 */
async function addStarToLevel(recipientWallet, levelId, starType, sourceUserId) {
    if (!recipientWallet || starType == null || sourceUserId == null) {
        console.error("addStarToLevel Error: Missing required parameters");
        return;
    }
    
    try {
        const starRef = db.ref(`users/${recipientWallet.toLowerCase()}/levelStars/level_${levelId}`);
        await starRef.push({
            type: starType,
            sourceUserId: sourceUserId,
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        console.log(`⭐ Added '${starType}' star to level ${levelId} for ${recipientWallet} from user ${sourceUserId}`);
    } catch (error) {
        console.error(`Failed to add star for ${recipientWallet}:`, error);
    }
}

/**
 * Helper to credit commission and update stats
 */
async function addCommission(userId, amount, type, starType, levelId, sourceUserId, starLevelId) {
    if (!userId || isNaN(userId) || amount <= 0) return false;
    
    try {
        const walletSnapshot = await firebaseRetry(() => db.ref(`userIdMap/${userId}`).once('value'));
        if (!walletSnapshot.exists()) return false;
        
        const wallet = walletSnapshot.val();
        const userRef = db.ref(`users/${wallet}`);
        
        // Update balance with transaction for consistency
        await userRef.child('ztrBalance').transaction(balance => (balance || 0) + amount);
        
        // Add to income history
        await userRef.child('incomeHistory').push({
            amount: amount,
            type: type,
            date: new Date().toISOString(),
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        
        // Update total ZTR distributed stat
        await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + amount);
        
        // Add star if applicable (Checking strict undefined to allow level 0)
        if (starType !== undefined && levelId !== undefined && sourceUserId !== undefined) {
            await addStarToLevel(wallet, starLevelId !== undefined ? starLevelId : levelId, starType, sourceUserId);
        }
        
        console.log(`💰 Credited ${amount.toFixed(4)} ZTR to User ${userId} (${type})`);
        return true;
    } catch (error) {
        console.error(`Failed to add commission for user ${userId}:`, error);
        return false;
    }
}

/**
 * Distributes registration commissions
 */
async function distributeRegistrationCommissions(inviterId, newUserId) {
    const levels = await getLevelsConfig();
    const level0 = levels.find(l => l.id === 0);
    
    if (!level0 || typeof level0.price !== 'number') {
        console.warn("⚠️ Level 0 price not configured, using fallback of 5");
    }
    
    const commissionableAmount = level0 ? level0.price : 5;
    console.log(`📊 Distributing registration commission for Level 0: ${commissionableAmount} ZTR`);
    
    // 1. Direct Commission (55%) - Level 0 Star
    await addCommission(inviterId, commissionableAmount * 0.55, 'Direct Commission', 'direct', 0, newUserId, 0);
    
    // 2. Upline Commission (7%) - Level 0 Star
    const inviterWallet = await firebaseRetry(() => db.ref(`userIdMap/${inviterId}`).once('value'));
    if (inviterWallet.exists()) {
        const inviterData = await firebaseRetry(() => db.ref(`users/${inviterWallet.val()}`).once('value'));
        if (inviterData.exists() && inviterData.val().inviterId) {
            await addCommission(inviterData.val().inviterId, commissionableAmount * 0.07, 'Upline Commission', 'upline', 0, newUserId, 0);
        }
    }
    
    // 3. Team Commission (20%) - Split among existing direct members - Level 0 Star
    const teamCommissionPool = commissionableAmount * 0.20;
    const teamMembersSnapshot = await firebaseRetry(() => db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value'));
    
    if (teamMembersSnapshot.exists()) {
        const team =[];
        teamMembersSnapshot.forEach(childSnapshot => {
            const userData = childSnapshot.val();
            if (userData.profile && userData.profile.userId !== newUserId) {
                team.push({
                    wallet: childSnapshot.key,
                    userId: userData.profile.userId
                });
            }
        });
        
        if (team.length > 0) {
            const sharePerMember = teamCommissionPool / team.length;
            for (const member of team) {
                await addCommission(member.userId, sharePerMember, 'Team Commission', 'downline', 0, newUserId, 0);
            }
            console.log(`👥 Team commission split among ${team.length} members: ${sharePerMember.toFixed(4)} ZTR each`);
        }
    }
}

/**
 * Distributes upgrade commissions
 */
async function distributeUpgradeCommissions(upgradingUserWallet, levelId, levelPrice) {
    const upgradingUserData = await firebaseRetry(() => db.ref(`users/${upgradingUserWallet.toLowerCase()}`).once('value'));
    const upgradingUser = upgradingUserData.val();
    
    if (!upgradingUser || !upgradingUser.inviterId || !upgradingUser.profile) return;
    
    const upgradingUserId = upgradingUser.profile.userId;
    const inviterId = upgradingUser.inviterId;
    const commissionableAmount = levelPrice;
    
    console.log(`📊 Distributing upgrade commission for level ${levelId}: ${commissionableAmount} ZTR`);
    
    // 1. Direct Commission (55%)
    await addCommission(inviterId, commissionableAmount * 0.55, 'Direct Upgrade Commission', 'direct', levelId, upgradingUserId, levelId);
    
    // 2. Upline Commission (7%)
    const inviterWallet = await firebaseRetry(() => db.ref(`userIdMap/${inviterId}`).once('value'));
    if (inviterWallet.exists()) {
        const inviterData = await firebaseRetry(() => db.ref(`users/${inviterWallet.val()}`).once('value'));
        if (inviterData.exists() && inviterData.val().inviterId) {
            await addCommission(inviterData.val().inviterId, commissionableAmount * 0.07, 'Upline Upgrade Commission', 'upline', levelId, upgradingUserId, levelId);
        }
    }
    
    // 3. Team Commission (20%)
    const teamCommissionPool = commissionableAmount * 0.20;
    const teamMembersSnapshot = await firebaseRetry(() => db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value'));
    
    if (teamMembersSnapshot.exists()) {
        const team =[];
        teamMembersSnapshot.forEach(childSnapshot => {
            if (childSnapshot.key.toLowerCase() !== upgradingUserWallet.toLowerCase()) {
                const userData = childSnapshot.val();
                if (userData.profile) {
                    team.push({
                        wallet: childSnapshot.key,
                        userId: userData.profile.userId
                    });
                }
            }
        });
        
        if (team.length > 0) {
            const share = teamCommissionPool / team.length;
            for (const member of team) {
                await addCommission(member.userId, share, 'Team Upgrade Commission', 'downline', levelId, upgradingUserId, levelId);
            }
            console.log(`👥 Team upgrade commission split among ${team.length} members: ${share.toFixed(4)} ZTR each`);
        }
    }
}

/**
 * Distributes airdrop points
 */
async function distributeAirdropPoints(userWallet, levelId) {
    const levels = await getLevelsConfig();
    const levelConfig = levels.find(l => l.id === levelId);
    
    if (!levelConfig || !(levelConfig.airdropPoints > 0)) return;
    
    const points = levelConfig.airdropPoints;
    const userRef = db.ref(`users/${userWallet}`);
    
    // Award points to upgrader
    await userRef.child('airdropPoints').transaction(p => (p || 0) + points);
    await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + points);
    console.log(`🎁 Awarded ${points} airdrop points to ${userWallet} for level ${levelId}`);
    
    // Award same points to inviter
    const userData = await userRef.once('value');
    if (userData.exists() && userData.val().inviterId) {
        const inviterWallet = await firebaseRetry(() => db.ref(`userIdMap/${userData.val().inviterId}`).once('value'));
        if (inviterWallet.exists()) {
            await db.ref(`users/${inviterWallet.val()}/airdropPoints`).transaction(p => (p || 0) + points);
            await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + points);
            console.log(`🎁 Awarded ${points} airdrop points to inviter ${inviterWallet.val()}`);
        }
    }
}

// ==================== API ENDPOINTS ====================

/**
 * GET /api/health - Health check endpoint
 */
app.get('/api/health', (req, res) => {
    res.json({ 
        success: true, 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

/**
 * GET /api/config - Get platform configuration
 */
app.get('/api/config', async (req, res) => {
    try {
        const levels = await getLevelsConfig();
        const registrationFee = await getRegistrationFee();
        const ztrPrice = await getZTRPrice();
        
        res.json({
            success: true,
            config: {
                levels,
                registrationFee,
                ztrPrice,
                adminWallet: ADMIN_WALLET,
                usdtContract: USDT_CONTRACT
            }
        });
    } catch (error) {
        console.error("Config fetch error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch configuration" });
    }
});

/**
 * POST /api/register - Register new user
 */
app.post('/api/register', async (req, res) => {
    const { wallet, txHash, inviterId, username, profilePic, registrationCost } = req.body;
    
    // Validate required fields
    if (!wallet || !txHash || !inviterId || !username || !registrationCost) {
        return res.status(400).json({ success: false, error: "Missing required registration fields." });
    }
    
    // Validate wallet address format
    if (!/^0x[a-fA-F0-9]{40}$/i.test(wallet)) {
        return res.status(400).json({ success: false, error: "Invalid wallet address format." });
    }
    
    // Validate username
    if (username.length < 3 || username.length > 30) {
        return res.status(400).json({ success: false, error: "Username must be between 3 and 30 characters." });
    }
    
    try {
        // Verify transaction
        const registrationFee = await getRegistrationFee();
        const ztrPrice = await getZTRPrice();
        const expectedCost = (registrationFee * ztrPrice).toFixed(2);
        
        // Allow small tolerance (0.05 USDT)
        if (Math.abs(parseFloat(registrationCost) - parseFloat(expectedCost)) > 0.05) {
            console.warn(`Registration cost mismatch: expected ${expectedCost}, got ${registrationCost}`);
        }
        
        const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, registrationCost);
        if (!isValid) {
            return res.status(400).json({ success: false, error: "Transaction could not be verified." });
        }
        
        const walletLower = wallet.toLowerCase();
        const userRef = db.ref(`users/${walletLower}`);
        
        // Check if already registered
        const snapshot = await userRef.once('value');
        if (snapshot.exists() && snapshot.val().profile) {
            return res.status(400).json({ success: false, error: "This wallet is already registered." });
        }
        
        // Generate unique user ID
        const idResult = await db.ref('nextUserId').transaction(id => (id || 1000) + 1);
        if (!idResult.committed) {
            throw new Error("Could not generate a unique user ID.");
        }
        const userId = idResult.snapshot.val();
        
        // Generate invite code
        const inviteCode = await generateInviteCode();
        const parsedInviterId = parseInt(inviterId, 10);
        
        // Get Starter (Level 0) config
        const levels = await getLevelsConfig();
        const level0 = levels.find(l => l.id === 0);
        const starterAirdropPoints = level0 && level0.airdropPoints ? level0.airdropPoints : 100;
        
        // Add Starter salary fund to global pool
        if (level0 && level0.salaryFund > 0) {
            await db.ref('platformStats/totalWeeklySalaryFund').transaction(p => (p || 0) + level0.salaryFund);
        }

        // Create user object
        await userRef.set({
            profile: {
                name: username.substring(0, 30),
                userId: userId,
                joinDate: new Date().toLocaleDateString('en-GB'),
                profilePicUrl: profilePic || null
            },
            inviteCode: inviteCode,
            inviterId: parsedInviterId,
            paid: true,
            ztrBalance: 0,
            airdropPoints: starterAirdropPoints,
            level: 0, // Starter level
            teamSize: 0,
            levelStars: {},
            claimedTasks: {},
            incomeHistory: {},
            salaryHistory: {}
        });
        
        // Update mappings
        await db.ref(`userIdMap/${userId}`).set(walletLower);
        await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower);
        
        // Update inviter's team size and award referral points
        const inviterWallet = await firebaseRetry(() => db.ref(`userIdMap/${parsedInviterId}`).once('value'));
        if (inviterWallet.exists()) {
            const inviterRef = db.ref(`users/${inviterWallet.val()}`);
            await inviterRef.child('teamSize').transaction(s => (s || 0) + 1);
            await inviterRef.child('airdropPoints').transaction(p => (p || 0) + starterAirdropPoints);
        }
        
        // Distribute commissions (Assigns Matrix Stars to Level 0)
        await distributeRegistrationCommissions(parsedInviterId, userId);
        
        // Update platform stats (Add points for both user and inviter)
        await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + (starterAirdropPoints * 2));
        await db.ref('platformStats/totalParticipants').transaction(p => (p || 0) + 1);
        
        console.log(`✅ User registered: ${username} (ID: ${userId}, Wallet: ${walletLower})`);
        res.status(201).json({ success: true, message: "Registration successful.", userId: userId });
        
    } catch (error) {
        console.error("Registration Error:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred during registration." });
    }
});

/**
 * POST /api/upgrade - Upgrade user level
 */
app.post('/api/upgrade', async (req, res) => {
    const { wallet, txHash, levelId, upgradeCost, levelPrice } = req.body;
    
    if (!wallet || !txHash || !levelId || !upgradeCost || levelPrice === undefined) {
        return res.status(400).json({ success: false, error: "Missing required fields for upgrade." });
    }
    
    // Validate level ID
    const levels = await getLevelsConfig();
    const levelConfig = levels.find(l => l.id === levelId);
    if (!levelConfig) {
        return res.status(400).json({ success: false, error: "Invalid level ID." });
    }
    
    try {
        // Verify transaction
        const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, upgradeCost);
        if (!isValid) {
            return res.status(400).json({ success: false, error: "Upgrade payment verification failed." });
        }
        
        const walletLower = wallet.toLowerCase();
        const userLevelRef = db.ref(`users/${walletLower}/level`);
        const currentLevel = (await userLevelRef.once('value')).val() || 0;
        
        // Validate sequential upgrade
        if (currentLevel !== levelId - 1) {
            return res.status(400).json({ success: false, error: "Invalid level progression. Please upgrade sequentially." });
        }
        
        // Add salary fund to global pool
        if (levelConfig.salaryFund > 0) {
            await db.ref('platformStats/totalWeeklySalaryFund').transaction(p => (p || 0) + levelConfig.salaryFund);
        }
        
        // Update level
        await userLevelRef.set(levelId);
        
        // Update team size contribution
        await db.ref(`users/${walletLower}/teamSizeContribution`).set(levelConfig.price);
        
        // Distribute rewards
        await distributeAirdropPoints(walletLower, levelId);
        await distributeUpgradeCommissions(walletLower, levelId, levelPrice);
        
        console.log(`⬆️ User upgraded: ${walletLower} to level ${levelId} (${levelConfig.name})`);
        res.json({ success: true, message: "Level upgrade successful." });
        
    } catch (error) {
        console.error("Upgrade Error:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred during upgrade." });
    }
});

/**
 * POST /api/withdraw - Request withdrawal
 */
app.post('/api/withdraw', async (req, res) => {
    const { wallet } = req.body;
    
    if (!wallet) {
        return res.status(400).json({ success: false, error: "Wallet address is required." });
    }
    
    if (!/^0x[a-fA-F0-9]{40}$/i.test(wallet)) {
        return res.status(400).json({ success: false, error: "Invalid wallet address format." });
    }
    
    try {
        const userRef = db.ref(`users/${wallet.toLowerCase()}`);
        const snap = await userRef.once('value');
        const userData = snap.val();
        
        if (!userData || !userData.ztrBalance || userData.ztrBalance <= 0) {
            return res.status(400).json({ success: false, error: "You have no balance to withdraw." });
        }
        
        const withdrawalAmount = userData.ztrBalance;
        const minWithdrawal = 10;
        
        if (withdrawalAmount < minWithdrawal) {
            return res.status(400).json({ success: false, error: `Minimum withdrawal amount is ${minWithdrawal} ZTR.` });
        }
        
        // Create withdrawal request
        await db.ref('withdrawals').push({
            userWallet: wallet.toLowerCase(),
            amount: withdrawalAmount,
            status: 'pending',
            date: new Date().toISOString(),
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        
        // Reset balance
        await userRef.child('ztrBalance').set(0);
        
        console.log(`💸 Withdrawal request: ${wallet} requested ${withdrawalAmount} ZTR`);
        res.json({ success: true, message: "Withdrawal request submitted for approval." });
        
    } catch (error) {
        console.error("Withdrawal Error:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred." });
    }
});

/**
 * GET /api/platform-data - Get platform statistics
 */
app.get('/api/platform-data', async (req, res) => {
    try {
        const stats = (await db.ref('platformStats').once('value')).val() || {};
        
        // Initialize missing stats
        if (!stats.totalZTRDistributed) stats.totalZTRDistributed = 0;
        if (!stats.totalAirdropDistributed) stats.totalAirdropDistributed = 0;
        if (!stats.totalWeeklySalaryFund) stats.totalWeeklySalaryFund = 0;
        
        // Calculate total participants by counting users directly for accuracy.
        const allUsersSnapshot = await db.ref('users').once('value');
        stats.totalParticipants = allUsersSnapshot.exists() ? allUsersSnapshot.numChildren() : 0;
        
        // Calculate salary active members (level 5 or higher)
        const salaryActiveSnapshot = await db.ref('users').orderByChild('level').startAt(5).once('value');
        stats.salaryActiveMembers = salaryActiveSnapshot.exists() ? salaryActiveSnapshot.numChildren() : 0;
        
        // Get leaderboard (top 200 by ZTR balance)
        const usersSnap = await db.ref('users').orderByChild('ztrBalance').limitToLast(200).once('value');
        const leaderboard =[];
        
        if (usersSnap.exists()) {
            usersSnap.forEach(snap => {
                const user = snap.val();
                if (user && user.profile && user.ztrBalance > 0) {
                    leaderboard.push({
                        name: user.profile.name || "Anonymous",
                        userId: user.profile.userId || 0,
                        profilePicUrl: user.profile.profilePicUrl || null,
                        earnings: user.ztrBalance || 0
                    });
                }
            });
            // Sort descending by earnings
            leaderboard.sort((a, b) => b.earnings - a.earnings);
        }
        
        res.json({ success: true, stats, leaderboard });
        
    } catch (error) {
        console.error("Platform data fetch error:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred." });
    }
});

/**
 * POST /api/claim-task-reward - Claim task rewards
 */
app.post('/api/claim-task-reward', async (req, res) => {
    const { wallet, taskRequired, taskPoints } = req.body;
    
    if (!wallet || !taskRequired || !taskPoints) {
        return res.status(400).json({ success: false, error: "Missing required fields for task claim." });
    }
    
    // Validate task requirements (predefined thresholds)
    const validTasks =[3, 6, 10, 15, 25, 50];
    if (!validTasks.includes(taskRequired)) {
        return res.status(400).json({ success: false, error: "Invalid task requirement." });
    }
    
    try {
        const walletLower = wallet.toLowerCase();
        const userRef = db.ref(`users/${walletLower}`);
        const userSnap = await userRef.once('value');
        const userData = userSnap.val();
        
        if (!userData) {
            return res.status(404).json({ success: false, error: "User not found." });
        }
        
        // Verify task requirement
        if ((userData.teamSize || 0) < taskRequired) {
            return res.status(400).json({ success: false, error: "Task requirements not met." });
        }
        
        const taskKey = `task_${taskRequired}`;
        if (userData.claimedTasks && userData.claimedTasks[taskKey]) {
            return res.status(400).json({ success: false, error: "Task reward has already been claimed." });
        }
        
        // Claim reward
        await userRef.child(`claimedTasks/${taskKey}`).set(true);
        await userRef.child('airdropPoints').transaction(p => (p || 0) + taskPoints);
        await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + taskPoints);
        
        console.log(`✅ Task claimed: ${walletLower} completed task ${taskRequired} for ${taskPoints} points`);
        res.json({ success: true, message: `Successfully claimed ${taskPoints} airdrop points.` });
        
    } catch (error) {
        console.error("Task claim failed:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred." });
    }
});

/**
 * POST /api/admin/distribute-airdrop - Distribute ZTR based on Airdrop Points (Admin only)
 */
app.post('/api/admin/distribute-airdrop', async (req, res) => {
    const adminSecret = req.body.secret || req.headers['x-admin-secret'];
    const { totalZtrAmount } = req.body;
    
    if (adminSecret !== process.env.ADMIN_SECRET_KEY) {
        return res.status(403).json({ success: false, error: "Unauthorized access." });
    }
    
    if (!totalZtrAmount || isNaN(totalZtrAmount) || totalZtrAmount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid total ZTR amount." });
    }
    
    try {
        const usersSnapshot = await db.ref('users').once('value');
        if (!usersSnapshot.exists()) {
            return res.json({ success: true, message: "No users found." });
        }
        
        const users = usersSnapshot.val();
        let totalAirdropPoints = 0;
        const eligibleUsers = [];
        
        // Calculate total points across all users
        for (const [wallet, userData] of Object.entries(users)) {
            const points = userData.airdropPoints || 0;
            if (points > 0) {
                totalAirdropPoints += points;
                eligibleUsers.push({ wallet, points });
            }
        }
        
        if (totalAirdropPoints === 0) {
            return res.json({ success: true, message: "No airdrop points to distribute against." });
        }
        
        let distributedTotal = 0;
        
        // Distribute proportionally
        for (const user of eligibleUsers) {
            const share = (user.points / totalAirdropPoints) * totalZtrAmount;
            if (share > 0) {
                const userRef = db.ref(`users/${user.wallet}`);
                await userRef.child('ztrBalance').transaction(b => (b || 0) + share);
                await userRef.child('incomeHistory').push({
                    amount: share,
                    type: 'Airdrop Reward',
                    date: new Date().toISOString(),
                    timestamp: admin.database.ServerValue.TIMESTAMP
                });
                distributedTotal += share;
            }
        }
        
        await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + distributedTotal);
        
        console.log(`🎁 Airdrop reward distributed: ${distributedTotal.toFixed(4)} ZTR among ${eligibleUsers.length} users`);
        res.json({ 
            success: true, 
            message: `Distributed ${distributedTotal.toFixed(4)} ZTR among ${eligibleUsers.length} users based on their airdrop points.`,
            distributed: distributedTotal,
            recipients: eligibleUsers.length
        });
        
    } catch (error) {
        console.error("Airdrop distribution failed:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred." });
    }
});

/**
 * POST /api/admin/distribute-salary - Weekly salary distribution (Admin only)
 */
app.post('/api/admin/distribute-salary', async (req, res) => {
    const adminSecret = req.body.secret || req.headers['x-admin-secret'];
    
    if (adminSecret !== process.env.ADMIN_SECRET_KEY) {
        return res.status(403).json({ success: false, error: "Unauthorized access." });
    }
    
    try {
        const salaryPool = (await db.ref('platformStats/totalWeeklySalaryFund').once('value')).val() || 0;
        
        if (salaryPool <= 0) {
            return res.json({ success: true, message: "Salary pool is empty. No salaries distributed." });
        }
        
        // Get users with level 5 or higher
        const usersSnapshot = await db.ref('users').orderByChild('level').startAt(5).once('value');
        
        if (!usersSnapshot.exists()) {
            await db.ref('platformStats/totalWeeklySalaryFund').set(0);
            return res.json({ success: true, message: "No members are eligible for salary this week." });
        }
        
        const eligibleUsers =[];
        let totalPerformanceScore = 0;
        
        // Calculate performance scores
        for (const [wallet, userData] of Object.entries(usersSnapshot.val())) {
            let performanceScore = userData.level || 5;
            
            // Add team contribution (sum of team members' levels)
            const teamSnap = await db.ref('users').orderByChild('inviterId').equalTo(userData.profile.userId).once('value');
            if (teamSnap.exists()) {
                teamSnap.forEach(member => {
                    performanceScore += (member.val().level || 0);
                });
            }
            
            totalPerformanceScore += performanceScore;
            eligibleUsers.push({ wallet, performanceScore });
        }
        
        // Distribute salaries
        let distributedTotal = 0;
        
        if (totalPerformanceScore > 0) {
            for (const user of eligibleUsers) {
                const share = (user.performanceScore / totalPerformanceScore) * salaryPool;
                if (share > 0) {
                    const userRef = db.ref(`users/${user.wallet}`);
                    await userRef.child('ztrBalance').transaction(b => (b || 0) + share);
                    await userRef.child('salaryHistory').push({
                        amount: share,
                        date: new Date().toISOString(),
                        timestamp: admin.database.ServerValue.TIMESTAMP,
                        performanceScore: user.performanceScore
                    });
                    distributedTotal += share;
                }
            }
        }
        
        // Reset salary fund
        await db.ref('platformStats/totalWeeklySalaryFund').set(0);
        
        console.log(`💰 Weekly salary distributed: ${distributedTotal.toFixed(2)} ZTR among ${eligibleUsers.length} users`);
        res.json({ 
            success: true, 
            message: `Distributed ${distributedTotal.toFixed(2)} ZTR among ${eligibleUsers.length} users.`,
            distributed: distributedTotal,
            recipients: eligibleUsers.length
        });
        
    } catch (error) {
        console.error("Salary distribution failed:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred during salary distribution." });
    }
});

/**
 * GET /api/user/:wallet - Get user data
 */
app.get('/api/user/:wallet', async (req, res) => {
    const { wallet } = req.params;
    
    if (!wallet || !/^0x[a-fA-F0-9]{40}$/i.test(wallet)) {
        return res.status(400).json({ success: false, error: "Invalid wallet address." });
    }
    
    try {
        const userSnapshot = await db.ref(`users/${wallet.toLowerCase()}`).once('value');
        
        if (!userSnapshot.exists()) {
            return res.status(404).json({ success: false, error: "User not found." });
        }
        
        const userData = userSnapshot.val();
        const levels = await getLevelsConfig();
        const currentLevelInfo = levels.find(l => l.id === (userData.level || 0)) || null;
        
        res.json({
            success: true,
            user: {
                profile: userData.profile,
                level: userData.level || 0,
                levelInfo: currentLevelInfo,
                ztrBalance: userData.ztrBalance || 0,
                airdropPoints: userData.airdropPoints || 0,
                teamSize: userData.teamSize || 0,
                inviterId: userData.inviterId,
                inviteCode: userData.inviteCode,
                joinDate: userData.profile?.joinDate,
                incomeHistory: userData.incomeHistory || {},
                salaryHistory: userData.salaryHistory || {}
            }
        });
        
    } catch (error) {
        console.error("User fetch error:", error);
        res.status(500).json({ success: false, error: "Internal server error." });
    }
});

/**
 * GET /api/team/:userId - Get team members
 */
app.get('/api/team/:userId', async (req, res) => {
    const { userId } = req.params;
    const parsedUserId = parseInt(userId);
    
    if (isNaN(parsedUserId)) {
        return res.status(400).json({ success: false, error: "Invalid user ID." });
    }
    
    try {
        const teamMembers =
