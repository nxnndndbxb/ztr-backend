const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Firebase Admin Setup from Base64
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
    // This will prevent the app from starting if Firebase config is wrong, which is good for debugging.
    process.exit(1); 
}


const db = admin.database();
const ADMIN_WALLET = "0x97efeaa1da1108acff52840550ec51dc5bbfd812";
const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";

const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/");

const usdtAbi = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function decimals() view returns (uint8)"
];
const usdtContract = new ethers.Contract(USDT_CONTRACT, usdtAbi, provider);

/**
 * Verifies a USDT transaction on the BSC network.
 */
async function verifyTransaction(txHash, fromWallet, toWallet, expectedAmount) {
    try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) {
            console.log(`Verification failed for ${txHash}: Invalid receipt or transaction failed.`);
            return false;
        }
        const decimals = await usdtContract.decimals();
        const expectedAmountWei = ethers.parseUnits(expectedAmount.toString(), decimals);
        
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
                            return true;
                        }
                    }
                } catch(e) {
                    // Ignore errors if a log isn't a Transfer event
                }
            }
        }
        return false;
    } catch (e) {
        console.error(`Error verifying transaction ${txHash}:`, e);
        return false;
    }
}

/**
 * Generates a unique 8-character invite code.
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
 * [NEW] Distributes registration commissions to the network.
 */
async function distributeCommissions(inviterId, registrationCost) {
    console.log(`Starting commission distribution for inviter ID: ${inviterId}`);
    
    const configSnapshot = await db.ref('config').once('value');
    const config = configSnapshot.val();
    
    // --- FIX: Added checks to prevent crash if config is missing ---
    if (!config || !Array.isArray(config.levels) || !config.levels[0] || typeof config.levels[0].price !== 'number') {
        console.error("FATAL: Level 1 price is not configured correctly in the database. Commissions cannot be distributed.");
        return;
    }
    const commissionableAmountInZTR = config.levels[0].price;

    console.log(`Commissionable Amount: ${commissionableAmountInZTR} ZTR`);

    const addCommission = async (userId, amount, type) => {
        if (!userId || isNaN(userId) || amount <= 0) return;
        const walletSnapshot = await db.ref(`userIdMap/${userId}`).once('value');
        if (!walletSnapshot.exists()) return;
        
        const wallet = walletSnapshot.val();
        const userRef = db.ref(`users/${wallet}`);
        
        await userRef.child('ztrBalance').transaction(balance => (balance || 0) + amount);
        await userRef.child('incomeHistory').push({
            amount: amount,
            type: type,
            date: new Date().toISOString()
        });
        console.log(`Credited ${amount} ZTR to User ID ${userId} (${type})`);
    };

    const directCommission = commissionableAmountInZTR * 0.55;
    await addCommission(inviterId, directCommission, 'Direct Commission');

    const inviterWalletSnapshot = await db.ref(`userIdMap/${inviterId}`).once('value');
    if (inviterWalletSnapshot.exists()) {
        const inviterWallet = inviterWalletSnapshot.val();
        const inviterData = (await db.ref(`users/${inviterWallet}`).once('value')).val();
        if (inviterData && inviterData.inviterId) {
            const uplineId = inviterData.inviterId;
            const uplineCommission = commissionableAmountInZTR * 0.07;
            await addCommission(uplineId, uplineCommission, 'Upline Commission');
        }
    }

    const teamCommissionPool = commissionableAmountInZTR * 0.20;
    const teamMembersSnapshot = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
    
    if (teamMembersSnapshot.exists()) {
        const team = [];
        teamMembersSnapshot.forEach(child => {
            if (child.val() && child.val().profile) {
                 team.push(child.key);
            }
        });

        if (team.length > 0) {
            const sharePerMember = teamCommissionPool / team.length;
            for (const memberWallet of team) {
                const memberData = (await db.ref(`users/${memberWallet}/profile/userId`).once('value')).val();
                if(memberData) {
                   await addCommission(memberData, sharePerMember, 'Team Commission');
                }
            }
        }
    }
}

/**
 * [NEW] Distributes airdrop points for a level upgrade.
 */
async function distributeAirdropPoints(userWallet, levelId) {
    console.log(`Distributing airdrop points for wallet ${userWallet} upgrading to level ${levelId}`);

    const levels = (await db.ref('config/levels').once('value')).val();
    // --- FIX: Added check to prevent crash if levels config is missing ---
    if (!Array.isArray(levels)) {
        console.log("Airdrop points could not be distributed: 'config/levels' is not an array.");
        return;
    }
    const levelConfig = levels.find(l => l.id === levelId);

    if (!levelConfig || typeof levelConfig.airdropPoints !== 'number' || levelConfig.airdropPoints <= 0) {
        console.log(`No airdrop points configured for level ${levelId}.`);
        return;
    }

    const points = levelConfig.airdropPoints;

    const userRef = db.ref(`users/${userWallet}`);
    await userRef.child('airdropPoints').transaction(currentPoints => (currentPoints || 0) + points);
    console.log(`Awarded ${points} airdrop points to ${userWallet}`);

    const userData = (await userRef.once('value')).val();
    if (userData && userData.inviterId) {
        const inviterWallet = (await db.ref(`userIdMap/${userData.inviterId}`).once('value')).val();
        if (inviterWallet) {
            const inviterRef = db.ref(`users/${inviterWallet}`);
            await inviterRef.child('airdropPoints').transaction(currentPoints => (currentPoints || 0) + points);
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
        const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, registrationCost); 
        if (!isValid) {
            return res.status(400).json({ success: false, error: "Transaction verification failed." });
        }

        const walletLower = wallet.toLowerCase();
        const userRef = db.ref(`users/${walletLower}`);
        
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
        const parsedInviterId = parseInt(inviterId, 10);

        const fullUserRecord = {
            profile: {
                name: username, userId,
                joinDate: new Date().toLocaleDateString('en-GB'),
                profilePicUrl: profilePic || null, avatar: 'fa-user-astronaut'
            },
            inviteCode, inviterId: parsedInviterId, paid: true,
            ztrBalance: 0, airdropPoints: 100, level: 1, teamSize: 0
        };

        await userRef.set(fullUserRecord); 
        await db.ref(`userIdMap/${userId}`).set(walletLower);
        await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower);

        const inviterWallet = (await db.ref(`userIdMap/${parsedInviterId}`).once('value')).val();
        if(inviterWallet) {
            await db.ref(`users/${inviterWallet}/teamSize`).transaction(size => (size || 0) + 1);
        }

        await distributeCommissions(parsedInviterId, parseFloat(registrationCost));
        
        res.status(201).json({ success: true, profile: fullUserRecord.profile });

    } catch (error) {
        console.error("Registration failed:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred." });
    }
});


app.post('/api/upgrade', async (req, res) => {
    const { wallet, txHash, levelId, upgradeCost } = req.body;

    if (!wallet || !txHash || !levelId || !upgradeCost) {
        return res.status(400).json({ success: false, error: "Missing required fields for upgrade." });
    }

    try {
        const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, upgradeCost);
        if (!isValid) {
            return res.status(400).json({ success: false, error: "Payment verification for upgrade failed" });
        }

        const walletLower = wallet.toLowerCase();
        
        const levels = (await db.ref('config/levels').once('value')).val();
        // --- FIX: Added check to prevent crash if levels config is missing ---
        if (Array.isArray(levels)) {
            const levelConfig = levels.find(l => l.id === levelId);
            if (levelConfig && typeof levelConfig.salaryFund === 'number' && levelConfig.salaryFund > 0) {
                await db.ref('currentWeek/salaryPool').transaction(pool => (pool || 0) + levelConfig.salaryFund);
            }
        }

        await db.ref(`users/${walletLower}/level`).set(levelId);
        await distributeAirdropPoints(walletLower, levelId);

        res.json({ success: true, message: "Upgrade successful." });
    } catch (error) {
        console.error("Upgrade process failed:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred during upgrade." });
    }
});


app.post('/api/withdraw', async (req, res) => {
    const { wallet } = req.body;
    try {
        const userRef = db.ref(`users/${wallet.toLowerCase()}`);
        const snap = await userRef.once('value');
        const userData = snap.val();
        
        if (!userData || !userData.ztrBalance || userData.ztrBalance <= 0) {
            return res.status(400).json({ success: false, error: "No balance to withdraw." });
        }
        
        const withdrawalRequest = { 
            userWallet: wallet.toLowerCase(), amount: userData.ztrBalance, 
            status: 'pending', date: new Date().toISOString() 
        };

        await db.ref('withdrawals').push(withdrawalRequest);
        await userRef.child('ztrBalance').set(0);
        
        res.json({ success: true, message: "Withdrawal request submitted." });
    } catch (error) {
        console.error("Withdrawal request failed:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred." });
    }
});


app.post('/api/admin/distribute-salary', async (req, res) => {
    const { secret } = req.body;
    if (secret !== process.env.ADMIN_SECRET_KEY) {
        return res.status(403).json({ success: false, error: "Unauthorized." });
    }

    console.log("--- Starting Weekly Salary Distribution ---");
    try {
        const salaryPoolRef = db.ref('currentWeek/salaryPool');
        const salaryPoolSnap = await salaryPoolRef.once('value');
        const totalSalaryPool = salaryPoolSnap.val() || 0;

        if (totalSalaryPool <= 0) {
            return res.json({ success: true, message: "Salary pool is empty." });
        }

        const distributablePool = totalSalaryPool * 0.90;
        console.log(`Total Pool: ${totalSalaryPool} ZTR, Distributable: ${distributablePool} ZTR`);

        const usersSnapshot = await db.ref('users').orderByChild('level').startAt(5).once('value');
        if (!usersSnapshot.exists()) {
            await salaryPoolRef.set(0); // Clear pool even if no one is eligible
            return res.json({ success: true, message: "No eligible members found." });
        }

        const eligibleUsers = [];
        let totalPerformanceScore = 0;
        const allUsersData = usersSnapshot.val();

        // --- FIX: Using Promise.all for better performance on async tasks ---
        await Promise.all(Object.keys(allUsersData).map(async (wallet) => {
            const user = allUsersData[wallet];
            if (user && user.profile) {
                let performanceScore = user.level || 1; // Base score
                const directTeamSnapshot = await db.ref('users').orderByChild('inviterId').equalTo(user.profile.userId).once('value');
                if (directTeamSnapshot.exists()) {
                    directTeamSnapshot.forEach(memberSnap => {
                        performanceScore += (memberSnap.val().level || 1);
                    });
                }
                
                totalPerformanceScore += performanceScore;
                eligibleUsers.push({ wallet, performanceScore, userId: user.profile.userId });
            }
        }));

        if (totalPerformanceScore <= 0) {
            await salaryPoolRef.set(0);
            return res.json({ success: true, message: "No performance activity found among eligible users." });
        }

        console.log(`Total Performance Score: ${totalPerformanceScore}`);
        
        // --- FIX: Using Promise.all for faster database writes ---
        await Promise.all(eligibleUsers.map(async (user) => {
            const userShare = (user.performanceScore / totalPerformanceScore) * distributablePool;
            if (userShare > 0) {
                const userRef = db.ref(`users/${user.wallet}`);
                await userRef.child('ztrBalance').transaction(balance => (balance || 0) + userShare);
                await userRef.child('salaryHistory').push({
                    amount: userShare,
                    date: new Date().toISOString(),
                    performanceScore: user.performanceScore
                });
                console.log(`Distributed ${userShare.toFixed(4)} ZTR to User ID ${user.userId}`);
            }
        }));
        
        await salaryPoolRef.set(0); // Reset pool
        
        console.log("--- Weekly Salary Distribution Complete ---");
        res.json({ success: true, message: `Successfully distributed salary.` });

    } catch (error) {
        console.error("Salary distribution failed:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred." });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
