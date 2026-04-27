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
        // We convert the expected amount to the smallest unit (wei for ETH, or similar for tokens)
        const expectedAmountWei = ethers.parseUnits(expectedAmount, decimals);

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
                            value >= expectedAmountWei // Check if sent amount is AT LEAST what was expected
                        ) {
                            transactionValid = true;
                            break;
                        }
                    }
                } catch(e) {
                    // Ignore logs that cannot be parsed by this ABI
                }
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

async function distributeCommissions(newUserWallet, inviterId) {
    console.log(`Starting commission distribution for new user: ${newUserWallet} invited by ID: ${inviterId}`);
    // Commission logic to be implemented here
}

// --- API ENDPOINTS ---

app.post('/api/register', async (req, res) => {
    // Read the dynamic registration cost from the request body sent by the frontend
    const { wallet, txHash, inviterId, username, profilePic, registrationCost } = req.body;
    
    if (!wallet || !txHash || !inviterId || !username || !registrationCost) {
        return res.status(400).json({ success: false, error: "Missing required fields." });
    }

    // --- MAIN FIX IS HERE ---
    // Verify the transaction using the registrationCost provided by the frontend
    const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, registrationCost); 
    if (!isValid) {
        return res.status(400).json({ success: false, error: "Transaction verification failed. Please ensure the correct amount was sent." });
    }

    const walletLower = wallet.toLowerCase();
    const userRef = db.ref(`users/${walletLower}`);
    
    const snapshot = await userRef.once('value');
    if (snapshot.exists()) {
        return res.status(400).json({ success: false, error: "User is already registered." });
    }

    try {
        const nextIdRef = db.ref('nextUserId');
        const idResult = await nextIdRef.transaction(currentId => (currentId || 1000) + 1);
        if (!idResult.committed) {
             throw new Error("Could not generate new user ID.");
        }
        const userId = idResult.snapshot.val();
        
        const inviteCode = await generateInviteCode();

        const newUser = {
            profile: {
                name: username,
                userId: userId,
                joinDate: new Date().toLocaleDateString(),
                profilePicUrl: profilePic || null,
                avatar: 'fa-user-astronaut'
            },
            inviteCode: inviteCode,
            inviterId: parseInt(inviterId),
            paid: true,
            ztrBalance: 0,
            level: 0,
            teamSize: 0
        };

        await userRef.set(newUser);
        await db.ref(`userIdMap/${userId}`).set(walletLower);
        await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower);

        await distributeCommissions(walletLower, parseInt(inviterId));
        
        res.status(201).json({ success: true, profile: newUser.profile });

    } catch (error) {
        console.error("Registration failed:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred." });
    }
});


app.post('/api/upgrade', async (req, res) => {
    // Frontend must send the calculated upgradeCost
    const { wallet, txHash, levelId, upgradeCost } = req.body;
    const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, upgradeCost);
    if (!isValid) {
        return res.status(400).json({ success: false, error: "Payment verification for upgrade failed" });
    }
    await db.ref(`users/${wallet.toLowerCase()}/level`).set(levelId);
    res.json({ success: true });
});

app.post('/api/withdraw', async (req, res) => {
    const { wallet } = req.body;
    const userRef = db.ref(`users/${wallet.toLowerCase()}`);
    const snap = await userRef.once('value');
    const userData = snap.val();
    if (!userData || userData.ztrBalance <= 0) {
        return res.status(400).json({ success: false, error: "No balance to withdraw or user not found." });
    }
    const withdrawalRequest = { 
        userWallet: wallet.toLowerCase(), 
        amount: userData.ztrBalance, 
        status: 'pending', 
        date: new Date().toISOString() 
    };
    await db.ref('withdrawals').push(withdrawalRequest);
    await userRef.child('ztrBalance').set(0);
    res.json({ success: true });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
