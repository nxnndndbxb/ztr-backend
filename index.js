const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- FIX 1: Correct Firebase Admin Setup for Vercel ---
// Service account key is decoded from a Base64 environment variable
const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!serviceAccountBase64) {
    console.error("FATAL ERROR: FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable is not set.");
    process.exit(1); // Stop the server if the key is missing
}
const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('ascii'));

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();
const ADMIN_WALLET = "0x97efeaa1da1108acff52840550ec51dc5bbfd812";
const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";
const JOINING_FEE_USDT = "5.25"; // Joining fee as a string

const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/");

// --- FIX 2: Secure Transaction Verification Function ---
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
        const expectedAmountWei = ethers.parseUnits(expectedAmount, decimals);

        // Filter through logs to find the Transfer event
        const transferEvent = usdtContract.interface.getEvent("Transfer");
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
                            value === expectedAmountWei
                        ) {
                            transactionValid = true;
                            break; // Found the correct transfer, no need to check further
                        }
                    }
                } catch(e) {
                    // Ignore logs that can't be parsed by the USDT ABI
                }
            }
        }
        
        return transactionValid;

    } catch (e) {
        console.error(`Error verifying transaction ${txHash}:`, e);
        return false;
    }
}


// --- FIX 3: Invite Code Generation Function ---
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


// --- FIX 4: Missing Commission Distribution Logic ---
async function distributeCommissions(newUserWallet, inviterId) {
    console.log(`Starting commission distribution for new user: ${newUserWallet} invited by ID: ${inviterId}`);
    // Yeh function aapko implement karna hai
    // 1. Inviter ka wallet address `inviterId` se find karein.
    // 2. 40% commission inviter ko dein.
    // 3. Upline (inviter ke inviter) ko 10% dein.
    // 4. Inviter ke baaki direct members mein 20% distribute karein.
    // NOTE: Sabhi balance updates `ztrBalance` field mein hongay.
}


// --- API ENDPOINTS ---

// 1. User Registration (After Payment)
app.post('/api/register', async (req, res) => {
    const { wallet, txHash, inviterId, username, profilePic } = req.body;
    
    if (!wallet || !txHash || !inviterId || !username) {
        return res.status(400).json({ success: false, error: "Missing required fields." });
    }

    // Security Check: Verify Transaction Hash securely
    const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, JOINING_FEE_USDT); 
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
        // Generate User ID
        const nextIdRef = db.ref('nextUserId');
        const idResult = await nextIdRef.transaction(currentId => (currentId || 1000) + 1);
        if (!idResult.committed) {
             throw new Error("Could not generate new user ID.");
        }
        const userId = idResult.snapshot.val();
        
        // Generate Invite Code
        const inviteCode = await generateInviteCode();

        const newUser = {
            profile: {
                name: username,
                userId: userId,
                joinDate: new Date().toLocaleDateString(),
                profilePicUrl: profilePic || null,
                avatar: 'fa-user-astronaut' // Default avatar
            },
            inviteCode: inviteCode, // Invite code added
            inviterId: parseInt(inviterId),
            paid: true,
            ztrBalance: 0,
            level: 0,
            teamSize: 0
        };

        await userRef.set(newUser);
        await db.ref(`userIdMap/${userId}`).set(walletLower);
        await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower); // Store invite code for easy lookup

        // Call commission distribution function
        await distributeCommissions(walletLower, parseInt(inviterId));
        
        res.status(201).json({ success: true, profile: newUser.profile });

    } catch (error) {
        console.error("Registration failed:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred." });
    }
});


// Other endpoints (upgrade, withdraw) remain mostly the same but should also use the new `verifyTransaction` if they involve payments.
// ... (Your other endpoints for upgrade and withdraw)

// Example for /api/upgrade
app.post('/api/upgrade', async (req, res) => {
    const { wallet, txHash, levelId, upgradeCost } = req.body; // Frontend should send the cost
    
    // Securely verify the upgrade payment
    const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, upgradeCost);
    if (!isValid) {
        return res.status(400).json({ success: false, error: "Payment verification failed" });
    }

    await db.ref(`users/${wallet.toLowerCase()}/level`).set(levelId);
    // Return percentage logic would go here...
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
    await userRef.child('ztrBalance').set(0); // Balance reset to 0 after request

    res.json({ success: true });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));