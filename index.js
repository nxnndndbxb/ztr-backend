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
    console.log("Firebase Admin Initialized Successfully.");
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

// --- Helper Functions (No changes here, keeping them as they were) ---
function sanitizeInput(input) {
    if (!input) return '';
    return input.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
async function verifyTransaction(txHash, fromWallet, toWallet, expectedAmount) {
    try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) return false;
        const decimals = await usdtContract.decimals();
        const expectedAmountWei = ethers.parseUnits(parseFloat(expectedAmount).toFixed(Number(decimals)), decimals);
        const tolerance = ethers.parseUnits("0.01", decimals);
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === USDT_CONTRACT.toLowerCase()) {
                try {
                    const parsedLog = usdtContract.interface.parseLog(log);
                    if (parsedLog && parsedLog.name === "Transfer") {
                        const { from, to, value } = parsedLog.args;
                        if (from.toLowerCase() === fromWallet.toLowerCase() && to.toLowerCase() === toWallet.toLowerCase() && value >= (expectedAmountWei - tolerance)) {
                            return true;
                        }
                    }
                } catch (e) {}
            }
        }
        return false;
    } catch (e) {
        console.error(`Error verifying tx ${txHash}:`, e);
        return false;
    }
}
// ... [Other helper functions like generateInviteCode, addStarToLevel, etc. remain the same] ...
// All other helper functions that I provided in the previous step are correct and don't need changes.

// --- API ENDPOINTS ---
// All your /api/register, /api/upgrade, etc. routes remain here...
// No changes needed in the API endpoints themselves from the previous corrected code.
// Copy all those API endpoints here.

// ***************************************************************
// ******************* NEW CODE TO FIX 404 ERROR *******************
// ***************************************************************

// Add a simple root route to confirm the server is running and avoid 404 in logs.
// Yeh naya route hai jo `GET /` ke 404 error ko khatam kar dega.
app.get('/', (req, res) => {
    res.status(200).json({ 
        success: true, 
        message: "ZTR Backend is running successfully. Please use the frontend application to interact." 
    });
});

// All your existing API routes like app.post('/api/register', ...), etc. should be ABOVE this new code.


// --- SERVER START ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
