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

// --- Helper Functions ---
async function firebaseRetry(operation, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await operation();
        } catch (error) {
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
        // Fallback including Level 0 (Starter) as requested
        levels = [
            { id: 0, name: "Starter", price: 5, salaryFund: 0, fee: 0.25, icon: "🌱", airdropPoints: 100, salary: 0 },
            { id: 1, name: "Iron", price: 5, salaryFund: 1, fee: 0.18, icon: "🛡️", airdropPoints: 100, salary: 0 },
            { id: 2, name: "Bronze", price: 10, salaryFund: 2, fee: 0.36, icon: "🥉", airdropPoints: 200, salary: 0 },
            { id: 3, name: "Silver", price: 15, salaryFund: 3, fee: 0.54, icon: "🥈", airdropPoints: 300, salary: 0 },
            { id: 4, name: "Gold", price: 20, salaryFund: 4, fee: 0.72, icon: "🥇", airdropPoints: 400, salary: 0 },
            { id: 5, name: "Master", price: 25, salaryFund: 5, fee: 0.9, icon: "👑", airdropPoints: 500, salary: 10 },
            { id: 6, name: "Grandmaster", price: 50, salaryFund: 10, fee: 1.8, icon: "⚔️", airdropPoints: 1000, salary: 25 },
            { id: 7, name: "Legend", price: 100, salaryFund: 20, fee: 3.6, icon: "🌟", airdropPoints: 2000, salary: 60 }
        ];
        console.warn("⚠️ Using fallback level configuration including Starter");
    }
    
    levelsCache = levels;
    levelsCacheTime = now;
    return levels;
}

async function getRegistrationFee() {
    const levels = await getLevelsConfig();
    // Registration cost is now driven by Level 0 (Starter)
    const starterLevel = levels.find(l => l.id === 0) || levels[0];
    const price = starterLevel.price || 5;
    const salaryFund = starterLevel.salaryFund || 0;
    const fee = starterLevel.fee || 0.25;
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
                        if (from.toLowerCase() === fromWallet.toLowerCase() &&
                            to.toLowerCase() === toWallet.toLowerCase() &&
                            value >= minRequired) {
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
    try {
        const starRef = db.ref(`users/${recipientWallet.toLowerCase()}/levelStars/level_${levelId}`);
        await starRef.push({
            type: starType,
            sourceUserId: sourceUserId,
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
    } catch (error) {
        console.error(`Star addition failed:`, error);
    }
}

async function addCommission(userId, amount, type, starType, levelId, sourceUserId, starLevelId) {
    if (!userId || isNaN(userId) || amount <= 0) return false;
    try {
        const walletSnapshot = await firebaseRetry(() => db.ref(`userIdMap/${userId}`).once('value'));
        if (!walletSnapshot.exists()) return false;
        const wallet = walletSnapshot.val();
        const userRef = db.ref(`users/${wallet}`);
        
        await userRef.child('ztrBalance').transaction(balance => (balance || 0) + amount);
        await userRef.child('incomeHistory').push({
            amount: amount, type: type, date: new Date().toISOString(), timestamp: admin.database.ServerValue.TIMESTAMP
        });
        await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + amount);
        
        if (starType && levelId !== undefined && sourceUserId) {
            await addStarToLevel(wallet, starLevelId !== undefined ? starLevelId : levelId, starType, sourceUserId);
        }
        return true;
    } catch (error) {
        return false;
    }
}

async function distributeRegistrationCommissions(inviterId, newUserId) {
    const levels = await getLevelsConfig();
    const starterLevel = levels.find(l => l.id === 0) || levels[0];
    const commissionableAmount = starterLevel.price;

    // 1. Direct (55%) + Star in Starter Level (0)
    await addCommission(inviterId, commissionableAmount * 0.55, 'Direct Commission', 'direct', 0, newUserId, 0);
    
    // 2. Upline (7%) + Star in Starter Level (0)
    const inviterWallet = await firebaseRetry(() => db.ref(`userIdMap/${inviterId}`).once('value'));
    if (inviterWallet.exists()) {
        const inviterData = await firebaseRetry(() => db.ref(`users/${inviterWallet.val()}`).once('value'));
        if (inviterData.exists() && inviterData.val().inviterId) {
            await addCommission(inviterData.val().inviterId, commissionableAmount * 0.07, 'Upline Commission', 'upline', 0, newUserId, 0);
        }
    }
    
    // 3. Team (20%) + Star in Starter Level (0)
    const teamMembersSnapshot = await firebaseRetry(() => db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value'));
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
                await addCommission(member.userId, share, 'Team Commission', 'downline', 0, newUserId, 0);
            }
        }
    }
}

async function distributeUpgradeCommissions(upgradingUserWallet, levelId, levelPrice) {
    const snap = await firebaseRetry(() => db.ref(`users/${upgradingUserWallet.toLowerCase()}`).once('value'));
    const user = snap.val();
    if (!user || !user.inviterId) return;

    const upgradingUserId = user.profile.userId;
    const inviterId = user.inviterId;

    await addCommission(inviterId, levelPrice * 0.55, 'Direct Upgrade Commission', 'direct', levelId, upgradingUserId, levelId);
    
    const inviterWallet = await firebaseRetry(() => db.ref(`userIdMap/${inviterId}`).once('value'));
    if (inviterWallet.exists()) {
        const inviterData = await firebaseRetry(() => db.ref(`users/${inviterWallet.val()}`).once('value'));
        if (inviterData.exists() && inviterData.val().inviterId) {
            await addCommission(inviterData.val().inviterId, levelPrice * 0.07, 'Upline Upgrade Commission', 'upline', levelId, upgradingUserId, levelId);
        }
    }

    const teamSnap = await firebaseRetry(() => db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value'));
    if (teamSnap.exists()) {
        const team = [];
        teamSnap.forEach(s => {
            if (s.key.toLowerCase() !== upgradingUserWallet.toLowerCase() && s.val().profile) {
                team.push({ userId: s.val().profile.userId });
            }
        });
        if (team.length > 0) {
            const share = (levelPrice * 0.20) / team.length;
            for (const member of team) {
                await addCommission(member.userId, share, 'Team Upgrade Commission', 'downline', levelId, upgradingUserId, levelId);
            }
        }
    }
}

async function distributeAirdropPoints(userWallet, levelId) {
    const levels = await getLevelsConfig();
    const config = levels.find(l => l.id === levelId);
    if (!config || !config.airdropPoints) return;

    const points = config.airdropPoints;
    await db.ref(`users/${userWallet}/airdropPoints`).transaction(p => (p || 0) + points);
    await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + points);

    const userSnap = await db.ref(`users/${userWallet}`).once('value');
    if (userSnap.exists() && userSnap.val().inviterId) {
        const inviterWallet = await db.ref(`userIdMap/${userSnap.val().inviterId}`).once('value');
        if (inviterWallet.exists()) {
            await db.ref(`users/${inviterWallet.val()}/airdropPoints`).transaction(p => (p || 0) + points);
            await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + points);
        }
    }
}

// --- API Endpoints ---

app.get('/api/health', (req, res) => res.json({ success: true, status: 'healthy' }));

app.get('/api/config', async (req, res) => {
    try {
        const levels = await getLevelsConfig();
        const registrationFee = await getRegistrationFee();
        const ztrPrice = await getZTRPrice();
        res.json({ success: true, config: { levels, registrationFee, ztrPrice, adminWallet: ADMIN_WALLET, usdtContract: USDT_CONTRACT } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/register', async (req, res) => {
    const { wallet, txHash, inviterId, username, profilePic, registrationCost } = req.body;
    try {
        const fee = await getRegistrationFee();
        const price = await getZTRPrice();
        const expected = (fee * price).toFixed(2);
        
        const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, registrationCost);
        if (!isValid) return res.status(400).json({ success: false, error: "Transaction verification failed" });

        const walletLower = wallet.toLowerCase();
        const userRef = db.ref(`users/${walletLower}`);
        if ((await userRef.once('value')).exists()) return res.status(400).json({ success: false, error: "Already registered" });

        const idRes = await db.ref('nextUserId').transaction(id => (id || 1000) + 1);
        const userId = idRes.snapshot.val();
        const inviteCode = await generateInviteCode();

        await userRef.set({
            profile: { name: username.substring(0, 30), userId, joinDate: new Date().toLocaleDateString('en-GB'), profilePicUrl: profilePic || null },
            inviteCode, inviterId: parseInt(inviterId), paid: true, ztrBalance: 0, airdropPoints: 100, level: 0, teamSize: 0, 
            levelStars: {}, claimedTasks: {}, incomeHistory: {}, salaryHistory: {}
        });

        await db.ref(`userIdMap/${userId}`).set(walletLower);
        await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower);

        const inviterWallet = await db.ref(`userIdMap/${inviterId}`).once('value');
        if (inviterWallet.exists()) {
            await db.ref(`users/${inviterWallet.val()}/teamSize`).transaction(s => (s || 0) + 1);
            await db.ref(`users/${inviterWallet.val()}/airdropPoints`).transaction(p => (p || 0) + 100);
            await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + 100);
        }

        await distributeRegistrationCommissions(inviterId, userId);
        await db.ref('platformStats/totalParticipants').transaction(p => (p || 0) + 1);

        res.status(201).json({ success: true, userId });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/upgrade', async (req, res) => {
    const { wallet, txHash, levelId, upgradeCost, levelPrice } = req.body;
    try {
        const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, upgradeCost);
        if (!isValid) return res.status(400).json({ success: false, error: "Payment verification failed" });

        const levels = await getLevelsConfig();
        const config = levels.find(l => l.id === levelId);
        const walletLower = wallet.toLowerCase();
        
        if (config.salaryFund > 0) await db.ref('platformStats/totalWeeklySalaryFund').transaction(p => (p || 0) + config.salaryFund);
        
        await db.ref(`users/${walletLower}/level`).set(levelId);
        await distributeAirdropPoints(walletLower, levelId);
        await distributeUpgradeCommissions(walletLower, levelId, levelPrice);

        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/platform-data', async (req, res) => {
    try {
        const stats = (await db.ref('platformStats').once('value')).val() || {};
        const totalAirdrop = stats.totalAirdropDistributed || 0;

        // --- Milestone Progress Logic ---
        const milestones = [10000, 100000, 450000, 1000000, 1500000];
        let currentMilestone = milestones[0];
        let previousMilestone = 0;

        for (let m of milestones) {
            if (totalAirdrop < m) {
                currentMilestone = m;
                break;
            }
            previousMilestone = m;
            currentMilestone = milestones[milestones.indexOf(m) + 1] || m;
        }

        const progressInMilestone = totalAirdrop - previousMilestone;
        const milestoneRange = currentMilestone - previousMilestone;
        const progressPercent = milestoneRange > 0 ? (progressInMilestone / milestoneRange) * 100 : 100;

        // 10K Points = 10 ZTR (1000:1 ratio)
        stats.totalAirdropZTR = (totalAirdrop / 1000).toFixed(2);
        stats.airdropProgress = {
            totalAirdrop,
            currentMilestone,
            previousMilestone,
            percent: Math.min(progressPercent, 100).toFixed(2)
        };

        const allUsers = await db.ref('users').once('value');
        stats.totalParticipants = allUsers.numChildren();
        
        const salaryUsers = await db.ref('users').orderByChild('level').startAt(5).once('value');
        stats.salaryActiveMembers = salaryUsers.numChildren();

        const usersSnap = await db.ref('users').orderByChild('ztrBalance').limitToLast(200).once('value');
        const leaderboard = [];
        usersSnap.forEach(s => {
            const u = s.val();
            if (u.profile && u.ztrBalance > 0) {
                leaderboard.push({ name: u.profile.name, userId: u.profile.userId, profilePicUrl: u.profile.profilePicUrl, earnings: u.ztrBalance });
            }
        });

        res.json({ success: true, stats, leaderboard: leaderboard.sort((a,b) => b.earnings - a.earnings) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/withdraw', async (req, res) => {
    const { wallet } = req.body;
    try {
        const userRef = db.ref(`users/${wallet.toLowerCase()}`);
        const data = (await userRef.once('value')).val();
        if (!data || data.ztrBalance < 10) return res.status(400).json({ success: false, error: "Insufficient balance" });

        await db.ref('withdrawals').push({ userWallet: wallet.toLowerCase(), amount: data.ztrBalance, status: 'pending', timestamp: admin.database.ServerValue.TIMESTAMP });
        await userRef.child('ztrBalance').set(0);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/user/:wallet', async (req, res) => {
    try {
        const snap = await db.ref(`users/${req.params.wallet.toLowerCase()}`).once('value');
        if (!snap.exists()) return res.status(404).json({ success: false });
        const userData = snap.val();
        const levels = await getLevelsConfig();
        res.json({ success: true, user: { ...userData, levelInfo: levels.find(l => l.id === (userData.level || 0)) } });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/team/:userId', async (req, res) => {
    try {
        const snap = await db.ref('users').orderByChild('inviterId').equalTo(parseInt(req.params.userId)).once('value');
        const team = [];
        snap.forEach(s => team.push({ wallet: s.key, profile: s.val().profile, level: s.val().level, ztrBalance: s.val().ztrBalance }));
        res.json({ success: true, team });
    } catch (e) { res.status(500).json({ success: false }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
