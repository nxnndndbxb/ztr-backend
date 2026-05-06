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
const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";
const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/");
const usdtAbi = [ "event Transfer(address indexed from, address indexed to, uint256 value)", "function decimals() view returns (uint8)" ];
const usdtContract = new ethers.Contract(USDT_CONTRACT, usdtAbi, provider);

// --- All other functions (register, upgrade, platform-data, etc.) remain the same ---
// (Yahan aapke baaqi functions aayenge, unhein change karne ki zaroorat nahi)

// Example of platform-data endpoint
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
                    leaderboard.push({ name: u.profile.name, userId: u.profile.userId, profilePicUrl: u.profile.profilePicUrl || '', earnings: u.ztrBalance || 0 });
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


// Add all your other app.post, app.get endpoints here...
// (Yahan aapke register, upgrade, withdraw waghera ke tamam endpoints aayenge)


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

// ================================================================
// ============ YEH LINE VERCEL KE LIYE SAB SE ZAROORI HAI =========
// ================================================================
module.exports = app;
