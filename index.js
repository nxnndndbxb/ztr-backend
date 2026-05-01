const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Firebase Admin Setup from Base64
const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!serviceAccountBase64) {
    console.error("FATAL ERROR: FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable is not set.");
    process.exit(1);
}
const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('ascii'));

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();
const ADMIN_WALLET = "0x97efeaa1da1108acff52840550ec51dc5bbfd812";
const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";

const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/");

const usdtAbi = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function decimals() view returns (uint8)"
];
const usdtContract = new ethers.Contract(USDT_CONTRACT, usdtAbi, provider);

async function verifyTransaction(txHash, fromWallet, toWallet, expectedAmount) {
    try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) {
            console.log(`Verification failed for ${txHash}: Invalid receipt or transaction failed.`);
            return false;
        }
        const decimals = await usdtContract.decimals();
        const expectedAmountWei = ethers.parseUnits(expectedAmount.toString(), decimals);
        let transactionValid = false;
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === USDT_CONTRACT.toLowerCase()) {
                try {
                    const parsedLog = usdtContract.interface.parseLog(log);
                    if (parsedLog && parsedLog.name === "Transfer") {
                        const { from, to, value } = parsedLog.args;
                        if (
                            from.toLowerCase() === fromWallet.toLowerCase() &&
                            to.toLowerCase() === toWallet.toLowerCase() &&
                            value >= expectedAmountWei
                        ) {
                            transactionValid = true;
                            break;
                        }
                    }
                } catch(e) {}
            }
        }
        return transactionValid;
    } catch (e) {
        console.error(`Error verifying transaction ${txHash}:`, e);
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

// Recursively update team size for all upliners
async function updateUplineTeamSize(inviterId) {
    if (!inviterId || inviterId === 0) return;
    try {
        const inviterWalletRef = db.ref(`userIdMap/${inviterId}`);
        const inviterWalletSnap = await inviterWalletRef.once('value');
        if (inviterWalletSnap.exists()) {
            const inviterWallet = inviterWalletSnap.val();
            const inviterRef = db.ref(`users/${inviterWallet}`);
            await inviterRef.child('teamSize').transaction(currentSize => (currentSize || 0) + 1);

            const grandparentRef = inviterRef.child('inviterId');
            const grandparentSnap = await grandparentRef.once('value');
            if (grandparentSnap.exists()) {
                await updateUplineTeamSize(grandparentSnap.val());
            }
        }
    } catch (error) {
        console.error(`Error updating team size for inviter ${inviterId}:`, error);
    }
}


async function distributeCommissions(newUserWallet, inviterId) {
    console.log(`Starting commission distribution for new user: ${newUserWallet} invited by ID: ${inviterId}`);
    // Commission logic yahan implement hogi
}

// --- API ENDPOINTS ---

app.post('/api/register', async (req, res) => {
    const { wallet, txHash, inviterId, username, profilePic, registrationCost } = req.body;
    
    if (!wallet || !txHash || !inviterId || !username || !registrationCost) {
        return res.status(400).json({ success: false, error: "Missing required fields." });
    }

    const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, registrationCost); 
    if (!isValid) {
        return res.status(400).json({ success: false, error: "Transaction verification failed. Please ensure the correct amount was sent." });
    }

    const walletLower = wallet.toLowerCase();
    const userRef = db.ref(`users/${walletLower}`);
    
    try {
        const snapshot = await userRef.once('value');
        if (snapshot.exists() && snapshot.val().profile) {
            return res.status(400).json({ success: false, error: "User is already registered." });
        }
        
        const nextIdRef = db.ref('nextUserId');
        const idResult = await nextIdRef.transaction(currentId => (currentId || 1000) + 1);
        if (!idResult.committed) {
             throw new Error("Could not generate new user ID.");
        }
        const userId = idResult.snapshot.val();
        
        const inviteCode = await generateInviteCode();

        const fullUserRecord = {
            profile: {
                name: username,
                userId: userId,
                joinDate: new Date().toISOString(), // Use ISO string for consistency
                profilePicUrl: profilePic || null,
                avatar: 'fa-user-astronaut'
            },
            inviteCode: inviteCode,
            inviterId: parseInt(inviterId),
            paid: true,
            ztrBalance: 0,
            airdropPoints: 100, // Initial points for joining
            level: 0,
            teamSize: 0
        };

        await userRef.set(fullUserRecord); 
        await db.ref(`userIdMap/${userId}`).set(walletLower);
        await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower);

        // Distribute commissions and update team sizes
        await distributeCommissions(walletLower, parseInt(inviterId));
        await updateUplineTeamSize(parseInt(inviterId));
        
        res.status(201).json({ success: true, profile: fullUserRecord.profile });

    } catch (error) {
        console.error("Registration failed:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred." });
    }
});


app.post('/api/upgrade', async (req, res) => {
    const { wallet, txHash, levelId, upgradeCost } = req.body;
    const walletLower = wallet.toLowerCase();

    // 1. Verify Transaction
    const isValid = await verifyTransaction(txHash, walletLower, ADMIN_WALLET, upgradeCost);
    if (!isValid) {
        return res.status(400).json({ success: false, error: "Payment verification for upgrade failed" });
    }

    try {
        const userRef = db.ref(`users/${walletLower}`);
        const userSnapshot = await userRef.once('value');
        if (!userSnapshot.exists()) {
            return res.status(404).json({ success: false, error: "User not found" });
        }
        const userData = userSnapshot.val();

        // 2. Fetch Level Configuration from Firebase
        const levelsConfigSnap = await db.ref('config/levels').once('value');
        const levelsConfig = levelsConfigSnap.val();
        const levelToUpgrade = levelsConfig ? levelsConfig.find(l => l.id === levelId) : null;

        if (!levelToUpgrade) {
            return res.status(400).json({ success: false, error: "Invalid level configuration." });
        }
        
        // 3. Update User's Level
        await userRef.child('level').set(levelId);

        // 4. Add Salary Fund to Global Pool
        if (levelToUpgrade.salaryFund && levelToUpgrade.salaryFund > 0) {
            await db.ref('salaryPool/currentWeek').transaction(currentPool => (currentPool || 0) + levelToUpgrade.salaryFund);
        }

        // 5. Award Airdrop Points to User and Upliner
        if (levelToUpgrade.airdropPoints && levelToUpgrade.airdropPoints > 0) {
            // Award points to the user
            await userRef.child('airdropPoints').transaction(points => (points || 0) + levelToUpgrade.airdropPoints);

            // Award points to the upliner
            const inviterId = userData.inviterId;
            if (inviterId) {
                const inviterWallet = (await db.ref(`userIdMap/${inviterId}`).once('value')).val();
                if (inviterWallet) {
                    await db.ref(`users/${inviterWallet}/airdropPoints`).transaction(points => (points || 0) + levelToUpgrade.airdropPoints);
                }
            }
        }
        
        res.json({ success: true, message: "Upgrade successful and rewards distributed." });

    } catch (error) {
        console.error(`Upgrade failed for wallet ${walletLower}:`, error);
        res.status(500).json({ success: false, error: "An internal server error occurred during upgrade." });
    }
});


app.post('/api/withdraw', async (req, res) => {
    const { wallet } = req.body;
    const userRef = db.ref(`users/${wallet.toLowerCase()}`);
    const snap = await userRef.once('value');
    const userData = snap.val();
    if (!userData || userData.ztrBalance <= 0) {
        return res.status(400).json({ success: false, error: "No balance to withdraw or user not found." });
    }
    const withdrawalRequest = { userWallet: wallet.toLowerCase(), amount: userData.ztrBalance, status: 'pending', date: new Date().toISOString() };
    await db.ref('withdrawals').push(withdrawalRequest);
    await userRef.child('ztrBalance').set(0);
    res.json({ success: true });
});

/**
 * ==========================================================================================
 * DYNAMIC WEEKLY SALARY DISTRIBUTION
 * ==========================================================================================
 * This function should be triggered once a week by a secure cron job or scheduled task.
 * It calculates and distributes salary based on performance.
 * ==========================================================================================
 */
async function distributeWeeklySalary() {
    console.log("Starting weekly salary distribution...");

    const SALARY_ELIGIBILITY_LEVEL = 5; // e.g., Level 5 (Master) and above
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // 1. Get the total salary pool for the week
    const salaryPoolRef = db.ref('salaryPool/currentWeek');
    const salaryPoolSnap = await salaryPoolRef.once('value');
    const totalSalaryFund = salaryPoolSnap.val() || 0;

    if (totalSalaryFund <= 0) {
        console.log("Salary fund is zero. No salaries to distribute.");
        await salaryPoolRef.set(0); // Reset for next week
        return;
    }
    
    const distributableFund = totalSalaryFund * 0.90; // 90% is distributed
    const reservedFund = totalSalaryFund * 0.10; // 10% is reserved

    // 2. Find all eligible users and calculate their performance
    const usersSnap = await db.ref('users').orderByChild('level').startAt(SALARY_ELIGIBILITY_LEVEL).once('value');
    if (!usersSnap.exists()) {
        console.log("No users are eligible for salary.");
        // Roll over the entire fund to the next week
        await db.ref('salaryPool/nextWeekFund').transaction(fund => (fund || 0) + totalSalaryFund);
        await salaryPoolRef.set(0);
        return;
    }

    const eligibleUsers = [];
    let totalPerformanceScore = 0;

    for (const wallet in usersSnap.val()) {
        const user = usersSnap.val()[wallet];
        if (!user.profile) continue;

        let performanceScore = 0;
        let directTeamCount = 0;
        let indirectTeamCount = 0;

        // Fetch direct referrals
        const directRefsSnap = await db.ref('users').orderByChild('inviterId').equalTo(user.profile.userId).once('value');
        
        if (directRefsSnap.exists()) {
            for (const directRefWallet in directRefsSnap.val()) {
                const directRef = directRefsSnap.val()[directRefWallet];
                // Check if they joined in the last week
                if (directRef.profile.joinDate > oneWeekAgo) {
                    directTeamCount++;
                }
                // Check their team growth (indirect)
                const indirectTeamSize = directRef.teamSize || 0;
                // A more advanced check would be to see which of those team members are new.
                // For simplicity, we can use a proxy. A better way is to log new join events.
                indirectTeamCount += indirectTeamSize; 
            }
        }
        
        // Performance Metric: (New Directs * 2) + Total Indirect Team Size
        performanceScore = (directTeamCount * 2) + indirectTeamCount;
        
        if (performanceScore > 0) {
            eligibleUsers.push({
                wallet: wallet,
                score: performanceScore
            });
            totalPerformanceScore += performanceScore;
        }
    }

    if (totalPerformanceScore === 0) {
        console.log("No performance recorded this week. Rolling over funds.");
        await db.ref('salaryPool/nextWeekFund').transaction(fund => (fund || 0) + totalSalaryFund);
        await salaryPoolRef.set(0);
        return;
    }

    // 3. Distribute the salary
    console.log(`Distributing ${distributableFund} ZTR among ${eligibleUsers.length} users based on a total score of ${totalPerformanceScore}.`);

    const distributionPromises = eligibleUsers.map(user => {
        const userShare = user.score / totalPerformanceScore;
        const salaryAmount = distributableFund * userShare;

        if (salaryAmount > 0) {
            const userRef = db.ref(`users/${user.wallet}`);
            // Add to ZTR balance
            userRef.child('ztrBalance').transaction(balance => (balance || 0) + salaryAmount);
            // Record in salary history
            const historyRecord = {
                amount: salaryAmount,
                date: new Date().toISOString(),
                score: user.score,
                totalScore: totalPerformanceScore
            };
            return userRef.child('salaryHistory').push(historyRecord);
        }
        return Promise.resolve();
    });

    await Promise.all(distributionPromises);

    // 4. Reset the pool for the next week
    const nextWeekFund = (await db.ref('salaryPool/nextWeekFund').once('value')).val() || 0;
    await salaryPoolRef.set(nextWeekFund + reservedFund); // Start next week with leftover + 10% reserve
    await db.ref('salaryPool/nextWeekFund').set(0);

    console.log("Weekly salary distribution finished successfully.");
}

// Example of how to trigger the salary distribution (for testing)
// In production, this should be a secure, authenticated endpoint called by a cron job.
app.post('/api/admin/trigger-salary', async (req, res) => {
    // Add authentication here in a real app (e.g., check for an admin API key)
    // const { apiKey } = req.body;
    // if (apiKey !== process.env.ADMIN_API_KEY) {
    //     return res.status(403).json({ success: false, error: "Unauthorized" });
    // }
    try {
        await distributeWeeklySalary();
        res.json({ success: true, message: "Salary distribution triggered successfully." });
    } catch (error) {
        console.error("Manual Salary Trigger Failed:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred." });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
