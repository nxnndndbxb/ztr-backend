const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- Firebase Admin Setup ---
try {
    const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!serviceAccountBase64) {
        throw new Error("FATAL ERROR: FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable is not set.");
    }
    const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('ascii'));

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DB_URL
    });
} catch (error) {
    console.error("Firebase Admin Initialization Failed:", error.message);
    process.exit(1);
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

// --- Helper Functions ---

async function verifyTransaction(txHash, fromWallet, toWallet, expectedAmount) {
    try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) {
            console.log(`Verification failed for ${txHash}: Invalid receipt or transaction failed on-chain.`);
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
                } catch (e) {
                    // Ignore logs that are not Transfer events
                }
            }
        }
        console.log(`Verification failed for ${txHash}: No matching USDT Transfer event found.`);
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
    if (!recipientWallet || !levelId || !starType || !sourceUserId) {
        console.error("addStarToLevel Error: Missing required parameters.");
        return;
    }
    try {
        const starRef = db.ref(`users/${recipientWallet.toLowerCase()}/levelStars/level_${levelId}`);
        await starRef.push({
            type: starType,
            sourceUserId: sourceUserId,
            timestamp: admin.database.ServerValue.TIMESTAMP
        });
        console.log(`Added a '${starType}' star to level ${levelId} for wallet ${recipientWallet} from user ${sourceUserId}`);
    } catch (error) {
        console.error(`Failed to add star for wallet ${recipientWallet}:`, error);
    }
}

async function distributeRegistrationCommissions(inviterId, newUserId) {
    const configSnapshot = await db.ref('config').once('value');
    const config = configSnapshot.val();
    if (!config || !config.levels || !config.levels[0] || typeof config.levels[0].price !== 'number') {
        console.error("FATAL: Level 1 price is not configured. Commissions cannot be distributed.");
        return;
    }
    const commissionableAmountInZTR = config.levels[0].price;
    console.log(`Distributing registration commission. Base Amount: ${commissionableAmountInZTR} ZTR`);

    const addCommission = async (userId, amount, type, starType) => {
        if (!userId || isNaN(userId) || amount <= 0) return;
        const walletSnapshot = await db.ref(`userIdMap/${userId}`).once('value');
        if (!walletSnapshot.exists()) return;
        const wallet = walletSnapshot.val();
        const userRef = db.ref(`users/${wallet}`);
        
        await userRef.child('ztrBalance').transaction(balance => (balance || 0) + amount);
        await userRef.child('incomeHistory').push({ amount, type, date: new Date().toISOString() });
        await addStarToLevel(wallet, 1, starType, newUserId);
        console.log(`Credited ${amount.toFixed(4)} ZTR to User ID ${userId} (${type})`);
    };

    await addCommission(inviterId, commissionableAmountInZTR * 0.55, 'Direct Commission', 'direct');

    const inviterWallet = (await db.ref(`userIdMap/${inviterId}`).once('value')).val();
    if (inviterWallet) {
        const inviterData = (await db.ref(`users/${inviterWallet}`).once('value')).val();
        if (inviterData && inviterData.inviterId) {
            await addCommission(inviterData.inviterId, commissionableAmountInZTR * 0.07, 'Upline Commission', 'upline');
        }
    }

    const teamCommissionPool = commissionableAmountInZTR * 0.20;
    const teamMembersSnapshot = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
    if (teamMembersSnapshot.exists()) {
        const team = [];
        teamMembersSnapshot.forEach(childSnapshot => {
            if (childSnapshot.val().profile.userId !== newUserId) {
                team.push(childSnapshot.key);
            }
        });

        if (team.length > 0) {
            const sharePerMember = teamCommissionPool / team.length;
            for (const memberWallet of team) {
                const memberUserId = teamMembersSnapshot.val()[memberWallet].profile.userId;
                if (memberUserId) {
                    await addCommission(memberUserId, sharePerMember, 'Team Commission', 'downline');
                }
            }
        }
    }
}

async function distributeUpgradeCommissions(upgradingUserWallet, levelId, levelPrice) {
    const upgradingUserDataSnapshot = await db.ref(`users/${upgradingUserWallet.toLowerCase()}`).once('value');
    const upgradingUserData = upgradingUserDataSnapshot.val();
    if (!upgradingUserData || !upgradingUserData.inviterId || !upgradingUserData.profile) return;
    
    const upgradingUserId = upgradingUserData.profile.userId;
    const inviterId = upgradingUserData.inviterId;
    const commissionableAmountInZTR = levelPrice;
    console.log(`Distributing upgrade commission for level ${levelId}. Base Amount: ${commissionableAmountInZTR} ZTR`);

    const addCommission = async (targetUserId, amount, type, starType) => {
        if (!targetUserId || isNaN(targetUserId) || amount <= 0) return;
        const wallet = (await db.ref(`userIdMap/${targetUserId}`).once('value')).val();
        if (!wallet) return;
        
        const userRef = db.ref(`users/${wallet}`);
        await userRef.child('ztrBalance').transaction(balance => (balance || 0) + amount);
        await userRef.child('incomeHistory').push({ amount, type, date: new Date().toISOString() });
        await addStarToLevel(wallet, levelId, starType, upgradingUserId);
        console.log(`Credited ${amount.toFixed(4)} ZTR to User ID ${targetUserId} (${type}) for level ${levelId} upgrade.`);
    };

    await addCommission(inviterId, commissionableAmountInZTR * 0.55, 'Direct Upgrade Commission', 'direct');

    const inviterWallet = (await db.ref(`userIdMap/${inviterId}`).once('value')).val();
    if (inviterWallet) {
        const inviterData = (await db.ref(`users/${inviterWallet}`).once('value')).val();
        if (inviterData && inviterData.inviterId) {
            await addCommission(inviterData.inviterId, commissionableAmountInZTR * 0.07, 'Upline Upgrade Commission', 'upline');
        }
    }
    
    const teamCommissionPool = commissionableAmountInZTR * 0.20;
    const teamMembersSnapshot = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
    if (teamMembersSnapshot.exists()) {
         const team = [];
        teamMembersSnapshot.forEach(childSnapshot => {
            if (childSnapshot.key.toLowerCase() !== upgradingUserWallet.toLowerCase()) {
                team.push(childSnapshot.key);
            }
        });

        if (team.length > 0) {
            const share = teamCommissionPool / team.length;
            for (const memberWallet of team) {
                const memberUserId = teamMembersSnapshot.val()[memberWallet].profile.userId;
                if (memberUserId) {
                    await addCommission(memberUserId, share, 'Team Upgrade Commission', 'downline');
                }
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
    console.log(`Awarded ${points} airdrop points to ${userWallet} for reaching level ${levelId}`);

    const userData = (await userRef.once('value')).val();
    if (userData && userData.inviterId) {
        const inviterWallet = (await db.ref(`userIdMap/${userData.inviterId}`).once('value')).val();
        if (inviterWallet) {
            await db.ref(`users/${inviterWallet}/airdropPoints`).transaction(p => (p || 0) + points);
            await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + points);
            console.log(`Awarded ${points} airdrop points to inviter ${inviterWallet} for downline upgrade.`);
        }
    }
}

// --- API ENDPOINTS ---

app.post('/api/register', async (req, res) => {
    const { wallet, txHash, inviterId, username, profilePic, registrationCost } = req.body;
    if (!wallet || !txHash || !inviterId || !username || !registrationCost) {
        return res.status(400).json({ success: false, error: "Missing required registration fields." });
    }

    try {
        if (!await verifyTransaction(txHash, wallet, ADMIN_WALLET, registrationCost)) {
            return res.status(400).json({ success: false, error: "Transaction could not be verified." });
        }
        const walletLower = wallet.toLowerCase();
        const userRef = db.ref(`users/${walletLower}`);
        const snapshot = await userRef.once('value');
        if (snapshot.exists() && snapshot.val().profile) {
            return res.status(400).json({ success: false, error: "This wallet is already registered." });
        }
        const idResult = await db.ref('nextUserId').transaction(id => (id || 1000) + 1);
        if (!idResult.committed) throw new Error("Could not generate a unique user ID.");
        const userId = idResult.snapshot.val();
        const inviteCode = await generateInviteCode();
        const parsedInviterId = parseInt(inviterId, 10);

        await userRef.set({
            profile: { name: username, userId, joinDate: new Date().toLocaleDateString('en-GB'), profilePicUrl: profilePic || null },
            inviteCode, inviterId: parsedInviterId, paid: true,
            ztrBalance: 0, airdropPoints: 100,
            level: 0, teamSize: 0,
            levelStars: {}, claimedTasks: {}
        });

        await db.ref(`userIdMap/${userId}`).set(walletLower);
        await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower);
        const inviterWallet = (await db.ref(`userIdMap/${parsedInviterId}`).once('value')).val();
        if (inviterWallet) {
            await db.ref(`users/${inviterWallet}/teamSize`).transaction(s => (s || 0) + 1);
            await db.ref(`users/${inviterWallet}/airdropPoints`).transaction(p => (p || 0) + 100);
            await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + 100);
        }
        await distributeRegistrationCommissions(parsedInviterId, userId);
        await db.ref('platformStats/totalParticipants').transaction(p => (p || 0) + 1);
        res.status(201).json({ success: true, message: "Registration successful." });
    } catch (error) {
        console.error("Registration Error:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred during registration." });
    }
});

app.post('/api/upgrade', async (req, res) => {
    const { wallet, txHash, levelId, upgradeCost, levelPrice } = req.body;
    if (!wallet || !txHash || !levelId || !upgradeCost || levelPrice === undefined) {
        return res.status(400).json({ success: false, error: "Missing required fields for upgrade." });
    }

    try {
        if (!await verifyTransaction(txHash, wallet, ADMIN_WALLET, upgradeCost)) {
            return res.status(400).json({ success: false, error: "Upgrade payment verification failed." });
        }
        const walletLower = wallet.toLowerCase();
        const userLevelRef = db.ref(`users/${walletLower}/level`);
        const currentLevel = (await userLevelRef.once('value')).val() || 0;
        
        if (currentLevel !== levelId - 1) {
             return res.status(400).json({ success: false, error: "Invalid level progression. Please upgrade sequentially." });
        }
        const levels = (await db.ref('config/levels').once('value')).val();
        const levelConfig = Array.isArray(levels) ? levels.find(l => l.id === levelId) : null;
        if (levelConfig && levelConfig.salaryFund > 0) {
            await db.ref('platformStats/totalWeeklySalaryFund').transaction(p => (p || 0) + levelConfig.salaryFund);
        }
        await userLevelRef.set(levelId);
        await distributeAirdropPoints(walletLower, levelId);
        await distributeUpgradeCommissions(walletLower, levelId, levelPrice);
        res.json({ success: true, message: "Level upgrade successful." });
    } catch (error) {
        console.error("Upgrade Error:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred during upgrade." });
    }
});

app.post('/api/withdraw', async (req, res) => {
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ success: false, error: "Wallet address is required." });

    try {
        const userRef = db.ref(`users/${wallet.toLowerCase()}`);
        const snap = await userRef.once('value');
        const userData = snap.val();
        if (!userData || !userData.ztrBalance || userData.ztrBalance <= 0) {
            return res.status(400).json({ success: false, error: "You have no balance to withdraw." });
        }
        await db.ref('withdrawals').push({ 
            userWallet: wallet.toLowerCase(), 
            amount: userData.ztrBalance, 
            status: 'pending', 
            date: new Date().toISOString() 
        });
        await userRef.child('ztrBalance').set(0);
        res.json({ success: true, message: "Withdrawal request submitted for approval." });
    } catch (error) {
        console.error("Withdrawal Error:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred." });
    }
});

app.get('/api/platform-data', async (req, res) => {
    try {
        const usersRef = db.ref('users');
        const allUsersSnapshot = await usersRef.once('value');
        const totalParticipants = allUsersSnapshot.exists() ? allUsersSnapshot.numChildren() : 0;
        
        const statsSnapshot = await db.ref('platformStats').once('value');
        const otherStats = statsSnapshot.val() || {};
        const finalStats = {
            totalParticipants: totalParticipants,
            totalWeeklySalaryFund: otherStats.totalWeeklySalaryFund || 0,
            totalAirdropDistributed: otherStats.totalAirdropDistributed || 0,
            salaryActiveMembers: otherStats.salaryActiveMembers || 0,
            totalZTRDistributed: otherStats.totalZTRDistributed || 0
        };
        
        let leaderboard = [];
        if (allUsersSnapshot.exists()) {
            allUsersSnapshot.forEach(snap => {
                const u = snap.val();
                if(u.profile && typeof u.ztrBalance === 'number') {
                    leaderboard.push({
                        name: u.profile.name,
                        userId: u.profile.userId,
                        profilePicUrl: u.profile.profilePicUrl || '',
                        earnings: u.ztrBalance || 0
                    });
                }
            });
            leaderboard.sort((a, b) => b.earnings - a.earnings);
            leaderboard = leaderboard.slice(0, 200);
        }
        res.json({ success: true, stats: finalStats, leaderboard });
    } catch (error) {
        console.error("Fetching platform data failed:", error);
        res.status(500).json({ success: false, error: "An internal server error." });
    }
});

app.post('/api/claim-task-reward', async (req, res) => {
    const { wallet, taskRequired, taskPoints } = req.body;
    if (!wallet || !taskRequired || !taskPoints) {
        return res.status(400).json({ success: false, error: "Missing required fields for task claim." });
    }

    try {
        const walletLower = wallet.toLowerCase();
        const userRef = db.ref(`users/${walletLower}`);
        const userSnap = await userRef.once('value');
        const userData = userSnap.val();
        if (!userData) return res.status(404).json({ success: false, error: "User not found." });
        if ((userData.teamSize || 0) < taskRequired) {
            return res.status(400).json({ success: false, error: "Task requirements not met." });
        }
        const taskKey = `task_${taskRequired}`;
        if (userData.claimedTasks && userData.claimedTasks[taskKey]) {
            return res.status(400).json({ success: false, error: "Task reward has already been claimed." });
        }
        await userRef.child(`claimedTasks/${taskKey}`).set(true);
        await userRef.child('airdropPoints').transaction(p => (p || 0) + taskPoints);
        await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + taskPoints);
        res.json({ success: true, message: `Successfully claimed ${taskPoints} airdrop points.` });
    } catch (error) {
        console.error("Task claim failed:", error);
        res.status(500).json({ success: false, error: "An internal server error." });
    }
});

app.post('/api/admin/distribute-salary', async (req, res) => {
    if (req.body.secret !== process.env.ADMIN_SECRET_KEY) {
        return res.status(403).json({ success: false, error: "Unauthorized access." });
    }

    try {
        const salaryPool = (await db.ref('platformStats/totalWeeklySalaryFund').once('value')).val() || 0;
        if (salaryPool <= 0) {
            return res.json({ success: true, message: "Salary pool is empty. No salaries distributed." });
        }
        const usersSnapshot = await db.ref('users').orderByChild('level').startAt(5).once('value');
        if (!usersSnapshot.exists()) {
            await db.ref('platformStats/totalWeeklySalaryFund').set(0);
            return res.json({ success: true, message: "No members are eligible for salary this week." });
        }
        const eligibleUsers = [];
        let totalPerformanceScore = 0;
        
        for (const wallet in usersSnapshot.val()) {
            const user = usersSnapshot.val()[wallet];
            let performanceScore = user.level || 0;
            const teamSnap = await db.ref('users').orderByChild('inviterId').equalTo(user.profile.userId).once('value');
            if (teamSnap.exists()) {
                teamSnap.forEach(member => { performanceScore += (member.val().level || 0); });
            }
            totalPerformanceScore += performanceScore;
            eligibleUsers.push({ wallet, performanceScore });
        }

        if (totalPerformanceScore > 0) {
            for (const user of eligibleUsers) {
                const share = (user.performanceScore / totalPerformanceScore) * salaryPool;
                if (share > 0) {
                    const userRef = db.ref(`users/${user.wallet}`);
                    await userRef.child('ztrBalance').transaction(b => (b || 0) + share);
                    await userRef.child('salaryHistory').push({ amount: share, date: new Date().toISOString() });
                }
            }
        }
        await db.ref('platformStats/totalWeeklySalaryFund').set(0);
        console.log("Weekly salary distribution has been completed successfully.");
        res.json({ success: true, message: `Distributed ${salaryPool} ZTR among ${eligibleUsers.length} users.` });
    } catch (error) {
        console.error("Salary distribution process failed:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred during salary distribution." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

// Yeh line Vercel ko batati hai ke Express app ko kaise istemal karna hai
module.exports = app;
