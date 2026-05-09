const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();

// --- CORS Configuration ---
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());
app.use(express.json());

// --- Environment Variable Checks ---
const REQUIRED_ENV_VARS = [
    'FIREBASE_SERVICE_ACCOUNT_BASE64',
    'FIREBASE_DB_URL',
    'ADMIN_API_SECRET_KEY' // Secret key for securing admin endpoints
];

for (const varName of REQUIRED_ENV_VARS) {
    if (!process.env[varName]) {
        console.error(`🔥 FATAL ERROR: Environment variable ${varName} is not set.`);
        process.exit(1);
    }
}

// --- Firebase Admin Setup ---
let db;
try {
    const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf-8'));
    
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DB_URL
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

// --- Caching ---
let levelsCache = null;
let levelsCacheTime = 0;
const CACHE_TTL = 60 * 1000; // 1 minute

// ===================================================================
// ==================== HELPER FUNCTIONS =============================
// ===================================================================

async function firebaseRetry(operation, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await operation();
        } catch (error) {
            console.warn(`Firebase operation failed. Retry ${i + 1}/${retries}... Error: ${error.message}`);
            if (i === retries - 1) throw error;
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
        console.warn("⚠️ Using fallback level configuration. Please set 'config/levels' in your Firebase database.");
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
    }
    levelsCache = levels;
    levelsCacheTime = now;
    return levels;
}

async function getRegistrationFee() {
    const levels = await getLevelsConfig();
    const starterLevel = levels.find(l => l.id === 0);
    if (!starterLevel) return 5.25; // Fallback
    return (starterLevel.price || 0) + (starterLevel.salaryFund || 0) + (starterLevel.fee || 0);
}

async function getZTRPrice() {
    const snapshot = await firebaseRetry(() => db.ref('config/baseZTRPrice').once('value'));
    return snapshot.exists() ? snapshot.val() : 1.0;
}

async function verifyTransaction(txHash, fromWallet, toWallet, expectedAmount) {
    console.log(`Verifying transaction: ${txHash}`);
    try {
        if (!txHash || !ethers.isHexString(txHash, 32)) {
            console.error("Invalid txHash format.");
            return false;
        }
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) {
            console.error("Transaction failed or not found.");
            return false;
        }
        
        const decimals = await usdtContract.decimals();
        const expectedAmountWei = ethers.parseUnits(expectedAmount.toString(), decimals);
        const tolerance = expectedAmountWei * BigInt(5) / BigInt(1000); // 0.5% tolerance
        const minRequired = expectedAmountWei - tolerance;

        const transferEvent = usdtContract.interface.getEvent("Transfer");
        
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === USDT_CONTRACT.toLowerCase()) {
                try {
                    const parsedLog = usdtContract.interface.parseLog(log);
                    if (parsedLog && parsedLog.name === "Transfer") {
                        const { from, to, value } = parsedLog.args;
                        if (from.toLowerCase() === fromWallet.toLowerCase() && 
                            to.toLowerCase() === toWallet.toLowerCase() && 
                            value >= minRequired) {
                            console.log("✅ Transaction verified successfully.");
                            return true;
                        }
                    }
                } catch (e) { /* Ignore parsing errors for other logs */ }
            }
        }
        console.error("Verification failed: No matching Transfer event found.");
        return false;
    } catch (error) {
        console.error("Error during transaction verification:", error.message);
        return false;
    }
}

async function generateInviteCode() {
    let code, isUnique = false;
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let attempt = 0; attempt < 50; attempt++) {
        code = Array.from({ length: 8 }, () => characters.charAt(Math.floor(Math.random() * characters.length))).join('');
        const snapshot = await db.ref(`inviteCodeMap/${code}`).once('value');
        if (!snapshot.exists()) {
            isUnique = true;
            break;
        }
    }
    if (!isUnique) code += Date.now().toString(36).slice(-3); // Ensure uniqueness
    return code;
}

// ===================================================================
// ==================== CORE LOGIC: COMMISSIONS & AIRDROPS ===========
// ===================================================================

async function addStarToLevel(recipientWallet, levelId, starType, sourceUserId) {
    if (!recipientWallet || levelId === undefined || !starType || !sourceUserId) {
        console.error("addStarToLevel: Missing required parameters.");
        return;
    }
    try {
        const starRef = db.ref(`users/${recipientWallet.toLowerCase()}/levelStars/level_${levelId}`);
        await starRef.push({
            type: starType,
            sourceUserId: sourceUserId,
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        console.log(`🌟 Star added to level ${levelId} for wallet ${recipientWallet} from user ${sourceUserId}.`);
    } catch (error) {
        console.error(`Error adding star:`, error);
    }
}

async function addCommission(userId, amount, type, starType, levelId, sourceUserId) {
    if (!userId || !amount || amount <= 0) {
        console.warn(`addCommission: Invalid parameters. UserID: ${userId}, Amount: ${amount}. Skipping.`);
        return false;
    }

    try {
        const walletSnapshot = await firebaseRetry(() => db.ref(`userIdMap/${userId}`).once('value'));
        if (!walletSnapshot.exists()) {
            console.error(`Commission Error: User ID ${userId} not found in userIdMap.`);
            return false;
        }
        const wallet = walletSnapshot.val().toLowerCase();
        const userRef = db.ref(`users/${wallet}`);

        // Use transaction for atomic updates
        await userRef.child('ztrBalance').transaction(balance => (balance || 0) + amount);
        await userRef.child('incomeHistory').push({
            amount, type, date: new Date().toISOString(), timestamp: admin.database.ServerValue.TIMESTAMP
        });
        await db.ref('platformStats/totalZTRDistributed').transaction(total => (total || 0) + amount);

        console.log(`💰 Commission Added: ${amount} ZTR to User ID ${userId} for "${type}"`);

        // Add star if applicable
        if (starType && levelId !== undefined && sourceUserId) {
            await addStarToLevel(wallet, levelId, starType, sourceUserId);
        }
        return true;
    } catch (error) {
        console.error(`FATAL Error in addCommission for User ID ${userId}:`, error);
        return false;
    }
}

async function distributeAirdropPoints(userWallet, levelId) {
    const levels = await getLevelsConfig();
    const levelConfig = levels.find(l => l.id === levelId);
    if (!levelConfig || !levelConfig.airdropPoints) return;

    const points = levelConfig.airdropPoints;
    const ztrBonus = points * 0.001; // 10 ZTR per 10,000 points

    const awardPointsAndBonus = async (wallet, reason) => {
        const ref = db.ref(`users/${wallet}`);
        await ref.child('airdropPoints').transaction(p => (p || 0) + points);
        if (ztrBonus > 0) {
            await ref.child('ztrBalance').transaction(b => (b || 0) + ztrBonus);
            await ref.child('incomeHistory').push({
                amount: ztrBonus, type: `Airdrop ZTR Bonus (Lvl ${levelId})`, date: new Date().toISOString()
            });
            await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + ztrBonus);
        }
        await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + points);
        console.log(`🪂 Airdrop Awarded: ${points} points and ${ztrBonus.toFixed(2)} ZTR to ${wallet} (${reason}).`);
    };

    // Award to the user
    await awardPointsAndBonus(userWallet, 'User Action');

    // Award to the inviter
    const userSnap = await db.ref(`users/${userWallet}`).once('value');
    const inviterId = userSnap.val()?.inviterId;
    if (inviterId) {
        const inviterWalletSnap = await db.ref(`userIdMap/${inviterId}`).once('value');
        if (inviterWalletSnap.exists()) {
            await awardPointsAndBonus(inviterWalletSnap.val(), 'Inviter Bonus');
        }
    }
}


async function distributeCommissions(inviterId, newUserId, levelId, commissionableAmount) {
    console.log(`--- Distributing Commissions for Level ${levelId} ---`);
    console.log(`Source User: ${newUserId}, Inviter: ${inviterId}, Amount: ${commissionableAmount} ZTR`);

    const levelName = `Level ${levelId}`;

    // 1. Direct Commission (55%)
    await addCommission(inviterId, commissionableAmount * 0.55, `${levelName} Direct Commission`, 'direct', levelId, newUserId);

    // 2. Upline Commission (7%)
    const inviterWalletSnap = await db.ref(`userIdMap/${inviterId}`).once('value');
    if (inviterWalletSnap.exists()) {
        const inviterUserSnap = await db.ref(`users/${inviterWalletSnap.val()}`).once('value');
        const uplineId = inviterUserSnap.val()?.inviterId;
        if (uplineId) {
            await addCommission(uplineId, commissionableAmount * 0.07, `${levelName} Upline Commission`, 'upline', levelId, newUserId);
        } else {
            console.log(`No upline found for inviter ${inviterId}.`);
        }
    } else {
        console.warn(`Could not find wallet for inviter ID ${inviterId}.`);
    }

    // 3. Team Commission (20%)
    const teamSnap = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
    if (teamSnap.exists()) {
        const team = [];
        teamSnap.forEach(snap => {
            const user = snap.val();
            // Add to team only if it's not the new user themselves
            if (user.profile && user.profile.userId !== newUserId) {
                team.push(user.profile.userId);
            }
        });

        if (team.length > 0) {
            const share = (commissionableAmount * 0.20) / team.length;
            console.log(`Distributing team commission of ${share.toFixed(4)} ZTR to ${team.length} members.`);
            for (const memberId of team) {
                await addCommission(memberId, share, `${levelName} Team Commission`, 'downline', levelId, newUserId);
            }
        } else {
            console.log(`Inviter ${inviterId} has no other team members for team commission.`);
        }
    } else {
        console.log(`Inviter ${inviterId} has no team.`);
    }
    console.log(`--- Commission Distribution Complete for Level ${levelId} ---`);
}


// ===================================================================
// ==================== API ENDPOINTS ================================
// ===================================================================

app.get('/api/config', async (req, res) => {
    try {
        const [levels, registrationFee, ztrPrice] = await Promise.all([
            getLevelsConfig(),
            getRegistrationFee(),
            getZTRPrice()
        ]);
        res.json({ success: true, config: { levels, registrationFee, ztrPrice, adminWallet: ADMIN_WALLET, usdtContract: USDT_CONTRACT } });
    } catch (error) {
        console.error("Config endpoint error:", error.message);
        res.status(500).json({ success: false, error: "Configuration could not be loaded." });
    }
});

app.post('/api/register', async (req, res) => {
    const { wallet, txHash, inviterId, username, profilePic, registrationCost } = req.body;
    const walletLower = wallet ? wallet.toLowerCase() : null;

    if (!walletLower || !txHash || !inviterId || !username || !registrationCost) {
        return res.status(400).json({ success: false, error: "Missing required fields." });
    }

    try {
        // --- Pre-checks ---
        const userRef = db.ref(`users/${walletLower}`);
        if ((await userRef.once('value')).exists()) {
            return res.status(400).json({ success: false, error: "This wallet is already registered." });
        }
        const inviterRef = db.ref(`userIdMap/${inviterId}`);
        if (!(await inviterRef.once('value')).exists()) {
            return res.status(400).json({ success: false, error: "Inviter ID is not valid." });
        }
        
        // --- Transaction Verification ---
        const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, registrationCost);
        if (!isValid) {
            return res.status(400).json({ success: false, error: "Payment verification failed. Please try again or contact support." });
        }

        // --- Create User ---
        const idRes = await db.ref('nextUserId').transaction(id => (id || 1000) + 1);
        if(!idRes.committed) throw new Error("Could not generate a new user ID.");
        const userId = idRes.snapshot.val();
        
        const inviteCode = await generateInviteCode();
        
        const levels = await getLevelsConfig();
        const starterLevel = levels.find(l => l.id === 0);
        if (starterLevel && starterLevel.salaryFund > 0) {
            await db.ref('platformStats/totalWeeklySalaryFund').transaction(p => (p || 0) + starterLevel.salaryFund);
        }

        const newUser = {
            profile: { name: username.substring(0, 30), userId, joinDate: new Date().toLocaleDateString('en-GB'), profilePicUrl: profilePic || null },
            inviteCode, inviterId: parseInt(inviterId), paid: true, ztrBalance: 0, airdropPoints: 0, level: 0, teamSize: 0,
        };

        await userRef.set(newUser);
        await db.ref(`userIdMap/${userId}`).set(walletLower);
        await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower);

        // --- Post-creation Actions ---
        await db.ref('platformStats/totalParticipants').transaction(p => (p || 0) + 1);
        const inviterWallet = (await inviterRef.once('value')).val();
        await db.ref(`users/${inviterWallet}/teamSize`).transaction(s => (s || 0) + 1);
        
        await distributeCommissions(parseInt(inviterId), userId, 0, starterLevel.price);
        await distributeAirdropPoints(walletLower, 0);

        res.status(201).json({ success: true, userId });
    } catch (error) {
        console.error("Registration error:", error.message);
        res.status(500).json({ success: false, error: "An internal server error occurred during registration." });
    }
});


app.post('/api/upgrade', async (req, res) => {
    const { wallet, txHash, levelId, upgradeCost, levelPrice } = req.body;
    const walletLower = wallet ? wallet.toLowerCase() : null;

    if (!walletLower || !txHash || levelId === undefined || !upgradeCost || !levelPrice) {
        return res.status(400).json({ success: false, error: "Missing required fields for upgrade." });
    }
    
    try {
        const userRef = db.ref(`users/${walletLower}`);
        const userSnap = await userRef.once('value');
        if (!userSnap.exists()) return res.status(404).json({ success: false, error: "User not found." });
        
        const user = userSnap.val();
        if ((user.level || 0) !== levelId - 1) {
            return res.status(400).json({ success: false, error: "Upgrades must be done sequentially." });
        }
        
        const levels = await getLevelsConfig();
        const levelConfig = levels.find(l => l.id === levelId);
        if (!levelConfig) return res.status(400).json({ success: false, error: "Invalid level specified." });
        
        const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, upgradeCost);
        if (!isValid) return res.status(400).json({ success: false, error: "Upgrade payment verification failed." });

        // --- Update User and Platform Stats ---
        if (levelConfig.salaryFund > 0) {
            await db.ref('platformStats/totalWeeklySalaryFund').transaction(p => (p || 0) + levelConfig.salaryFund);
        }
        await userRef.child('level').set(levelId);
        
        // --- Distribute Commissions & Airdrops ---
        await distributeCommissions(user.inviterId, user.profile.userId, levelId, levelPrice);
        await distributeAirdropPoints(walletLower, levelId);

        res.json({ success: true, message: `Successfully upgraded to Level ${levelId}!` });
    } catch (error) {
        console.error(`Upgrade error for wallet ${walletLower}:`, error.message);
        res.status(500).json({ success: false, error: "An internal server error occurred during upgrade." });
    }
});


app.post('/api/withdraw', async (req, res) => {
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ success: false, error: "Wallet address is required." });

    const walletLower = wallet.toLowerCase();
    const userRef = db.ref(`users/${walletLower}`);

    try {
        const userData = (await userRef.once('value')).val();
        if (!userData) return res.status(404).json({ success: false, error: "User not found." });
        if ((userData.ztrBalance || 0) < 10) return res.status(400).json({ success: false, error: "Minimum withdrawal amount is 10 ZTR." });

        // Check for existing pending withdrawal
        const withdrawalsSnap = await db.ref('withdrawals').orderByChild('userWallet').equalTo(walletLower).once('value');
        let hasPending = false;
        if (withdrawalsSnap.exists()) {
            withdrawalsSnap.forEach(snap => {
                if (snap.val().status === 'pending') {
                    hasPending = true;
                }
            });
        }
        if (hasPending) {
            return res.status(400).json({ success: false, error: "You already have a pending withdrawal request." });
        }

        const withdrawalAmount = userData.ztrBalance;
        await db.ref('withdrawals').push({
            userWallet: walletLower,
            userId: userData.profile.userId,
            amount: withdrawalAmount,
            status: 'pending',
            timestamp: admin.database.ServerValue.TIMESTAMP
        });

        await userRef.child('ztrBalance').set(0);

        res.json({ success: true, message: `Withdrawal request for ${withdrawalAmount.toFixed(2)} ZTR submitted.` });
    } catch (error) {
        console.error(`Withdrawal error for ${walletLower}:`, error.message);
        res.status(500).json({ success: false, error: "An error occurred while processing your withdrawal." });
    }
});

app.post('/api/claim-task-reward', async (req, res) => {
    const { wallet, taskRequired, taskPoints } = req.body;
    const walletLower = wallet ? wallet.toLowerCase() : null;
    
    if (!walletLower || !taskRequired || !taskPoints) {
        return res.status(400).json({ success: false, error: "Missing parameters." });
    }

    try {
        const userRef = db.ref(`users/${walletLower}`);
        const userSnap = await userRef.once('value');
        const user = userSnap.val();

        if (!user) return res.status(404).json({ success: false, error: "User not found." });
        if ((user.teamSize || 0) < taskRequired) return res.status(400).json({ success: false, error: "You are not yet eligible for this reward." });

        const taskKey = `task_${taskRequired}`;
        if (user.claimedTasks && user.claimedTasks[taskKey]) {
            return res.status(400).json({ success: false, error: "You have already claimed this reward." });
        }

        const ztrBonus = taskPoints * 0.001;
        await userRef.child(`claimedTasks/${taskKey}`).set(true);
        await userRef.child('airdropPoints').transaction(p => (p || 0) + taskPoints);
        await userRef.child('ztrBalance').transaction(b => (b || 0) + ztrBonus);
        
        await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + taskPoints);
        await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + ztrBonus);

        console.log(`✅ Task Reward Claimed: User ${user.profile.userId} claimed ${taskPoints} points & ${ztrBonus} ZTR for inviting ${taskRequired} members.`);
        res.json({ success: true, message: `Claimed ${taskPoints} points and ${ztrBonus.toFixed(2)} ZTR!` });
    } catch (error) {
        console.error(`Task claim error for ${walletLower}:`, error.message);
        res.status(500).json({ success: false, error: "An error occurred while claiming the task reward." });
    }
});


// --- Read-Only Endpoints ---
app.get('/api/platform-data', async (req, res) => {
    try {
        const [statsSnap, usersSnap] = await Promise.all([
            db.ref('platformStats').once('value'),
            db.ref('users').orderByChild('ztrBalance').limitToLast(100).once('value')
        ]);

        const stats = statsSnap.val() || {};
        
        const salaryActive = await db.ref('users').orderByChild('level').startAt(5).once('value');
        stats.salaryActiveMembers = salaryActive.numChildren();
        
        const allUsersCount = await db.ref('users').once('value');
        stats.totalParticipants = allUsersCount.numChildren();

        const leaderboard = [];
        usersSnap.forEach(u => {
            const val = u.val();
            if (val.profile) {
                leaderboard.push({ name: val.profile.name, userId: val.profile.userId, profilePicUrl: val.profile.profilePicUrl, earnings: val.ztrBalance || 0 });
            }
        });

        res.json({ success: true, stats, leaderboard: leaderboard.reverse() });
    } catch (error) {
        console.error("Platform data error:", error.message);
        res.status(500).json({ success: false, error: "Could not fetch platform data." });
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
        res.status(500).json({ success: false, error: "Internal server error" });
    }
});

app.get('/api/team/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        if (isNaN(userId)) return res.status(400).json({ success: false, error: "Invalid User ID." });

        const team = [];
        const snap = await db.ref('users').orderByChild('inviterId').equalTo(userId).once('value');
        if (snap.exists()) {
            snap.forEach(s => { 
                team.push({ wallet: s.key, profile: s.val().profile, level: s.val().level || 0 }); 
            });
        }
        res.json({ success: true, team });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to fetch team data." });
    }
});

// ===================================================================
// ==================== ADMIN ENDPOINTS ==============================
// ===================================================================

// Middleware for Admin Authentication
const adminAuth = (req, res, next) => {
    const providedKey = req.header('Authorization');
    if (providedKey === process.env.ADMIN_API_SECRET_KEY) {
        next();
    } else {
        res.status(403).json({ success: false, error: 'Forbidden: Invalid admin secret key.' });
    }
};

app.post('/api/admin/distribute-salary', adminAuth, async (req, res) => {
    console.log("--- Starting Weekly Salary Distribution ---");
    try {
        const statsRef = db.ref('platformStats');
        const salaryFundSnap = await statsRef.child('totalWeeklySalaryFund').once('value');
        const totalSalaryFund = salaryFundSnap.val() || 0;

        if (totalSalaryFund <= 0) {
            console.log("Salary fund is zero. No distribution needed.");
            return res.status(200).json({ success: true, message: "Salary fund is zero. Nothing to distribute." });
        }

        const eligibleUsersSnap = await db.ref('users').orderByChild('level').startAt(5).once('value');
        if (!eligibleUsersSnap.exists()) {
            console.log("No users are eligible for salary (Level 5+).");
            return res.status(200).json({ success: true, message: "No eligible users found." });
        }
        
        const usersData = [];
        let totalPerformanceScore = 0;

        // Step 1: Calculate performance score for each eligible user
        for (const userSnap of Object.values(eligibleUsersSnap.val())) {
            const userLevel = userSnap.level || 0;
            let teamLevelSum = 0;
            const teamSnap = await db.ref('users').orderByChild('inviterId').equalTo(userSnap.profile.userId).once('value');
            if (teamSnap.exists()) {
                teamSnap.forEach(memberSnap => {
                    teamLevelSum += (memberSnap.val().level || 0);
                });
            }
            // Performance score = user's level + sum of their direct team's levels
            const performanceScore = userLevel + teamLevelSum;
            if (performanceScore > 0) {
                usersData.push({ wallet: userSnap.profile.userId, performanceScore, ref: db.ref(`users/${userSnap.inviteCodeMap[userSnap.profile.userId]}`) });
                totalPerformanceScore += performanceScore;
            }
        }
        
        if (totalPerformanceScore === 0) {
            return res.status(200).json({ success: true, message: "Total performance score is zero. Cannot distribute." });
        }

        // Step 2: Distribute salary proportionally
        let distributedAmount = 0;
        for (const userData of usersData) {
            const userShare = (userData.performanceScore / totalPerformanceScore) * totalSalaryFund;
            distributedAmount += userShare;
            const userWalletSnap = await db.ref(`userIdMap/${userData.wallet}`).once('value');
            if (userWalletSnap.exists()) {
                const wallet = userWalletSnap.val();
                const userRef = db.ref(`users/${wallet}`);
                await userRef.child('ztrBalance').transaction(b => (b || 0) + userShare);
                await userRef.child('salaryHistory').push({ amount: userShare, date: new Date().toISOString() });
                console.log(`Paid ${userShare.toFixed(4)} ZTR salary to User ID ${userData.wallet}`);
            }
        }

        // Step 3: Reset the salary fund and log the distribution
        await statsRef.child('totalWeeklySalaryFund').set(0);
        await statsRef.child('salaryDistributionHistory').push({
            amountDistributed: distributedAmount,
            date: new Date().toISOString(),
            eligibleUsers: usersData.length
        });
        
        console.log(`--- Salary Distribution Complete. Total: ${distributedAmount.toFixed(4)} ZTR ---`);
        res.status(200).json({ success: true, message: `Distributed ${distributedAmount.toFixed(4)} ZTR among ${usersData.length} users.` });

    } catch (error) {
        console.error("FATAL ERROR during salary distribution:", error);
        res.status(500).json({ success: false, error: "An error occurred during salary distribution." });
    }
});


// ===================================================================
// ==================== SERVER START =================================
// ===================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
