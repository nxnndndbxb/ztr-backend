// --- Imports: Zaroori packages ko import karna ---
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
require('dotenv').config();

// --- Express App Setup ---
const app = express();
app.use(cors()); // CORS ko enable karna taake frontend se request aa sake
app.use(express.json()); // JSON format mein data receive karne ke liye

// --- Firebase Admin Setup ---
// NOTE: Vercel environment variables mein FIREBASE_SERVICE_ACCOUNT_BASE64 aur FIREBASE_DB_URL set karna lazmi hai.
try {
    const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    const databaseURL = process.env.FIREBASE_DB_URL;

    if (!serviceAccountBase64) {
        throw new Error("FATAL ERROR: FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable is not set. Please check Vercel dashboard.");
    }
    if (!databaseURL) {
        throw new Error("FATAL ERROR: FIREBASE_DB_URL environment variable is not set. Please check Vercel dashboard.");
    }

    const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('ascii'));

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: databaseURL
    });
    console.log("Firebase Admin Initialized Successfully.");
} catch (error) {
    // CHANGE: Behtar error logging, server ko crash karne ke bajaye. Vercel logs mein error saaf nazar aayega.
    console.error("!!! FIREBASE ADMIN INITIALIZATION FAILED !!!");
    console.error("Error Message:", error.message);
    console.error("This is a critical error. The server cannot function without a database connection.");
    console.error("Please ensure FIREBASE_SERVICE_ACCOUNT_BASE64 and FIREBASE_DB_URL are correctly set in your Vercel Environment Variables and redeploy.");
}

const db = admin.database();

// --- Blockchain & Contract Configuration ---
const ADMIN_WALLET = "0x97efeaa1da1108acff52840550ec51dc5bbfd812";
const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955"; // USDT (BEP-20) on BSC
const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/");

const usdtAbi = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function decimals() view returns (uint8)"
];
const usdtContract = new ethers.Contract(USDT_CONTRACT, usdtAbi, provider);

// --- Helper Functions (Madadgar Functions) ---

function sanitizeInput(input) {
    if (!input) return '';
    return input.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function verifyTransaction(txHash, fromWallet, toWallet, expectedAmount) {
    try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) {
            console.log(`Verification failed for ${txHash}: Invalid receipt or tx failed.`);
            return false;
        }
        const decimals = await usdtContract.decimals();
        const expectedAmountWei = ethers.parseUnits(parseFloat(expectedAmount).toFixed(Number(decimals)), decimals);
        const tolerance = ethers.parseUnits("0.01", decimals);

        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === USDT_CONTRACT.toLowerCase()) {
                try {
                    const parsedLog = usdtContract.interface.parseLog(log);
                    if (parsedLog && parsedLog.name === "Transfer") {
                        const { from, to, value } = parsedLog.args;
                        if (
                            from.toLowerCase() === fromWallet.toLowerCase() &&
                            to.toLowerCase() === toWallet.toLowerCase() &&
                            value >= (expectedAmountWei - tolerance)
                        ) {
                            console.log(`Transaction ${txHash} verified successfully.`);
                            return true;
                        }
                    }
                } catch (e) { /* Ignore non-transfer logs */ }
            }
        }
        console.log(`Verification failed for ${txHash}: No matching USDT Transfer event.`);
        return false;
    } catch (e) {
        console.error(`Error during transaction verification for ${txHash}:`, e);
        return false;
    }
}

async function generateInviteCode() {
    let code;
    let isUnique = false;
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    while (!isUnique) {
        code = '';
        for (let i = 0; i < 8; i++) {
            code += characters.charAt(Math.floor(Math.random() * characters.length));
        }
        const snapshot = await db.ref(`inviteCodeMap/${code}`).once('value');
        if (!snapshot.exists()) {
            isUnique = true;
        }
    }
    return code;
}

async function addStarToLevel(recipientWallet, levelId, starType, sourceUserId) {
    if (!recipientWallet || !levelId || !starType || !sourceUserId) return;
    try {
        await db.ref(`users/${recipientWallet.toLowerCase()}/levelStars/level_${levelId}`).push({
            type: starType,
            sourceUserId: sourceUserId,
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
    } catch (error) {
        console.error(`Failed to add star for wallet ${recipientWallet}:`, error);
    }
}


async function distributeRegistrationCommissions(inviterId, newUserId) {
    const config = (await db.ref('config').once('value')).val();
    if (!config?.levels?.[0]?.price) return;
    const commissionableAmountInZTR = config.levels[0].price;

    const addCommission = async (userId, amount, type, starType) => {
        if (!userId || isNaN(userId) || amount <= 0) return;
        const wallet = (await db.ref(`userIdMap/${userId}`).once('value')).val();
        if (!wallet) return;
        const userRef = db.ref(`users/${wallet}`);
        await userRef.child('ztrBalance').transaction(b => (b || 0) + amount);
        await userRef.child('incomeHistory').push({ amount, type, date: new Date().toISOString() });
        await addStarToLevel(wallet, 1, starType, newUserId);
    };

    await addCommission(inviterId, commissionableAmountInZTR * 0.55, 'Direct Commission', 'direct');
    const inviterData = (await db.ref(`users/${(await db.ref(`userIdMap/${inviterId}`).once('value')).val()}`).once('value')).val();
    if (inviterData?.inviterId) {
        await addCommission(inviterData.inviterId, commissionableAmountInZTR * 0.07, 'Upline Commission', 'upline');
    }
    const teamPool = commissionableAmountInZTR * 0.20;
    const teamSnap = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
    if (teamSnap.exists()) {
        const team = Object.keys(teamSnap.val()).filter(wallet => teamSnap.val()[wallet].profile.userId !== newUserId);
        if (team.length > 0) {
            const share = teamPool / team.length;
            for (const memberWallet of team) {
                await addCommission(teamSnap.val()[memberWallet].profile.userId, share, 'Team Commission', 'downline');
            }
        }
    }
}

async function distributeUpgradeCommissions(upgradingUserWallet, levelId, levelPrice) {
    const upgradingUserData = (await db.ref(`users/${upgradingUserWallet.toLowerCase()}`).once('value')).val();
    if (!upgradingUserData?.inviterId || !upgradingUserData?.profile) return;
    const { userId: upgradingUserId, inviterId } = upgradingUserData.profile;
    const commissionableAmountInZTR = levelPrice;

    const addCommission = async (targetUserId, amount, type, starType) => {
        if (!targetUserId || isNaN(targetUserId) || amount <= 0) return;
        const wallet = (await db.ref(`userIdMap/${targetUserId}`).once('value')).val();
        if (!wallet) return;
        const userRef = db.ref(`users/${wallet}`);
        await userRef.child('ztrBalance').transaction(b => (b || 0) + amount);
        await userRef.child('incomeHistory').push({ amount, type, date: new Date().toISOString() });
        await addStarToLevel(wallet, levelId, starType, upgradingUserId);
    };

    await addCommission(inviterId, commissionableAmountInZTR * 0.55, 'Direct Upgrade Commission', 'direct');
    const inviterData = (await db.ref(`users/${(await db.ref(`userIdMap/${inviterId}`).once('value')).val()}`).once('value')).val();
    if (inviterData?.inviterId) {
        await addCommission(inviterData.inviterId, commissionableAmountInZTR * 0.07, 'Upline Upgrade Commission', 'upline');
    }
    const teamPool = commissionableAmountInZTR * 0.20;
    const teamSnap = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
    if (teamSnap.exists()) {
        const team = Object.keys(teamSnap.val()).filter(wallet => wallet.toLowerCase() !== upgradingUserWallet.toLowerCase());
        if (team.length > 0) {
            const share = teamPool / team.length;
            for (const memberWallet of team) {
                await addCommission(teamSnap.val()[memberWallet].profile.userId, share, 'Team Upgrade Commission', 'downline');
            }
        }
    }
}

async function distributeAirdropPoints(userWallet, levelId) {
    const levels = (await db.ref('config/levels').once('value')).val();
    const levelConfig = Array.isArray(levels) ? levels.find(l => l.id === levelId) : null;
    if (!levelConfig || !(levelConfig.airdropPoints > 0)) return;
    const points = levelConfig.airdropPoints;
    const userRef = db.ref(`users/${userWallet}`);
    await userRef.child('airdropPoints').transaction(p => (p || 0) + points);
    await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + points);
    const userData = (await userRef.once('value')).val();
    if (userData?.inviterId) {
        const inviterWallet = (await db.ref(`userIdMap/${userData.inviterId}`).once('value')).val();
        if (inviterWallet) {
            await db.ref(`users/${inviterWallet}/airdropPoints`).transaction(p => (p || 0) + points);
            await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + points);
        }
    }
}

// --- API ROUTES (API Endpoints) ---

app.get('/', (req, res) => {
    res.status(200).json({ 
        success: true, 
        message: "ZTR Backend is running successfully. Please use the frontend application to interact." 
    });
});

app.post('/api/register', async (req, res) => {
    const { wallet, txHash, inviterId, username, profilePic, registrationCost } = req.body;
    if (!wallet || !txHash || !inviterId || !username || !registrationCost) {
        return res.status(400).json({ success: false, error: "Missing fields." });
    }
    try {
        if (!await verifyTransaction(txHash, wallet, ADMIN_WALLET, registrationCost)) {
            return res.status(400).json({ success: false, error: "Transaction verification failed." });
        }
        const walletLower = wallet.toLowerCase();
        if ((await db.ref(`users/${walletLower}`).once('value')).exists()) {
            return res.status(400).json({ success: false, error: "Wallet already registered." });
        }
        const userId = ((await db.ref('nextUserId').transaction(id => (id || 1000) + 1)).snapshot.val());
        const inviteCode = await generateInviteCode();
        
        await db.ref(`users/${walletLower}`).set({
            profile: { name: sanitizeInput(username), userId, joinDate: new Date().toLocaleDateString('en-GB'), profilePicUrl: profilePic || null },
            inviteCode, inviterId: parseInt(inviterId, 10), paid: true,
            ztrBalance: 0, airdropPoints: 100, level: 0, teamSize: 0,
            levelStars: {}, claimedTasks: {}
        });
        await db.ref(`userIdMap/${userId}`).set(walletLower);
        await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower);
        const inviterWallet = (await db.ref(`userIdMap/${parseInt(inviterId, 10)}`).once('value')).val();
        if (inviterWallet) {
            await db.ref(`users/${inviterWallet}/teamSize`).transaction(s => (s || 0) + 1);
            await db.ref(`users/${inviterWallet}/airdropPoints`).transaction(p => (p || 0) + 100);
            await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + 100);
        }
        await distributeRegistrationCommissions(parseInt(inviterId, 10), userId);
        await db.ref('platformStats/totalParticipants').transaction(p => (p || 0) + 1);
        res.status(201).json({ success: true, message: "Registration successful." });
    } catch (error) {
        console.error("Registration Error:", error);
        res.status(500).json({ success: false, error: "Internal server error." });
    }
});

app.post('/api/upgrade', async (req, res) => {
    const { wallet, txHash, levelId, upgradeCost, levelPrice } = req.body;
    if (!wallet || !txHash || !levelId || upgradeCost === undefined || levelPrice === undefined) {
        return res.status(400).json({ success: false, error: "Missing fields." });
    }
    try {
        if (!await verifyTransaction(txHash, wallet, ADMIN_WALLET, upgradeCost)) {
            return res.status(400).json({ success: false, error: "Payment verification failed." });
        }
        const userLevelRef = db.ref(`users/${wallet.toLowerCase()}/level`);
        if (((await userLevelRef.once('value')).val() || 0) !== levelId - 1) {
            return res.status(400).json({ success: false, error: "Invalid level progression." });
        }
        const levelConfig = (await db.ref('config/levels').once('value')).val()?.find(l => l.id === levelId);
        if (levelConfig?.salaryFund > 0) {
            await db.ref('platformStats/totalWeeklySalaryFund').transaction(p => (p || 0) + levelConfig.salaryFund);
        }
        await userLevelRef.set(levelId);
        await distributeAirdropPoints(wallet.toLowerCase(), levelId);
        await distributeUpgradeCommissions(wallet.toLowerCase(), levelId, levelPrice);
        res.json({ success: true, message: "Level upgrade successful." });
    } catch (error) {
        console.error("Upgrade Error:", error);
        res.status(500).json({ success: false, error: "Internal server error." });
    }
});

app.post('/api/withdraw', async (req, res) => {
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ success: false, error: "Wallet address required." });
    try {
        const userRef = db.ref(`users/${wallet.toLowerCase()}`);
        const userData = (await userRef.once('value')).val();
        if (!userData || !userData.ztrBalance || userData.ztrBalance <= 0) {
            return res.status(400).json({ success: false, error: "No balance to withdraw." });
        }
        await db.ref('withdrawals').push({ userWallet: wallet.toLowerCase(), amount: userData.ztrBalance, status: 'pending', date: new Date().toISOString() });
        await userRef.child('ztrBalance').set(0);
        res.json({ success: true, message: "Withdrawal request submitted." });
    } catch (error) {
        console.error("Withdrawal Error:", error);
        res.status(500).json({ success: false, error: "Internal server error." });
    }
});

app.get('/api/platform-data', async (req, res) => {
    try {
        const stats = (await db.ref('platformStats').once('value')).val() || {};
        const usersSnap = await db.ref('users').once('value');
        let leaderboard = [];
        if (usersSnap.exists()) {
            usersSnap.forEach(snap => {
                const u = snap.val();
                if (u.profile) {
                    leaderboard.push({ name: u.profile.name, userId: u.profile.userId, profilePicUrl: u.profile.profilePicUrl || '', earnings: u.ztrBalance || 0 });
                }
            });
            // CHANGE: Leaderboard bug fix. .slice() returns a new array, so we must re-assign it.
            leaderboard = leaderboard.sort((a, b) => b.earnings - a.earnings).slice(0, 200);
        }
        res.json({ success: true, stats, leaderboard });
    } catch (error) {
        console.error("Platform data fetch failed:", error);
        res.status(500).json({ success: false, error: "Internal server error." });
    }
});

app.post('/api/claim-task-reward', async (req, res) => {
    const { wallet, taskRequired, taskPoints } = req.body;
    if (!wallet || !taskRequired || !taskPoints) {
        return res.status(400).json({ success: false, error: "Missing fields." });
    }
    try {
        const userRef = db.ref(`users/${wallet.toLowerCase()}`);
        const userData = (await userRef.once('value')).val();
        if (!userData) return res.status(404).json({ success: false, error: "User not found." });
        if ((userData.teamSize || 0) < taskRequired) {
            return res.status(400).json({ success: false, error: "Task requirements not met." });
        }
        const taskKey = `task_${taskRequired}`;
        if (userData.claimedTasks && userData.claimedTasks[taskKey]) {
            return res.status(400).json({ success: false, error: "Reward already claimed." });
        }
        await userRef.child(`claimedTasks/${taskKey}`).set(true);
        await userRef.child('airdropPoints').transaction(p => (p || 0) + taskPoints);
        await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + taskPoints);
        res.json({ success: true, message: `Claimed ${taskPoints} points.` });
    } catch (error) {
        console.error("Task claim failed:", error);
        res.status(500).json({ success: false, error: "Internal server error." });
    }
});

app.post('/api/admin/distribute-salary', async (req, res) => {
    if (req.body.secret !== process.env.ADMIN_SECRET_KEY) {
        return res.status(403).json({ success: false, error: "Unauthorized." });
    }
    try {
        const salaryPool = (await db.ref('platformStats/totalWeeklySalaryFund').once('value')).val() || 0;
        if (salaryPool <= 0) {
            return res.json({ success: true, message: "Salary pool is empty." });
        }
        const allUsersData = (await db.ref('users').once('value')).val();
        if (!allUsersData) {
            await db.ref('platformStats/totalWeeklySalaryFund').set(0);
            return res.json({ success: true, message: "No users found." });
        }
        const eligibleUsers = [];
        const userDirectsMap = {};
        for (const wallet in allUsersData) {
            const user = allUsersData[wallet];
            if (user.profile && user.inviterId) {
                if (!userDirectsMap[user.inviterId]) userDirectsMap[user.inviterId] = [];
                userDirectsMap[user.inviterId].push(user);
            }
            if (user.profile && (user.level || 0) >= 5) {
                eligibleUsers.push({ wallet, ...user });
            }
        }
        if (eligibleUsers.length === 0) {
            await db.ref('platformStats/totalWeeklySalaryFund').set(0);
            return res.json({ success: true, message: "No members eligible for salary." });
        }
        let totalPerformanceScore = 0;
        const usersWithScores = eligibleUsers.map(user => {
            let score = user.level || 0;
            const directs = userDirectsMap[user.profile.userId] || [];
            directs.forEach(member => { score += (member.level || 0); });
            totalPerformanceScore += score;
            return { wallet: user.wallet, performanceScore: score };
        });
        if (totalPerformanceScore > 0) {
            for (const user of usersWithScores) {
                const share = (user.performanceScore / totalPerformanceScore) * salaryPool;
                if (share > 0) {
                    const userRef = db.ref(`users/${user.wallet}`);
                    await userRef.child('ztrBalance').transaction(b => (b || 0) + share);
                    await userRef.child('salaryHistory').push({ amount: share, date: new Date().toISOString() });
                }
            }
        }
        await db.ref('platformStats/totalWeeklySalaryFund').set(0);
        res.json({ success: true, message: `Distributed ${salaryPool} ZTR among ${eligibleUsers.length} users.` });
    } catch (error) {
        console.error("Salary distribution failed:", error);
        res.status(500).json({ success: false, error: "Internal server error." });
    }
});


// --- Server Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
