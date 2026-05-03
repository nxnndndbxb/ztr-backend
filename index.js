const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- Firebase Admin Setup ---
// IMPORTANT: Make sure you have FIREBASE_SERVICE_ACCOUNT_BASE64 and FIREBASE_DB_URL in your .env file
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
const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";
const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/");

const usdtAbi = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function decimals() view returns (uint8)"
];
const usdtContract = new ethers.Contract(USDT_CONTRACT, usdtAbi, provider);

// --- Helper Functions ---

/**
 * Verifies a USDT transaction on the BSC network.
 * @param {string} txHash - The transaction hash.
 * @param {string} fromWallet - The expected sender's wallet address.
 * @param {string} toWallet - The expected recipient's wallet address.
 * @param {string|number} expectedAmount - The minimum expected amount as a string or number.
 * @returns {Promise<boolean>} - True if the transaction is valid, false otherwise.
 */
async function verifyTransaction(txHash, fromWallet, toWallet, expectedAmount) {
    try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) {
            console.log(`Verification failed for ${txHash}: Invalid receipt or transaction failed.`);
            return false;
        }
        const decimals = await usdtContract.decimals();
        const expectedAmountWei = ethers.parseUnits(parseFloat(expectedAmount).toFixed(Number(decimals)), decimals);
        const tolerance = ethers.parseUnits("0.01", decimals); // Tolerance of 0.01 USDT

        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === USDT_CONTRACT.toLowerCase()) {
                try {
                    const parsedLog = usdtContract.interface.parseLog(log);
                    if (parsedLog && parsedLog.name === "Transfer") {
                        const { from, to, value } = parsedLog.args;
                        if (
                            from.toLowerCase() === fromWallet.toLowerCase() &&
                            to.toLowerCase() === toWallet.toLowerCase() &&
                            value >= (expectedAmountWei - tolerance) // Check if received value is within tolerance
                        ) {
                            console.log(`Transaction ${txHash} verified successfully.`);
                            return true;
                        }
                    }
                } catch (e) {
                    // Ignore errors if a log isn't a Transfer event
                }
            }
        }
        console.log(`Verification failed for ${txHash}: No matching Transfer event found.`);
        return false;
    } catch (e) {
        console.error(`Error verifying transaction ${txHash}:`, e);
        return false;
    }
}

/**
 * Generates a unique 8-character invite code.
 * @returns {Promise<string>} A unique invite code.
 */
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

/**
 * Adds a "star" to a user's level matrix in the database.
 * This is a visual representation of income from different sources for each level.
 * @param {string} recipientWallet - The wallet address of the user receiving the star.
 * @param {number} levelId - The ID of the level matrix to add the star to.
 * @param {'direct' | 'upline' | 'downline'} starType - The type of star indicating the income source.
 * @param {number} sourceUserId - The User ID of the person who generated this income/star.
 */
async function addStarToLevel(recipientWallet, levelId, starType, sourceUserId) {
    if (!recipientWallet || !levelId || !starType || !sourceUserId) {
        console.error("addStarToLevel: Missing required parameters.");
        return;
    }
    try {
        const starRef = db.ref(`users/${recipientWallet.toLowerCase()}/levelStars/level_${levelId}`);
        await starRef.push({
            type: starType,
            sourceUserId: sourceUserId
        });
        console.log(`Added a '${starType}' star to level ${levelId} for wallet ${recipientWallet} from user ${sourceUserId}`);
    } catch (error) {
        console.error(`Failed to add star for wallet ${recipientWallet}:`, error);
    }
}

/**
 * Distributes commissions and STARS for a new user registration.
 * @param {number} inviterId - The User ID of the inviter.
 * @param {number} newUserId - The User ID of the new user who joined.
 */
async function distributeRegistrationCommissions(inviterId, newUserId) {
    const configSnapshot = await db.ref('config').once('value');
    const config = configSnapshot.val();
    if (!config || !config.levels || !config.levels[0] || typeof config.levels[0].price !== 'number') {
        console.error("FATAL: Level 1 price is not configured. Commissions cannot be distributed.");
        return;
    }
    const commissionableAmountInZTR = config.levels[0].price;

    console.log(`Distributing registration commission. Amount: ${commissionableAmountInZTR} ZTR`);

    const addCommission = async (userId, amount, type, starType) => {
        if (!userId || isNaN(userId) || amount <= 0) return;
        const walletSnapshot = await db.ref(`userIdMap/${userId}`).once('value');
        if (!walletSnapshot.exists()) return;
        const wallet = walletSnapshot.val();
        const userRef = db.ref(`users/${wallet}`);
        
        await userRef.child('ztrBalance').transaction(b => (b || 0) + amount);
        await userRef.child('incomeHistory').push({ amount, type, date: new Date().toISOString() });
        await addStarToLevel(wallet, 1, starType, newUserId); // Registration always affects Level 1
        console.log(`Credited ${amount.toFixed(4)} ZTR to User ID ${userId} (${type})`);
    };

    // 1. Direct Commission to Inviter (55%)
    await addCommission(inviterId, commissionableAmountInZTR * 0.55, 'Direct Commission', 'direct');

    // 2. Upline Commission (7%)
    const inviterWallet = (await db.ref(`userIdMap/${inviterId}`).once('value')).val();
    if (inviterWallet) {
        const inviterData = (await db.ref(`users/${inviterWallet}`).once('value')).val();
        if (inviterData && inviterData.inviterId) {
            await addCommission(inviterData.inviterId, commissionableAmountInZTR * 0.07, 'Upline Commission', 'upline');
        }
    }

    // 3. Team Commission (20%)
    const teamCommissionPool = commissionableAmountInZTR * 0.20;
    const teamMembersSnapshot = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
    if (teamMembersSnapshot.exists()) {
        const team = Object.keys(teamMembersSnapshot.val()).filter(wallet => 
            teamMembersSnapshot.val()[wallet].profile?.userId !== newUserId
        );
        if (team.length > 0) {
            const sharePerMember = teamCommissionPool / team.length;
            for (const memberWallet of team) {
                const memberUserId = (await db.ref(`users/${memberWallet}/profile/userId`).once('value')).val();
                if (memberUserId) {
                    await addCommission(memberUserId, sharePerMember, 'Team Commission', 'downline');
                }
            }
        }
    }
}

/**
 * Distributes commissions and STARS for a level upgrade.
 * @param {string} upgradingUserWallet - Wallet of the user who is upgrading.
 * @param {number} levelId - The new level ID.
 * @param {number} levelPrice - The base price of the level for commission calculation.
 */
async function distributeUpgradeCommissions(upgradingUserWallet, levelId, levelPrice) {
    const upgradingUserData = (await db.ref(`users/${upgradingUserWallet.toLowerCase()}`).once('value')).val();
    if (!upgradingUserData || !upgradingUserData.inviterId || !upgradingUserData.profile) return;
    
    const { userId: upgradingUserId, inviterId } = upgradingUserData.profile;
    const commissionableAmountInZTR = levelPrice;

    console.log(`Distributing upgrade commission for level ${levelId}. Amount: ${commissionableAmountInZTR} ZTR`);

    const addCommission = async (targetUserId, amount, type, starType) => {
        if (!targetUserId || isNaN(targetUserId) || amount <= 0) return;
        const wallet = (await db.ref(`userIdMap/${targetUserId}`).once('value')).val();
        if (!wallet) return;
        
        const userRef = db.ref(`users/${wallet}`);
        await userRef.child('ztrBalance').transaction(b => (b || 0) + amount);
        await userRef.child('incomeHistory').push({ amount, type, date: new Date().toISOString() });
        await addStarToLevel(wallet, levelId, starType, upgradingUserId);
        console.log(`Credited ${amount.toFixed(4)} ZTR to User ID ${targetUserId} (${type}) for level ${levelId} upgrade.`);
    };

    // 1. Direct Commission (55%)
    await addCommission(inviterId, commissionableAmountInZTR * 0.55, 'Direct Upgrade Commission', 'direct');

    // 2. Upline Commission (7%)
    const inviterWallet = (await db.ref(`userIdMap/${inviterId}`).once('value')).val();
    if (inviterWallet) {
        const inviterData = (await db.ref(`users/${inviterWallet}`).once('value')).val();
        if (inviterData && inviterData.inviterId) {
            await addCommission(inviterData.inviterId, commissionableAmountInZTR * 0.07, 'Upline Upgrade Commission', 'upline');
        }
    }
    
    // 3. Team Commission (20%)
    const teamCommissionPool = commissionableAmountInZTR * 0.20;
    const teamMembersSnapshot = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
    if (teamMembersSnapshot.exists()) {
        const team = Object.keys(teamMembersSnapshot.val()).filter(wallet => wallet.toLowerCase() !== upgradingUserWallet.toLowerCase());
        if (team.length > 0) {
            const share = teamCommissionPool / team.length;
            for (const memberWallet of team) {
                const memberUserId = (await db.ref(`users/${memberWallet}/profile/userId`).once('value')).val();
                if (memberUserId) {
                    await addCommission(memberUserId, share, 'Team Upgrade Commission', 'downline');
                }
            }
        }
    }
}

/**
 * Distributes airdrop points to the user and their inviter upon a level upgrade.
 * @param {string} userWallet - Wallet of the user who upgraded.
 * @param {number} levelId - The new level ID.
 */
async function distributeAirdropPoints(userWallet, levelId) {
    const levels = (await db.ref('config/levels').once('value')).val();
    const levelConfig = Array.isArray(levels) ? levels.find(l => l.id === levelId) : null;
    if (!levelConfig || !levelConfig.airdropPoints > 0) return;
    
    const points = levelConfig.airdropPoints;
    const userRef = db.ref(`users/${userWallet}`);
    
    await userRef.child('airdropPoints').transaction(p => (p || 0) + points);
    await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + points);
    console.log(`Awarded ${points} airdrop points to ${userWallet}`);

    const userData = (await userRef.once('value')).val();
    if (userData && userData.inviterId) {
        const inviterWallet = (await db.ref(`userIdMap/${userData.inviterId}`).once('value')).val();
        if (inviterWallet) {
            await db.ref(`users/${inviterWallet}/airdropPoints`).transaction(p => (p || 0) + points);
            await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + points);
            console.log(`Awarded ${points} airdrop points to inviter ${inviterWallet}`);
        }
    }
}


// --- API ENDPOINTS ---

app.post('/api/register', async (req, res) => {
    const { wallet, txHash, inviterId, username, profilePic, registrationCost } = req.body;
    
    if (!wallet || !txHash || !inviterId || !username || !registrationCost) {
        return res.status(400).json({ success: false, error: "Missing required fields." });
    }

    try {
        if (!await verifyTransaction(txHash, wallet, ADMIN_WALLET, registrationCost)) {
            return res.status(400).json({ success: false, error: "Transaction verification failed." });
        }

        const walletLower = wallet.toLowerCase();
        const userRef = db.ref(`users/${walletLower}`);
        
        const snapshot = await userRef.once('value');
        if (snapshot.exists() && snapshot.val().profile) {
            return res.status(400).json({ success: false, error: "User is already registered." });
        }
        
        const idResult = await db.ref('nextUserId').transaction(id => (id || 1000) + 1);
        if (!idResult.committed) throw new Error("Could not generate new user ID.");
        const userId = idResult.snapshot.val();
        
        const inviteCode = await generateInviteCode();
        const parsedInviterId = parseInt(inviterId, 10);

        await userRef.set({
            profile: { name: username, userId, joinDate: new Date().toLocaleDateString('en-GB'), profilePicUrl: profilePic || null },
            inviteCode, inviterId: parsedInviterId, paid: true,
            ztrBalance: 0, airdropPoints: 100, level: 0, teamSize: 0,
            levelStars: {}, claimedTasks: {}
        });

        await db.ref(`userIdMap/${userId}`).set(walletLower);
        await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower);

        const inviterWallet = (await db.ref(`userIdMap/${parsedInviterId}`).once('value')).val();
        if (inviterWallet) {
            await db.ref(`users/${inviterWallet}/teamSize`).transaction(s => (s || 0) + 1);
            // Award airdrop points to inviter for successful referral
            await db.ref(`users/${inviterWallet}/airdropPoints`).transaction(p => (p || 0) + 100);
            await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + 100);
        }

        await distributeRegistrationCommissions(parsedInviterId, userId);
        await db.ref('platformStats/totalParticipants').transaction(p => (p || 0) + 1);
        
        res.status(201).json({ success: true, message: "Registration successful." });
    } catch (error) {
        console.error("Registration failed:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred." });
    }
});

app.post('/api/upgrade', async (req, res) => {
    const { wallet, txHash, levelId, upgradeCost, levelPrice } = req.body;
    if (!wallet || !txHash || !levelId || !upgradeCost || levelPrice === undefined) {
        return res.status(400).json({ success: false, error: "Missing required fields." });
    }

    try {
        if (!await verifyTransaction(txHash, wallet, ADMIN_WALLET, upgradeCost)) {
            return res.status(400).json({ success: false, error: "Payment verification failed." });
        }

        const walletLower = wallet.toLowerCase();
        const userLevelRef = db.ref(`users/${walletLower}/level`);
        const currentLevel = (await userLevelRef.once('value')).val() || 0;
        if (currentLevel !== levelId - 1) {
             return res.status(400).json({ success: false, error: "Invalid level progression." });
        }
        
        const levels = (await db.ref('config/levels').once('value')).val();
        const levelConfig = Array.isArray(levels) ? levels.find(l => l.id === levelId) : null;
        if (levelConfig && levelConfig.salaryFund > 0) {
            await db.ref('platformStats/totalWeeklySalaryFund').transaction(p => (p || 0) + levelConfig.salaryFund);
        }

        await userLevelRef.set(levelId);
        await distributeAirdropPoints(walletLower, levelId);
        await distributeUpgradeCommissions(walletLower, levelId, levelPrice);

        res.json({ success: true, message: "Upgrade successful." });
    } catch (error) {
        console.error("Upgrade failed:", error);
        res.status(500).json({ success: false, error: "An internal server error." });
    }
});

app.post('/api/withdraw', async (req, res) => {
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ success: false, error: "Wallet is required." });

    try {
        const userRef = db.ref(`users/${wallet.toLowerCase()}`);
        const snap = await userRef.once('value');
        const userData = snap.val();
        
        if (!userData || !userData.ztrBalance || userData.ztrBalance <= 0) {
            return res.status(400).json({ success: false, error: "No balance to withdraw." });
        }
        
        await db.ref('withdrawals').push({ 
            userWallet: wallet.toLowerCase(), amount: userData.ztrBalance, 
            status: 'pending', date: new Date().toISOString() 
        });
        await userRef.child('ztrBalance').set(0);
        
        res.json({ success: true, message: "Withdrawal request submitted." });
    } catch (error) {
        console.error("Withdrawal failed:", error);
        res.status(500).json({ success: false, error: "An internal server error." });
    }
});

app.get('/api/platform-data', async (req, res) => {
    try {
        const stats = (await db.ref('platformStats').once('value')).val() || {};
        
        const usersSnap = await db.ref('users').orderByChild('ztrBalance').limitToLast(200).once('value');
        let leaderboard = [];
        if (usersSnap.exists()) {
            usersSnap.forEach(snap => {
                const u = snap.val();
                if(u.profile) {
                    leaderboard.push({
                        name: u.profile.name,
                        userId: u.profile.userId,
                        profilePicUrl: u.profile.profilePicUrl || '',
                        earnings: u.ztrBalance || 0
                    });
                }
            });
            leaderboard.sort((a, b) => b.earnings - a.earnings);
        }
        
        res.json({ success: true, stats, leaderboard });
    } catch (error) {
        console.error("Fetching platform data failed:", error);
        res.status(500).json({ success: false, error: "An internal server error." });
    }
});

app.post('/api/claim-task-reward', async (req, res) => {
    const { wallet, taskRequired, taskPoints } = req.body;
    if (!wallet || !taskRequired || !taskPoints) {
        return res.status(400).json({ success: false, error: "Missing required fields." });
    }

    try {
        const walletLower = wallet.toLowerCase();
        const userRef = db.ref(`users/${walletLower}`);
        const userSnap = await userRef.once('value');
        const userData = userSnap.val();

        if (!userData) return res.status(404).json({ success: false, error: "User not found." });
        if (userData.teamSize < taskRequired) {
            return res.status(400).json({ success: false, error: "Task requirements not met." });
        }
        
        const taskKey = `task_${taskRequired}`;
        if (userData.claimedTasks && userData.claimedTasks[taskKey]) {
            return res.status(400).json({ success: false, error: "Task already claimed." });
        }

        await userRef.child(`claimedTasks/${taskKey}`).set(true);
        await userRef.child('airdropPoints').transaction(p => (p || 0) + taskPoints);
        await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + taskPoints);

        res.json({ success: true, message: `Successfully claimed ${taskPoints} points.` });
    } catch (error) {
        console.error("Task claim failed:", error);
        res.status(500).json({ success: false, error: "An internal server error." });
    }
});


// --- ADMIN ENDPOINTS (PROTECT THESE) ---

app.post('/api/admin/distribute-salary', async (req, res) => {
    if (req.body.secret !== process.env.ADMIN_SECRET_KEY) {
        return res.status(403).json({ success: false, error: "Unauthorized." });
    }

    try {
        const salaryPool = (await db.ref('platformStats/totalWeeklySalaryFund').once('value')).val() || 0;
        if (salaryPool <= 0) {
            return res.json({ success: true, message: "Salary pool is empty. Nothing to distribute." });
        }

        const usersSnapshot = await db.ref('users').orderByChild('level').startAt(5).once('value');
        if (!usersSnapshot.exists()) {
            await db.ref('platformStats/totalWeeklySalaryFund').set(0);
            return res.json({ success: true, message: "No members eligible for salary." });
        }
        
        const eligibleUsers = [];
        let totalPerformanceScore = 0;
        
        // This is a heavy operation, consider optimizing for large scale
        for (const wallet in usersSnapshot.val()) {
            const user = usersSnapshot.val()[wallet];
            let performanceScore = user.level || 0;
            const teamSnap = await db.ref('users').orderByChild('inviterId').equalTo(user.profile.userId).once('value');
            if (teamSnap.exists()) {
                teamSnap.forEach(m => { performanceScore += (m.val().level || 0) });
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
        console.log("Weekly salary distribution complete.");
        res.json({ success: true, message: `Distributed ${salaryPool} ZTR among ${eligibleUsers.length} users.` });
    } catch (error) {
        console.error("Salary distribution failed:", error);
        res.status(500).json({ success: false, error: "An internal server error." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
