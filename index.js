const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();

// --- Enhanced CORS Configuration ---
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

const usdtAbi = [
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

/**
 * Fetches Level Config including Level 0 (Starter)
 */
async function getLevelsConfig() {
    const now = Date.now();
    if (levelsCache && (now - levelsCacheTime) < CACHE_TTL) {
        return levelsCache;
    }
    
    const snapshot = await firebaseRetry(() => db.ref('config/levels').once('value'));
    let levels = snapshot.val();
    
    if (!levels || !Array.isArray(levels) || levels.length === 0) {
        // Fallback configuration including Starter (Level 0)
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
        console.warn("⚠️ Using fallback level configuration");
    }
    
    levelsCache = levels;
    levelsCacheTime = now;
    return levels;
}

/**
 * Gets Registration Fee based on Starter (Level 0) config
 */
async function getRegistrationFee() {
    const levels = await getLevelsConfig();
    const starterLevel = levels.find(l => l.id === 0);
    const price = starterLevel ? starterLevel.price : 5;
    const salaryFund = starterLevel ? starterLevel.salaryFund : 0.25;
    const fee = starterLevel ? starterLevel.fee : 0;
    return price + salaryFund + fee;
}

async function getZTRPrice() {
    const snapshot = await firebaseRetry(() => db.ref('config/baseZTRPrice').once('value'));
    return snapshot.exists() && typeof snapshot.val() === 'number' ? snapshot.val() : 1.0;
}

async function verifyTransaction(txHash, fromWallet, toWallet, expectedAmount, tolerancePercent = 0.5) {
    try {
        if (!txHash || !ethers.isHexString(txHash, 32)) return false;
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) return false;
        
        const decimals = await usdtContract.decimals();
        const expectedAmountWei = ethers.parseUnits(parseFloat(expectedAmount).toFixed(Number(decimals)), decimals);
        const tolerance = (expectedAmountWei * BigInt(Math.floor(tolerancePercent * 100))) / BigInt(10000);
        const minRequired = expectedAmountWei - tolerance;
        
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === USDT_CONTRACT.toLowerCase()) {
                try {
                    const parsedLog = usdtContract.interface.parseLog(log);
                    if (parsedLog && parsedLog.name === "Transfer") {
                        const { from, to, value } = parsedLog.args;
                        if (from.toLowerCase() === fromWallet.toLowerCase() && to.toLowerCase() === toWallet.toLowerCase() && value >= minRequired) {
                            return true;
                        }
                    }
                } catch (e) {}
            }
        }
        return false;
    } catch (error) {
        return false;
    }
}

async function generateInviteCode() {
    let code, isUnique = false;
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let attempt = 0; attempt < 100 && !isUnique; attempt++) {
        code = '';
        for (let i = 0; i < 8; i++) code += characters.charAt(Math.floor(Math.random() * characters.length));
        const snapshot = await firebaseRetry(() => db.ref(`inviteCodeMap/${code}`).once('value'));
        if (!snapshot.exists()) isUnique = true;
    }
    return isUnique ? code : code + Date.now().toString(36).slice(-2);
}

async function addStarToLevel(recipientWallet, levelId, starType, sourceUserId) {
    if (!recipientWallet || !sourceUserId) return;
    try {
        const starRef = db.ref(`users/${recipientWallet.toLowerCase()}/levelStars/level_${levelId}`);
        await starRef.push({
            type: starType,
            sourceUserId: sourceUserId,
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
    } catch (error) {
        console.error(`Star Error:`, error);
    }
}

async function addCommission(userId, amount, type, starType, levelId, sourceUserId, starLevelId) {
    if (!userId || amount <= 0) return false;
    try {
        const walletSnapshot = await firebaseRetry(() => db.ref(`userIdMap/${userId}`).once('value'));
        if (!walletSnapshot.exists()) return false;
        const wallet = walletSnapshot.val();
        const userRef = db.ref(`users/${wallet}`);

        const newIncome = {
            amount: amount, type: type, date: new Date().toISOString(), timestamp: admin.database.ServerValue.TIMESTAMP
        };
        
        // Use a transaction to update multiple fields safely
        await userRef.transaction(currentUserData => {
            if (currentUserData === null) {
                return null; // User does not exist, abort transaction
            }
            currentUserData.ztrBalance = (currentUserData.ztrBalance || 0) + amount;
            if (!currentUserData.incomeHistory) {
                currentUserData.incomeHistory = {};
            }
            // Firebase doesn't support push in transactions, so we generate a key
            const incomeKey = db.ref().child('incomeHistory').push().key;
            currentUserData.incomeHistory[incomeKey] = newIncome;

            return currentUserData;
        });

        await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + amount);

        // This can be outside the transaction as it's less critical
        if (starType && levelId && sourceUserId) {
            await addStarToLevel(wallet, starLevelId || levelId, starType, sourceUserId);
        }
        return true;
    } catch (error) {
        console.error(`Error in addCommission for userId ${userId}:`, error);
        return false;
    }
}

/**
 * Enhanced Airdrop Logic: Distributes proportional ZTR (10 ZTR per 10,000 Points)
 */
async function distributeAirdropPoints(userWallet, levelId) {
    const levels = await getLevelsConfig();
    const levelConfig = levels.find(l => l.id === levelId);
    if (!levelConfig || !(levelConfig.airdropPoints > 0)) return;

    const points = levelConfig.airdropPoints;
    const ztrBonus = points * 0.001; // 10 ZTR per 10,000 points ratio
    
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

    await award(userWallet);
    const userData = (await db.ref(`users/${userWallet}`).once('value')).val();
    if (userData && userData.inviterId) {
        const inviterWallet = (await db.ref(`userIdMap/${userData.inviterId}`).once('value')).val();
        if (inviterWallet) await award(inviterWallet);
    }
}

/**
 * Modified Registration: Fills Star for Level 0 (Starter)
 */
async function distributeRegistrationCommissions(inviterId, newUserId) {
    const levels = await getLevelsConfig();
    const starterPlan = levels.find(l => l.id === 0); // Starter
    if (!starterPlan) return;

    const commissionableAmount = starterPlan.price;
    const inviterWalletSnap = await db.ref(`userIdMap/${inviterId}`).once('value');
    const inviterWallet = inviterWalletSnap.val();

    // 1. Direct Commission + STAR for Level 0
    await addCommission(inviterId, commissionableAmount * 0.55, 'Starter Direct Commission', 'direct', 0, newUserId, 0);
    
    // 2. Upline Commission
    if (inviterWallet) {
        const inviterData = (await db.ref(`users/${inviterWallet}`).once('value')).val();
        if (inviterData && inviterData.inviterId) {
            await addCommission(inviterData.inviterId, commissionableAmount * 0.07, 'Starter Upline Commission', 'upline', 0, newUserId, 0);
        }
    }
    
    // 3. Team Commission
    const teamMembersSnapshot = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
    if (teamMembersSnapshot.exists()) {
        const team = [];
        teamMembersSnapshot.forEach(snap => {
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

// ==================== API ENDPOINTS ====================

app.get('/api/config', async (req, res) => {
    try {
        const levels = await getLevelsConfig();
        const registrationFee = await getRegistrationFee();
        const ztrPrice = await getZTRPrice();
        res.json({ success: true, config: { levels, registrationFee, ztrPrice, adminWallet: ADMIN_WALLET, usdtContract: USDT_CONTRACT } });
    } catch (error) {
        res.status(500).json({ success: false, error: "Config error" });
    }
});

app.post('/api/register', async (req, res) => {
    const { wallet, txHash, inviterId, username, profilePic, registrationCost } = req.body;
    if (!wallet || !txHash || !inviterId || !username) return res.status(400).json({ success: false, error: "Missing fields" });

    try {
        const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, registrationCost);
        if (!isValid) return res.status(400).json({ success: false, error: "Verification failed" });

        const walletLower = wallet.toLowerCase();
        const userRef = db.ref(`users/${walletLower}`);
        if ((await userRef.once('value')).exists()) return res.status(400).json({ success: false, error: "Already registered" });

        const idRes = await db.ref('nextUserId').transaction(id => (id || 1000) + 1);
        const userId = idRes.snapshot.val();
        const inviteCode = await generateInviteCode();

        const levels = await getLevelsConfig();
        const starter = levels.find(l => l.id === 0);
        if (starter && starter.salaryFund > 0) {
            await db.ref('platformStats/totalWeeklySalaryFund').transaction(p => (p || 0) + starter.salaryFund);
        }

        const initialZTRBonus = (starter.airdropPoints || 100) * 0.001;

        await userRef.set({
            profile: { name: username.substring(0, 30), userId, joinDate: new Date().toLocaleDateString('en-GB'), profilePicUrl: profilePic || null },
            inviteCode, inviterId: parseInt(inviterId), paid: true, ztrBalance: initialZTRBonus, airdropPoints: 0, level: 0, teamSize: 0,
            levelStars: {}, claimedTasks: {}, incomeHistory: {}, salaryHistory: {}
        });

        await db.ref(`userIdMap/${userId}`).set(walletLower);
        await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower);

        const inviterWallet = (await db.ref(`userIdMap/${inviterId}`).once('value')).val();
        if (inviterWallet) {
            await db.ref(`users/${inviterWallet}/teamSize`).transaction(s => (s || 0) + 1);
        }

        await distributeRegistrationCommissions(parseInt(inviterId), userId);
        await distributeAirdropPoints(walletLower, 0); // Award starter points
        await db.ref('platformStats/totalParticipants').transaction(p => (p || 0) + 1);

        res.status(201).json({ success: true, userId });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/upgrade', async (req, res) => {
    const { wallet, txHash, levelId, upgradeCost, levelPrice } = req.body;
    try {
        const levels = await getLevelsConfig();
        const levelConfig = levels.find(l => l.id === levelId);
        if (!levelConfig) return res.status(400).json({ success: false, error: "Invalid level" });

        const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, upgradeCost);
        if (!isValid) return res.status(400).json({ success: false, error: "Payment failed" });

        const walletLower = wallet.toLowerCase();
        const userRef = db.ref(`users/${walletLower}`);
        const currentLevel = (await userRef.child('level').once('value')).val() || 0;

        if (currentLevel !== levelId - 1) return res.status(400).json({ success: false, error: "Sequential upgrade required" });

        if (levelConfig.salaryFund > 0) {
            await db.ref('platformStats/totalWeeklySalaryFund').transaction(p => (p || 0) + levelConfig.salaryFund);
        }

        await userRef.child('level').set(levelId);
        await distributeAirdropPoints(walletLower, levelId);
        await distributeUpgradeCommissions(walletLower, levelId, levelPrice);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

async function distributeUpgradeCommissions(wallet, levelId, price) {
    const userSnap = await db.ref(`users/${wallet}`).once('value');
    const user = userSnap.val();
    if (!user || !user.inviterId) return;

    const inviterId = user.inviterId;
    const userId = user.profile.userId;

    await addCommission(inviterId, price * 0.55, `Level ${levelId} Direct Commission`, 'direct', levelId, userId, levelId);
    
    const inviterWalletSnap = await db.ref(`userIdMap/${inviterId}`).once('value');
    if (inviterWalletSnap.exists()) {
        const inviter = (await db.ref(`users/${inviterWalletSnap.val()}`).once('value')).val();
        if (inviter && inviter.inviterId) {
            await addCommission(inviter.inviterId, price * 0.07, `Level ${levelId} Upline Commission`, 'upline', levelId, userId, levelId);
        }
    }

    const teamSnap = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
    if (teamSnap.exists()) {
        const team = [];
        teamSnap.forEach(s => { if (s.key !== wallet) team.push(s.val().profile.userId); });
        if (team.length > 0) {
            const share = (price * 0.20) / team.length;
            for (const id of team) await addCommission(id, share, `Level ${levelId} Team Commission`, 'downline', levelId, userId, levelId);
        }
    }
}

app.post('/api/withdraw', async (req, res) => {
    const { wallet } = req.body;
    try {
        const userRef = db.ref(`users/${wallet.toLowerCase()}`);
        const userData = (await userRef.once('value')).val();
        if (!userData || (userData.ztrBalance || 0) < 10) return res.status(400).json({ success: false, error: "Insufficient balance" });

        // Using a transaction to ensure balance is set to 0 and request is created atomically
        const amountToWithdraw = userData.ztrBalance;
        const result = await userRef.child('ztrBalance').transaction(currentBalance => {
            if (currentBalance >= 10) {
                return 0; // Set balance to 0
            }
            return; // Abort transaction
        });

        if (!result.committed) {
           return res.status(400).json({ success: false, error: "Failed to update balance. Please try again." });
        }

        await db.ref('withdrawals').push({
            userWallet: wallet.toLowerCase(), amount: amountToWithdraw, status: 'pending', timestamp: admin.database.ServerValue.TIMESTAMP
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/platform-data', async (req, res) => {
    try {
        const statsSnap = await db.ref('platformStats').once('value');
        const stats = statsSnap.val() || {};
        
        const allUsersSnap = await db.ref('users').once('value');
        stats.totalParticipants = allUsersSnap.numChildren();
        
        const salaryActiveSnap = await db.ref('users').orderByChild('level').startAt(5).once('value');
        stats.salaryActiveMembers = salaryActiveSnap.numChildren();

        const leaderboard = [];
        // Querying by a child value is more efficient
        const topUsersSnap = await db.ref('users').orderByChild('ztrBalance').limitToLast(100).once('value');
        topUsersSnap.forEach(u => {
            const val = u.val();
            if (val.profile) {
                leaderboard.push({ name: val.profile.name, userId: val.profile.userId, profilePicUrl: val.profile.profilePicUrl, earnings: val.ztrBalance || 0 });
            }
        });

        res.json({ success: true, stats, leaderboard: leaderboard.reverse() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/claim-task-reward', async (req, res) => {
    const { wallet, taskRequired, taskPoints } = req.body;
    try {
        const userRef = db.ref(`users/${wallet.toLowerCase()}`);
        const user = (await userRef.once('value')).val();
        if (!user || (user.teamSize || 0) < taskRequired) return res.status(400).json({ success: false, error: "Not eligible" });

        const taskKey = `task_${taskRequired}`;
        if (user.claimedTasks && user.claimedTasks[taskKey]) return res.status(400).json({ success: false, error: "Already claimed" });

        const ztrBonus = taskPoints * 0.001;
        await userRef.child(`claimedTasks/${taskKey}`).set(true);
        await userRef.child('airdropPoints').transaction(p => (p || 0) + taskPoints);
        await userRef.child('ztrBalance').transaction(b => (b || 0) + ztrBonus);
        await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + taskPoints);
        await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + ztrBonus);

        res.json({ success: true, message: `Claimed ${taskPoints} points and ${ztrBonus} ZTR!` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/user/:wallet', async (req, res) => {
    try {
        const snap = await db.ref(`users/${req.params.wallet.toLowerCase()}`).once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, error: "User not found" });
        const user = snap.val();
        const levels = await getLevelsConfig();
        res.json({ success: true, user: { ...user, levelInfo: levels.find(l => l.id === (user.level || 0)) } });
    } catch (error) {
        res.status(500).json({ success: false, error: "Server error" });
    }
});

app.get('/api/team/:userId', async (req, res) => {
    try {
        const team = [];
        const snap = await db.ref('users').orderByChild('inviterId').equalTo(parseInt(req.params.userId)).once('value');
        snap.forEach(s => { team.push({ wallet: s.key, profile: s.val().profile, level: s.val().level || 0 }); });
        res.json({ success: true, team });
    } catch (error) {
        res.status(500).json({ success: false, error: "Server error" });
    }
});


// ===================================================================
// ==================== NEW ADMIN ENDPOINTS ==========================
// ===================================================================

const verifyAdmin = (req, res, next) => {
    const secret = process.env.ADMIN_SECRET_KEY;
    const authHeader = req.headers.authorization;
    if (!secret) {
        return res.status(500).json({ success: false, error: "Admin secret not configured on server." });
    }
    if (!authHeader || authHeader.split(' ')[1] !== secret) {
        return res.status(403).json({ success: false, error: "Forbidden: Invalid admin credentials." });
    }
    next();
};

app.get('/api/admin/withdrawals', verifyAdmin, async (req, res) => {
    try {
        const snap = await db.ref('withdrawals').orderByChild('status').equalTo('pending').once('value');
        const withdrawals = [];
        snap.forEach(childSnap => {
            withdrawals.push({ id: childSnap.key, ...childSnap.val() });
        });
        res.json({ success: true, withdrawals });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/approve-withdrawal', verifyAdmin, async (req, res) => {
    const { withdrawalId, txHash } = req.body;
    if (!withdrawalId || !txHash) return res.status(400).json({ success: false, error: "Missing withdrawalId or txHash" });

    try {
        const withdrawalRef = db.ref(`withdrawals/${withdrawalId}`);
        const snapshot = await withdrawalRef.once('value');
        if (!snapshot.exists() || snapshot.val().status !== 'pending') {
            return res.status(404).json({ success: false, error: "Withdrawal not found or not pending." });
        }
        await withdrawalRef.update({
            status: 'completed',
            txHash: txHash,
            approvedAt: admin.database.ServerValue.TIMESTAMP
        });
        res.json({ success: true, message: `Withdrawal ${withdrawalId} approved.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/distribute-salary', verifyAdmin, async (req, res) => {
    try {
        console.log("Starting weekly salary distribution...");

        const platformStats = (await db.ref('platformStats').once('value')).val() || {};
        const totalSalaryFund = platformStats.totalWeeklySalaryFund || 0;
        if (totalSalaryFund <= 0) {
            return res.status(200).json({ success: true, message: "Salary fund is zero. Nothing to distribute." });
        }
        
        const distributablePool = totalSalaryFund * 0.90; // 90% is distributed
        
        // 1. Get all eligible users (level >= 5)
        const eligibleUsersSnap = await db.ref('users').orderByChild('level').startAt(5).once('value');
        if (!eligibleUsersSnap.exists()) {
            return res.status(200).json({ success: true, message: "No eligible users for salary." });
        }
        
        const eligibleUsers = [];
        eligibleUsersSnap.forEach(snap => {
            eligibleUsers.push({ wallet: snap.key, ...snap.val() });
        });

        // 2. Calculate performance score for each user
        let totalPerformanceScore = 0;
        const usersWithScores = [];

        for (const user of eligibleUsers) {
            let teamLevelSum = 0;
            const teamSnap = await db.ref('users').orderByChild('inviterId').equalTo(user.profile.userId).once('value');
            if (teamSnap.exists()) {
                teamSnap.forEach(memberSnap => {
                    teamLevelSum += memberSnap.val().level || 0;
                });
            }
            // Performance score = user's level + sum of their direct team's levels
            const performanceScore = (user.level || 0) + teamLevelSum;
            usersWithScores.push({ ...user, performanceScore });
            totalPerformanceScore += performanceScore;
        }

        if (totalPerformanceScore === 0) {
            return res.status(200).json({ success: true, message: "Total performance score is zero. Cannot distribute." });
        }

        // 3. Distribute salary based on score
        let distributedCount = 0;
        const distributionDate = new Date().toISOString();
        const distributionLog = {
            totalFund: totalSalaryFund,
            distributedAmount: distributablePool,
            eligibleUsers: eligibleUsers.length,
            totalPerformanceScore,
            distributedAt: admin.database.ServerValue.TIMESTAMP,
            userPayments: {}
        };

        for (const user of usersWithScores) {
            const userShare = (user.performanceScore / totalPerformanceScore) * distributablePool;
            if (userShare > 0) {
                const userRef = db.ref(`users/${user.wallet}`);
                await userRef.child('ztrBalance').transaction(b => (b || 0) + userShare);
                
                const salaryRecord = { amount: userShare, date: distributionDate, performanceScore: user.performanceScore, timestamp: admin.database.ServerValue.TIMESTAMP };
                await userRef.child('salaryHistory').push(salaryRecord);
                await userRef.child('incomeHistory').push({ ...salaryRecord, type: 'Weekly Salary' });

                distributionLog.userPayments[user.profile.userId] = { share: userShare, score: user.performanceScore };
                distributedCount++;
            }
        }

        // 4. Reset the weekly fund and log the event
        await db.ref('platformStats/totalWeeklySalaryFund').set(0);
        await db.ref('salaryDistributionLogs').push(distributionLog);

        const successMessage = `Salary distribution complete. ${distributablePool.toFixed(2)} ZTR distributed to ${distributedCount} users.`;
        console.log(successMessage);
        res.json({ success: true, message: successMessage });

    } catch (error) {
        console.error("Salary Distribution Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
