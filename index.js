const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- Firebase Admin Setup ---
// IMPORTANT: Ensure FIREBASE_SERVICE_ACCOUNT_BASE64 and FIREBASE_DB_URL are in your Vercel environment variables.
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
    console.log("Firebase Admin Initialized Successfully.");
} catch (error) {
    console.error("Firebase Admin Initialization Failed:", error.message);
    process.exit(1); // Exit process if Firebase fails to initialize
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

/**
 * Sanitizes user input to prevent XSS attacks.
 * @param {string} input - The string to sanitize.
 * @returns {string} - The sanitized string.
 */
function sanitizeInput(input) {
    if (!input) return '';
    return input.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}


/**
 * Verifies a USDT transaction on the Binance Smart Chain.
 * @param {string} txHash - The transaction hash to verify.
 * @param {string} fromWallet - The expected sender's wallet address.
 * @param {string} toWallet - The expected recipient's wallet address (Admin).
 * @param {string|number} expectedAmount - The minimum expected amount in USDT.
 * @returns {Promise<boolean>} - True if the transaction is valid, false otherwise.
 */
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
                    // Ignore logs that are not Transfer events.
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

/**
 * Generates a unique 8-character alphanumeric invite code.
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
 * @param {string} recipientWallet - The wallet address of the user receiving the star.
 * @param {number} levelId - The ID of the level matrix where the star will be added.
 * @param {'direct' | 'upline' | 'downline'} starType - The type of star.
 * @param {number} sourceUserId - The User ID of the person who generated this commission.
 */
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

/**
 * Distributes commissions for a new user registration.
 * @param {number} inviterId - The User ID of the direct inviter.
 * @param {number} newUserId - The User ID of the new user who joined.
 */
async function distributeRegistrationCommissions(inviterId, newUserId) {
    const configSnapshot = await db.ref('config').once('value');
    const config = configSnapshot.val();
    if (!config?.levels?.[0]?.price) {
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

    // 1. Direct Commission to Inviter (55%)
    await addCommission(inviterId, commissionableAmountInZTR * 0.55, 'Direct Commission', 'direct');

    // 2. Upline Commission to Inviter's Inviter (7%)
    const inviterWallet = (await db.ref(`userIdMap/${inviterId}`).once('value')).val();
    if (inviterWallet) {
        const inviterData = (await db.ref(`users/${inviterWallet}`).once('value')).val();
        if (inviterData && inviterData.inviterId) {
            await addCommission(inviterData.inviterId, commissionableAmountInZTR * 0.07, 'Upline Commission', 'upline');
        }
    }

    // 3. Team Commission Split among Inviter's other direct members (20%)
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
                const memberUserId = teamMembersSnapshot.val()[memberWallet]?.profile?.userId;
                if (memberUserId) {
                    await addCommission(memberUserId, sharePerMember, 'Team Commission', 'downline');
                }
            }
        }
    }
}

/**
 * Distributes commissions for a level upgrade.
 * @param {string} upgradingUserWallet - Wallet of the user who is upgrading.
 * @param {number} levelId - The new level ID being upgraded to.
 * @param {number} levelPrice - The base price of the level for commission calculation.
 */
async function distributeUpgradeCommissions(upgradingUserWallet, levelId, levelPrice) {
    const upgradingUserData = (await db.ref(`users/${upgradingUserWallet.toLowerCase()}`).once('value')).val();
    if (!upgradingUserData?.inviterId || !upgradingUserData?.profile) return;
    
    const { userId: upgradingUserId, inviterId } = upgradingUserData.profile;
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
        const team = [];
        teamMembersSnapshot.forEach(childSnapshot => {
            if (childSnapshot.key.toLowerCase() !== upgradingUserWallet.toLowerCase()) {
                team.push(childSnapshot.key);
            }
        });

        if (team.length > 0) {
            const share = teamCommissionPool / team.length;
            for (const memberWallet of team) {
                const memberUserId = teamMembersSnapshot.val()[memberWallet]?.profile?.userId;
                if (memberUserId) {
                    await addCommission(memberUserId, share, 'Team Upgrade Commission', 'downline');
                }
            }
        }
    }
}

/**
 * Distributes airdrop points for a level upgrade.
 * @param {string} userWallet - Wallet of the user who upgraded.
 * @param {number} levelId - The new level ID.
 */
async function distributeAirdropPoints(userWallet, levelId) {
    const levels = (await db.ref('config/levels').once('value')).val();
    const levelConfig = Array.isArray(levels) ? levels.find(l => l.id === levelId) : null;
    if (!levelConfig || !(levelConfig.airdropPoints > 0)) return;
    
    const points = levelConfig.airdropPoints;
    const userRef = db.ref(`users/${userWallet}`);
    
    await userRef.child('airdropPoints').transaction(p => (p || 0) + points);
    await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + points);
    console.log(`Awarded ${points} airdrop points to ${userWallet} for level ${levelId}`);

    const userData = (await userRef.once('value')).val();
    if (userData && userData.inviterId) {
        const inviterWallet = (await db.ref(`userIdMap/${userData.inviterId}`).once('value')).val();
        if (inviterWallet) {
            await db.ref(`users/${inviterWallet}/airdropPoints`).transaction(p => (p || 0) + points);
            await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + points);
            console.log(`Awarded ${points} points to inviter ${inviterWallet} for downline upgrade.`);
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
        const sanitizedUsername = sanitizeInput(username);

        await userRef.set({
            profile: { name: sanitizedUsername, userId, joinDate: new Date().toLocaleDateString('en-GB'), profilePicUrl: profilePic || null },
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
        res.status(500).json({ success: false, error: "An internal server error occurred." });
    }
});

app.post('/api/upgrade', async (req, res) => {
    const { wallet, txHash, levelId, upgradeCost, levelPrice } = req.body;
    if (!wallet || !txHash || !levelId || upgradeCost === undefined || levelPrice === undefined) {
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

        res.json({ success: true, message: "Level upgrade successful." });
    } catch (error) {
        console.error("Upgrade Error:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred." });
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
        const stats = (await db.ref('platformStats').once('value')).val() || {};
        const usersSnap = await db.ref('users').once('value');
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
            leaderboard.sort((a, b) => b.earnings - a.earnings).slice(0, 200); // Sort and get top 200
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


// --- ADMIN-ONLY ENDPOINT ---
// IMPORTANT: Yeh function ab pehle se bohat behtar aur tez hai.
app.post('/api/admin/distribute-salary', async (req, res) => {
    if (req.body.secret !== process.env.ADMIN_SECRET_KEY) {
        return res.status(403).json({ success: false, error: "Unauthorized access." });
    }

    try {
        const salaryPool = (await db.ref('platformStats/totalWeeklySalaryFund').once('value')).val() || 0;
        if (salaryPool <= 0) {
            return res.json({ success: true, message: "Salary pool is empty. No salaries distributed." });
        }

        console.log(`Starting salary distribution with a pool of ${salaryPool} ZTR.`);
        
        // Step 1: Fetch all users data in a single call for efficiency.
        const allUsersSnapshot = await db.ref('users').once('value');
        if (!allUsersSnapshot.exists()) {
            await db.ref('platformStats/totalWeeklySalaryFund').set(0);
            return res.json({ success: true, message: "No users found in the database." });
        }
        const allUsersData = allUsersSnapshot.val();

        // Step 2: Process data in-memory to find eligible users and their directs.
        const eligibleUsers = [];
        const userDirectsMap = {}; // Maps a userId to their list of direct members' data

        for (const wallet in allUsersData) {
            const user = allUsersData[wallet];
            if (user.profile && user.inviterId) {
                if (!userDirectsMap[user.inviterId]) {
                    userDirectsMap[user.inviterId] = [];
                }
                userDirectsMap[user.inviterId].push(user);
            }
            // Check eligibility for salary (level 5 or higher)
            if (user.profile && (user.level || 0) >= 5) {
                eligibleUsers.push({ wallet, ...user });
            }
        }
        
        if (eligibleUsers.length === 0) {
            await db.ref('platformStats/totalWeeklySalaryFund').set(0);
            return res.json({ success: true, message: "No members are eligible for salary this week." });
        }

        // Step 3: Calculate performance scores for all eligible users without further DB calls.
        let totalPerformanceScore = 0;
        const usersWithScores = [];

        for (const user of eligibleUsers) {
            let performanceScore = user.level || 0; // Personal score
            const directs = userDirectsMap[user.profile.userId] || [];
            
            for (const member of directs) {
                performanceScore += (member.level || 0);
            }
            
            totalPerformanceScore += performanceScore;
            usersWithScores.push({ wallet: user.wallet, performanceScore });
        }

        // Step 4: Distribute the salary pool based on calculated scores.
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
        
        // Step 5: Reset the weekly salary fund.
        await db.ref('platformStats/totalWeeklySalaryFund').set(0);
        console.log("Weekly salary distribution has been completed successfully.");
        res.json({ success: true, message: `Distributed ${salaryPool} ZTR among ${eligibleUsers.length} users.` });

    } catch (error) {
        console.error("Salary distribution process failed:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
