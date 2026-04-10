const express = require('express');
const { ethers } = require('ethers');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config();

// --- Configuration ---
try {
    const serviceAccount = JSON.parse(
        Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('ascii')
    );
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://fortune-2cb70-default-rtdb.asia-southeast1.firebasedatabase.app"
    });
} catch (error) {
    console.error("Firebase initialization failed. Make sure FIREBASE_SERVICE_ACCOUNT_BASE64 is set correctly.", error);
}

const db = admin.database();
const app = express();
app.use(cors());
app.use(express.json());

const BSC_RPC_URL = process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/';
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
const USDT_CONTRACT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
const USDT_ABI = ["function transfer(address to, uint256 amount) returns (bool)", "function decimals() view returns (uint8)"];

if (!ADMIN_PRIVATE_KEY) {
    throw new Error("ADMIN_PRIVATE_KEY is not set in environment variables.");
}

const provider = new ethers.JsonRpcProvider(BSC_RPC_URL);
const adminWallet = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);
const usdtContract = new ethers.Contract(USDT_CONTRACT_ADDRESS, USDT_ABI, adminWallet);

// --- API Endpoint ---
app.post('/withdraw', async (req, res) => {
    const { userWalletAddress } = req.body;
    if (!userWalletAddress || !ethers.isAddress(userWalletAddress)) {
        return res.status(400).json({ success: false, message: "Invalid wallet address." });
    }

    const userWalletLower = userWalletAddress.toLowerCase();
    const withdrawalRefKey = db.ref('withdrawals').push().key;

    try {
        const userSnapshot = await db.ref(`users/${userWalletLower}`).once('value');
        const userData = userSnapshot.val();

        if (!userData || !userData.ztrBalance || userData.ztrBalance <= 0) {
            return res.status(400).json({ success: false, message: "No balance to withdraw." });
        }
        
        const amountToWithdraw = userData.ztrBalance;
        const usdtDecimals = await usdtContract.decimals();
        const amountInWei = ethers.parseUnits(amountToWithdraw.toFixed(4).toString(), usdtDecimals);

        await db.ref(`users/${userWalletLower}/ztrBalance`).set(0);

        const withdrawalRecord = {
            status: 'processing',
            userWallet: userWalletLower,
            amount: amountToWithdraw,
            requestDate: new Date().toISOString()
        };
        await db.ref(`withdrawals/${withdrawalRefKey}`).set(withdrawalRecord);

        const tx = await usdtContract.transfer(userWalletAddress, amountInWei);
        await db.ref(`withdrawals/${withdrawalRefKey}`).update({ txHash: tx.hash });

        res.json({ success: true, message: "Withdrawal initiated successfully! Transaction is processing.", txHash: tx.hash });

        tx.wait().then(receipt => {
            if (receipt.status === 1) {
                db.ref(`withdrawals/${withdrawalRefKey}`).update({ status: 'approved', confirmedDate: new Date().toISOString() });
            } else {
                db.ref(`withdrawals/${withdrawalRefKey}`).update({ status: 'failed', error: 'Transaction reverted' });
            }
        });

    } catch (error) {
        console.error('Error during withdrawal:', error);
        await db.ref(`withdrawals/${withdrawalRefKey}`).update({ status: 'failed', error: error.message });
        return res.status(500).json({ success: false, message: 'An error occurred during the process.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));