const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();

// --- Enhanced CORS Configuration ---
// Allows requests from any origin, which is suitable for a decentralized application.
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());
app.use(express.json());

// --- Firebase Admin Setup ---
let db;
try {
    // Securely initialize Firebase Admin SDK from environment variables.
    const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!serviceAccountBase64) {
        throw new Error("FATAL ERROR: FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable is not set.");
    }
    
    const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('ascii'));
    
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DB_URL
    });
    
    db = admin.database();
    console.log("✅ Firebase Admin initialized successfully. Backend is in control.");
} catch (error) {
    console.error("🔥 Firebase Admin Initialization Failed:", error.message);
    process.exit(1); // Exit if the database connection fails.
}

// --- Blockchain & Contract Configuration ---
// All critical addresses are managed on the backend.
const ADMIN_WALLET = "0x97efeaa1da1108acff52840550ec51dc5bbfd812";
const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";
const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/");

const usdtAbi = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address owner) view returns (uint256)"
];

const usdtContract = new ethers.Contract(USDT_CONTRACT, usdtAbi, provider);

// --- Cache for frequently accessed data ---
let levelsCache = null;
let levelsCacheTime = 0;
const CACHE_TTL = 60000; // 1 minute cache to reduce database reads.

// --- Helper Functions with Retry Logic ---
// Ensures database operations are resilient to temporary network issues.
async function firebaseRetry(operation, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await operation();
        } catch (error) {
            if (i === retries - 1) throw error;
            console.log(`Firebase operation failed. Retry ${i + 1}/${retries}...`, error.message);
            await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
        }
    }
}

/**
 * Fetches Level Configuration from the database.
 * Includes a fallback configuration for system stability.
 */
async function getLevelsConfig() {
    const now = Date.now();
    if (levelsCache && (now - levelsCacheTime) < CACHE_TTL) {
        return levelsCache;
    }
    
    const snapshot = await firebaseRetry(() => db.ref('config/levels').once('value'));
    let levels = snapshot.val();
    
    // Fallback configuration ensures the system runs even if DB config is missing.
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
        console.warn("⚠️ Using fallback level configuration. Please configure levels in Firebase.");
    }
    
    levelsCache = levels;
    levelsCacheTime = now;
    return levels;
}

/**
 * Gets Registration Fee from level configuration.
 */
async function getRegistrationFee() {
    const levels = await getLevelsConfig();
    const starterLevel = levels.find(l => l.id === 0);
    const price = starterLevel ? starterLevel.price : 5;
    const salaryFund = starterLevel ? starterLevel.salaryFund : 0.25;
    const fee = starterLevel ? starterLevel.fee : 0;
    return price + salaryFund + fee;
}

/**
 * Gets ZTR price from the database.
 */
async function getZTRPrice() {
    const snapshot = await firebaseRetry(() => db.ref('config/baseZTRPrice').once('value'));
    return snapshot.exists() && typeof snapshot.val() === 'number' ? snapshot.val() : 1.0;
}

/**
 * Verifies a USDT transaction on the blockchain.
 * This is a critical security function, ensuring payments are legitimate before updating the database.
 */
async function verifyTransaction(txHash, fromWallet, toWallet, expectedAmount, tolerancePercent = 0.5) {
    try {
        if (!txHash || !ethers.isHexString(txHash, 32)) return false;
        
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) return false; // Ensure transaction was successful
        
        const decimals = await usdtContract.decimals();
        const expectedAmountWei = ethers.parseUnits(parseFloat(expectedAmount).toFixed(Number(decimals)), decimals);
        const tolerance = (expectedAmountWei * BigInt(Math.floor(tolerancePercent * 100))) / BigInt(10000);
        const minRequired = expectedAmountWei - tolerance;
        
        // Parse logs to find the exact Transfer event we are looking for.
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === USDT_CONTRACT.toLowerCase()) {
                try {
                    const parsedLog = usdtContract.interface.parseLog(log);
                    if (parsedLog && parsedLog.name === "Transfer") {
                        const { from, to, value } = parsedLog.args;
                        if (from.toLowerCase() === fromWallet.toLowerCase() && 
                            to.toLowerCase() === toWallet.toLowerCase() && 
                            value >= minRequired) {
                            return true; // Transaction is valid.
                        }
                    }
                } catch (e) {
                    // Ignore parsing errors for other logs.
                }
            }
        }
        return false; // No matching Transfer event found.
    } catch (error) {
        console.error("Error in verifyTransaction:", error.message);
        return false;
    }
}

/**
 * Generates a unique 8-character invitation code.
 */
async function generateInviteCode() {
    let code, isUnique = false;
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    // Retry up to 100 times to find a unique code.
    for (let attempt = 0; attempt < 100 && !isUnique; attempt++) {
        code = '';
        for (let i = 0; i < 8; i++) code += characters.charAt(Math.floor(Math.random() * characters.length));
        const snapshot = await firebaseRetry(() => db.ref(`inviteCodeMap/${code}`).once('value'));
        if (!snapshot.exists()) isUnique = true;
    }
    // If a unique code is not found, append a timestamp slice to guarantee uniqueness.
    return isUnique ? code : code + Date.now().toString(36).slice(-2);
}

/**
 * Adds a star to a user's level. This is triggered by commissions.
 */
async function addStarToLevel(recipientWallet, levelId, starType, sourceUserId) {
    if (!recipientWallet || !sourceUserId || levelId === undefined) return;
    try {
        const starRef = db.ref(`users/${recipientWallet.toLowerCase()}/levelStars/level_${levelId}`);
        await starRef.push({
            type: starType,
            sourceUserId: sourceUserId,
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
    } catch (error) {
        console.error(`Star Error for wallet ${recipientWallet}:`, error);
    }
}

/**
 * Securely adds commission to a user's balance and records the income.
 */
async function addCommission(userId, amount, type, starType, levelId, sourceUserId, starLevelId) {
    if (!userId || amount <= 0) return false;
    try {
        const walletSnapshot = await firebaseRetry(() => db.ref(`userIdMap/${userId}`).once('value'));
        if (!walletSnapshot.exists()) {
            console.error(`Commission Error: User ID ${userId} not found in userIdMap.`);
            return false;
        }
        
        const wallet = walletSnapshot.val();
        const userRef = db.ref(`users/${wallet}`);
        
        // Use a transaction to safely update the balance.
        await userRef.child('ztrBalance').transaction(balance => (balance || 0) + amount);
        
        // Record the income for the user's history.
        await userRef.child('incomeHistory').push({
            amount: amount, 
            type: type, 
            date: new Date().toISOString(), 
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        
        // Update total platform stats.
        await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + amount);
        
        // Add a star if applicable.
        if (starType && levelId !== undefined && sourceUserId) {
            await addStarToLevel(wallet, starLevelId !== undefined ? starLevelId : levelId, starType, sourceUserId);
        }
        return true;
    } catch (error) {
        console.error(`Commission Error for user ${userId}:`, error.message);
        return false;
    }
}

/**
 * Distributes airdrop points and ZTR bonus to the user and their inviter.
 */
async function distributeAirdropPoints(userWallet, levelId) {
    const levels = await getLevelsConfig();
    const levelConfig = levels.find(l => l.id === levelId);
    if (!levelConfig || !(levelConfig.airdropPoints > 0)) return;

    const points = levelConfig.airdropPoints;
    const ztrBonus = points * 0.001; // 10 ZTR per 10,000 points
    
    const award = async (wallet) => {
        const ref = db.ref(`users/${wallet}`);
        await ref.child('airdropPoints').transaction(p => (p || 0) + points);
        if (ztrBonus > 0) {
            await ref.child('ztrBalance').transaction(b => (b || 0) + ztrBonus);
            await ref.child('incomeHistory').push({
                amount: ztrBonus, type: 'Airdrop ZTR Bonus', date: new Date().toISOString(), timestamp: admin.database.ServerValue.TIMESTAMP
            });
            await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + ztrBonus);
        }
        await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + points);
    };

    // Award the user
    await award(userWallet);
    
    // Award the user's inviter
    const userData = (await db.ref(`users/${userWallet}`).once('value')).val();
    if (userData && userData.inviterId) {
        const inviterWalletSnap = await db.ref(`userIdMap/${userData.inviterId}`).once('value');
        if (inviterWalletSnap.exists()) {
            await award(inviterWalletSnap.val());
        }
    }
}

/**
 * Distributes all commissions for a new user registration.
 * Logic is fully controlled by the backend.
 */
async function distributeRegistrationCommissions(inviterId, newUserId) {
    const levels = await getLevelsConfig();
    const starterPlan = levels.find(l => l.id === 0);
    if (!starterPlan) return;

    const commissionableAmount = starterPlan.price;
    const inviterWalletSnap = await db.ref(`userIdMap/${inviterId}`).once('value');
    if (!inviterWalletSnap.exists()) return;
    const inviterWallet = inviterWalletSnap.val();

    // 1. Direct Commission (55%) to inviter.
    await addCommission(inviterId, commissionableAmount * 0.55, 'Starter Direct Commission', 'direct', 0, newUserId, 0);
    
    // 2. Upline Commission (7%) to inviter's inviter.
    const inviterData = (await db.ref(`users/${inviterWallet}`).once('value')).val();
    if (inviterData && inviterData.inviterId) {
        await addCommission(inviterData.inviterId, commissionableAmount * 0.07, 'Starter Upline Commission', 'upline', 0, newUserId, 0);
    }
    
    // 3. Team Commission (20%) split among the inviter's other direct referrals.
    const teamMembersSnapshot = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
    if (teamMembersSnapshot.exists()) {
        const team = [];
        teamMembersSnapshot.forEach(snap => {
            // Exclude the new user from receiving a commission on their own registration.
            if (snap.val().profile && snap.val().profile.userId !== newUserId) {
                team.push({ userId: snap.val().profile.userId });
            }
        });
        if (team.length > 0) {
            const share = (commissionableAmount * 0.20) / team.length;
            for (const member of team) {
                await addCommission(member.userId, share, 'Starter Team Commission', 'downline', 0, newUserId, 0);
            }
        }
    }
}

/**
 * Distributes all commissions for a level upgrade.
 */
async function distributeUpgradeCommissions(upgraderWallet, levelId, price) {
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
        const inviter = (await db.ref(`users/${inviterWalletSnap.val()}`).once('value')).val();
        if (inviter && inviter.inviterId) {
            await addCommission(inviter.inviterId, price * 0.07, `Level ${levelId} Upline Commission`, 'upline', levelId, userId, levelId);
        }
    }

    // 3. Team Commission (20%)
    const teamSnap = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
    if (teamSnap.exists()) {
        const team = [];
        teamSnap.forEach(s => { 
            // Exclude the upgrader from the team share.
            if (s.key !== upgraderWallet) team.push(s.val().profile.userId); 
        });
        if (team.length > 0) {
            const share = (price * 0.20) / team.length;
            for (const id of team) {
                await addCommission(id, share, `Level ${levelId} Team Commission`, 'downline', levelId, userId, levelId);
            }
        }
    }
}


// ===============================================
// ================= API ENDPOINTS =================
// ===============================================

// Provides public configuration to the frontend.
app.get('/api/config', async (req, res) => {
    try {
        const levels = await getLevelsConfig();
        const registrationFee = await getRegistrationFee();
        const ztrPrice = await getZTRPrice();
        res.json({ 
            success: true, 
            config: { levels, registrationFee, ztrPrice, adminWallet: ADMIN_WALLET, usdtContract: USDT_CONTRACT } 
        });
    } catch (error) {
        console.error("API Error in /api/config:", error.message);
        res.status(500).json({ success: false, error: "Configuration could not be loaded." });
    }
});

/**
 * NEW: Securely verifies an invitation code.
 * This replaces the insecure frontend Firebase check.
 */
app.post('/api/verify-invite', async (req, res) => {
    const { inviteCode } = req.body;
    if (!inviteCode || typeof inviteCode !== 'string' || inviteCode.length > 10) {
        return res.status(400).json({ success: false, error: "Invalid invite code format." });
    }

    try {
        const codeMapSnap = await db.ref(`inviteCodeMap/${inviteCode.toUpperCase()}`).once('value');
        if (!codeMapSnap.exists()) {
            return res.status(404).json({ success: false, error: "Invite code not found." });
        }
        
        const inviterWallet = codeMapSnap.val();
        const userProfileSnap = await db.ref(`users/${inviterWallet}/profile`).once('value');
        if (!userProfileSnap.exists()) {
             return res.status(404).json({ success: false, error: "Inviter profile not found." });
        }

        res.json({ success: true, inviter: userProfileSnap.val() });

    } catch (error) {
        console.error("API Error in /api/verify-invite:", error.message);
        res.status(500).json({ success: false, error: "Server error during code verification." });
    }
});

// Handles new user registration.
app.post('/api/register', async (req, res) => {
    const { wallet, txHash, inviterId, username, profilePic, registrationCost } = req.body;
    
    // 1. Validate Input
    if (!wallet || !txHash || !inviterId || !username || !registrationCost) {
        return res.status(400).json({ success: false, error: "Missing required fields." });
    }
    if (!ethers.isAddress(wallet)) {
        return res.status(400).json({ success: false, error: "Invalid wallet address." });
    }

    try {
        // 2. Verify Payment
        const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, registrationCost);
        if (!isValid) {
            return res.status(400).json({ success: false, error: "Payment verification failed. The transaction may be invalid or for the wrong amount." });
        }

        // 3. Check for Existing User
        const walletLower = wallet.toLowerCase();
        const userRef = db.ref(`users/${walletLower}`);
        if ((await userRef.once('value')).exists()) {
            return res.status(400).json({ success: false, error: "This wallet is already registered." });
        }

        // 4. Create New User
        const idRes = await db.ref('nextUserId').transaction(id => (id || 1000) + 1);
        const userId = idRes.snapshot.val();
        const inviteCode = await generateInviteCode();

        const levels = await getLevelsConfig();
        const starter = levels.find(l => l.id === 0);
        if (starter && starter.salaryFund > 0) {
            await db.ref('platformStats/totalWeeklySalaryFund').transaction(p => (p || 0) + starter.salaryFund);
        }

        await userRef.set({
            profile: { name: username.substring(0, 30), userId, joinDate: new Date().toLocaleDateString('en-GB'), profilePicUrl: profilePic || null },
            inviteCode, inviterId: parseInt(inviterId), paid: true, ztrBalance: 0, airdropPoints: 0, level: 0, teamSize: 0,
            levelStars: {}, claimedTasks: {}, incomeHistory: {}, salaryHistory: {}
        });

        // 5. Update System Mappings and Stats
        await db.ref(`userIdMap/${userId}`).set(walletLower);
        await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower);

        const inviterWallet = await db.ref(`userIdMap/${inviterId}`).once('value');
        if (inviterWallet.exists()) {
            await db.ref(`users/${inviterWallet.val()}/teamSize`).transaction(s => (s || 0) + 1);
        }

        // 6. Distribute Commissions and Airdrops
        await distributeRegistrationCommissions(parseInt(inviterId), userId);
        await distributeAirdropPoints(walletLower, 0); // Award starter points
        await db.ref('platformStats/totalParticipants').transaction(p => (p || 0) + 1);

        res.status(201).json({ success: true, userId });
    } catch (error) {
        console.error("API Error in /api/register:", error.message);
        res.status(500).json({ success: false, error: "An internal server error occurred during registration." });
    }
});

// Handles user level upgrades.
app.post('/api/upgrade', async (req, res) => {
    const { wallet, txHash, levelId, upgradeCost, levelPrice } = req.body;

    if (!wallet || !txHash || levelId === undefined || !upgradeCost || !levelPrice) {
        return res.status(400).json({ success: false, error: "Missing required fields for upgrade." });
    }
    if (!ethers.isAddress(wallet)) {
        return res.status(400).json({ success: false, error: "Invalid wallet address." });
    }

    try {
        const levels = await getLevelsConfig();
        const levelConfig = levels.find(l => l.id === levelId);
        if (!levelConfig) {
            return res.status(400).json({ success: false, error: "Invalid level specified." });
        }

        const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, upgradeCost);
        if (!isValid) {
            return res.status(400).json({ success: false, error: "Upgrade payment verification failed." });
        }

        const walletLower = wallet.toLowerCase();
        const userRef = db.ref(`users/${walletLower}`);
        const currentLevel = (await userRef.child('level').once('value')).val() || 0;

        if (currentLevel !== levelId - 1) {
            return res.status(400).json({ success: false, error: "Upgrades must be done sequentially." });
        }

        if (levelConfig.salaryFund > 0) {
            await db.ref('platformStats/totalWeeklySalaryFund').transaction(p => (p || 0) + levelConfig.salaryFund);
        }

        await userRef.child('level').set(levelId);
        await distributeAirdropPoints(walletLower, levelId);
        await distributeUpgradeCommissions(walletLower, levelId, levelPrice);

        res.json({ success: true, message: `Successfully upgraded to Level ${levelId}!` });
    } catch (error) {
        console.error("API Error in /api/upgrade:", error.message);
        res.status(500).json({ success: false, error: "An internal server error occurred during upgrade." });
    }
});

// Handles withdrawal requests.
app.post('/api/withdraw', async (req, res) => {
    const { wallet } = req.body;
    if (!wallet || !ethers.isAddress(wallet)) {
        return res.status(400).json({ success: false, error: "Invalid wallet address provided." });
    }

    try {
        const userRef = db.ref(`users/${wallet.toLowerCase()}`);
        const userData = (await userRef.once('value')).val();
        
        if (!userData || (userData.ztrBalance || 0) < 10) {
            return res.status(400).json({ success: false, error: "Insufficient balance. Minimum withdrawal is 10 ZTR." });
        }

        // Create a pending withdrawal request for admin/bot processing.
        await db.ref('withdrawals').push({
            userWallet: wallet.toLowerCase(),
            amount: userData.ztrBalance,
            status: 'pending',
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        
        // Reset user's balance after request is logged.
        await userRef.child('ztrBalance').set(0);
        
        res.json({ success: true, message: "Withdrawal request submitted successfully." });
    } catch (error) {
        console.error("API Error in /api/withdraw:", error.message);
        res.status(500).json({ success: false, error: "Server error processing withdrawal." });
    }
});

// Fetches platform-wide statistics.
app.get('/api/platform-data', async (req, res) => {
    try {
        const statsSnap = await db.ref('platformStats').once('value');
        const stats = statsSnap.val() || {};
        
        const salaryActiveSnap = await db.ref('users').orderByChild('level').startAt(5).once('value');
        stats.salaryActiveMembers = salaryActiveSnap.numChildren();
        
        // Fetch top 100 users by ZTR balance for the leaderboard.
        const leaderboard = [];
        const topUsersSnap = await db.ref('users').orderByChild('ztrBalance').limitToLast(100).once('value');
        topUsersSnap.forEach(u => {
            const val = u.val();
            if (val.profile) {
                leaderboard.push({ 
                    name: val.profile.name, 
                    userId: val.profile.userId, 
                    profilePicUrl: val.profile.profilePicUrl || null, 
                    earnings: val.ztrBalance || 0 
                });
            }
        });

        res.json({ success: true, stats, leaderboard: leaderboard.reverse() });
    } catch (error) {
        console.error("API Error in /api/platform-data:", error.message);
        res.status(500).json({ success: false, error: "Failed to load platform data." });
    }
});

// Handles claiming of task rewards.
app.post('/api/claim-task-reward', async (req, res) => {
    const { wallet, taskRequired, taskPoints } = req.body;

    if (!wallet || !ethers.isAddress(wallet) || !taskRequired || !taskPoints) {
        return res.status(400).json({ success: false, error: "Missing fields for task claim." });
    }

    try {
        const userRef = db.ref(`users/${wallet.toLowerCase()}`);
        const user = (await userRef.once('value')).val();

        if (!user) return res.status(404).json({ success: false, error: "User not found." });
        if ((user.teamSize || 0) < taskRequired) {
            return res.status(400).json({ success: false, error: "You are not eligible for this reward yet." });
        }

        const taskKey = `task_${taskRequired}`;
        if (user.claimedTasks && user.claimedTasks[taskKey]) {
            return res.status(400).json({ success: false, error: "This task reward has already been claimed." });
        }

        const ztrBonus = taskPoints * 0.001; // Ratio: 10 ZTR / 10k points
        await userRef.child(`claimedTasks/${taskKey}`).set(true);
        await userRef.child('airdropPoints').transaction(p => (p || 0) + taskPoints);
        await userRef.child('ztrBalance').transaction(b => (b || 0) + ztrBonus);
        
        await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + taskPoints);
        await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + ztrBonus);

        res.json({ success: true, message: `Claimed ${taskPoints} points and ${ztrBonus} ZTR!` });
    } catch (error) {
        console.error("API Error in /api/claim-task-reward:", error.message);
        res.status(500).json({ success: false, error: "Server error claiming task reward." });
    }
});

// Fetches detailed data for a single user.
app.get('/api/user/:wallet', async (req, res) => {
    const wallet = req.params.wallet;
    if (!wallet || !ethers.isAddress(wallet)) {
        return res.status(400).json({ success: false, error: "Invalid wallet address." });
    }

    try {
        const snap = await db.ref(`users/${wallet.toLowerCase()}`).once('value');
        if (!snap.exists()) {
            return res.status(404).json({ success: false, error: "User not found." });
        }
        
        const user = snap.val();
        const levels = await getLevelsConfig();
        const levelInfo = levels.find(l => l.id === (user.level || 0));

        res.json({ success: true, user: { ...user, levelInfo } });
    } catch (error) {
        console.error("API Error in /api/user/:wallet:", error.message);
        res.status(500).json({ success: false, error: "Could not fetch user data." });
    }
});

// Fetches the direct team of a user.
app.get('/api/team/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId, 10);
    if (isNaN(userId)) {
        return res.status(400).json({ success: false, error: "Invalid User ID." });
    }

    try {
        const team = [];
        const snap = await db.ref('users').orderByChild('inviterId').equalTo(userId).once('value');
        snap.forEach(s => {
            const userData = s.val();
            team.push({ 
                wallet: s.key, 
                profile: userData.profile, 
                level: userData.level || 0 
            });
        });
        res.json({ success: true, team });
    } catch (error) {
        console.error("API Error in /api/team/:userId:", error.message);
        res.status(500).json({ success: false, error: "Could not fetch team data." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}. Awaiting frontend connections.`));
