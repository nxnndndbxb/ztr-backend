const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();

// --- CORS Configuration (Takay frontend se connect ho sakay) ---
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());
app.use(express.json());

// --- Firebase Admin Ko Set Karna ---
let db;
try {
    const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!serviceAccountBase64) {
        throw new Error("FATAL ERROR: FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable set nahi hai. Vercel settings check karein.");
    }
    const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('ascii'));
    
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DB_URL
    });
    
    db = admin.database();
    console.log("✅ Firebase Admin se Connection Kamyab.");
} catch (error) {
    console.error("🔥 Firebase Admin Connection Nakaam:", error.message);
    process.exit(1);
}

// --- Blockchain aur Contract ki Mehfooz Configuration ---
const ADMIN_WALLET = "0x97efeaa1da1108acff52840550ec51dc5bbfd812";
const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";
const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/");

const usdtAbi = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function decimals() view returns (uint8)",
];
const usdtContract = new ethers.Contract(USDT_CONTRACT, usdtAbi, provider);

// --- Cache (Takay app fast chalay) ---
let levelsCache = null;

async function getLevelsConfig() {
    if (levelsCache) return levelsCache;
    const snapshot = await db.ref('config/levels').once('value');
    let levels = snapshot.val();
    if (!Array.isArray(levels) || levels.length === 0) {
        console.warn("⚠️ Database se Level config nahi mili. Default istemal ho rahi hai.");
        levels = [
            { id: 0, name: "Starter", price: 5, salaryFund: 0.25, fee: 0, airdropPoints: 100 },
            { id: 1, name: "Iron", price: 5, salaryFund: 1, fee: 0.18, airdropPoints: 100 },
            { id: 2, name: "Bronze", price: 10, salaryFund: 2, fee: 0.36, airdropPoints: 200 },
            { id: 3, name: "Silver", price: 15, salaryFund: 3, fee: 0.54, airdropPoints: 300 },
            { id: 4, name: "Gold", price: 20, salaryFund: 4, fee: 0.72, airdropPoints: 400 },
            { id: 5, name: "Master", price: 25, salaryFund: 5, fee: 0.9, airdropPoints: 500 },
            { id: 6, name: "Grandmaster", price: 50, salaryFund: 10, fee: 1.8, airdropPoints: 1000 },
            { id: 7, name: "Legend", price: 100, salaryFund: 20, fee: 3.6, airdropPoints: 2000 }
        ];
    }
    levelsCache = levels;
    return levels;
}

// --- Madadgar Functions ---

async function verifyTransaction(txHash, fromWallet, toWallet, expectedAmount) {
    try {
        if (!ethers.isHexString(txHash, 32)) return false;
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) return false;

        const decimals = await usdtContract.decimals();
        const expectedAmountWei = ethers.parseUnits(expectedAmount.toString(), Number(decimals));
        const tolerance = expectedAmountWei / 200n;
        const minRequired = expectedAmountWei - tolerance;

        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === USDT_CONTRACT.toLowerCase()) {
                try {
                    const parsedLog = usdtContract.interface.parseLog(log);
                    if (parsedLog?.name === "Transfer" && parsedLog.args.from.toLowerCase() === fromWallet.toLowerCase() && parsedLog.args.to.toLowerCase() === toWallet.toLowerCase() && parsedLog.args.value >= minRequired) {
                        return true;
                    }
                } catch (e) { /* Ignore */ }
            }
        }
        return false;
    } catch (error) {
        console.error(`Transaction check karne mein Error (${txHash}):`, error);
        return false;
    }
}

async function generateInviteCode() {
    let code = '', isUnique = false;
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    while (!isUnique) {
        code = Array.from({ length: 8 }, () => characters.charAt(Math.floor(Math.random() * characters.length))).join('');
        const snapshot = await db.ref(`inviteCodeMap/${code}`).once('value');
        if (!snapshot.exists()) isUnique = true;
    }
    return code;
}

async function addCommission(userId, amount, type) {
    if (!userId || !amount || amount <= 0) return;
    try {
        const walletSnapshot = await db.ref(`userIdMap/${userId}`).once('value');
        if (!walletSnapshot.exists()) return;
        const wallet = walletSnapshot.val();
        const userRef = db.ref(`users/${wallet}`);

        await userRef.child('ztrBalance').transaction(balance => (balance || 0) + amount);
        await userRef.child('incomeHistory').push({ amount, type, date: new Date().toISOString(), timestamp: admin.database.ServerValue.TIMESTAMP });
        await db.ref('platformStats/totalZTRDistributed').transaction(total => (total || 0) + amount);
        console.log(`✅ Commission: ${amount.toFixed(2)} ZTR (${type}) user ${userId} ko di gayi.`);
    } catch (error) {
        console.error(`Commission dene mein Error (User ${userId}):`, error);
    }
}

async function distributeAirdropPoints(userWallet, levelId) {
    const levels = await getLevelsConfig();
    const levelConfig = levels.find(l => l.id === levelId);
    if (!levelConfig?.airdropPoints) return;

    const points = levelConfig.airdropPoints;
    const ztrBonus = points * 0.001;

    const awardToWallet = async (wallet, type) => {
        const ref = db.ref(`users/${wallet}`);
        await ref.child('airdropPoints').transaction(p => (p || 0) + points);
        if (ztrBonus > 0) {
            await ref.child('ztrBalance').transaction(b => (b || 0) + ztrBonus);
            await ref.child('incomeHistory').push({ amount: ztrBonus, type: `Airdrop Bonus (${type})`, date: new Date().toISOString() });
        }
        console.log(`✅ Airdrop: ${points} points & ${ztrBonus} ZTR, Wallet: ${wallet} (${type})`);
    };

    await awardToWallet(userWallet, "Level Up");

    const userData = (await db.ref(`users/${userWallet}`).once('value')).val();
    if (userData?.inviterId) {
        const inviterWalletSnap = await db.ref(`userIdMap/${userData.inviterId}`).once('value');
        if (inviterWalletSnap.exists()) {
            await awardToWallet(inviterWalletSnap.val(), "Direct Referral");
            await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + points * 2);
            if(ztrBonus > 0) await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + ztrBonus * 2);
        }
    }
}

async function distributeRegistrationCommissions(inviterId, newUserId) {
    const levels = await getLevelsConfig();
    const starterPlan = levels.find(l => l.id === 0);
    if (!starterPlan?.price) return;

    const commissionAmount = starterPlan.price;

    await addCommission(inviterId, commissionAmount * 0.55, 'Starter Direct Commission');
    
    const inviterWalletSnap = await db.ref(`userIdMap/${inviterId}`).once('value');
    if (inviterWalletSnap.exists()) {
        const inviterData = (await db.ref(`users/${inviterWalletSnap.val()}`).once('value')).val();
        if (inviterData?.inviterId) {
            await addCommission(inviterData.inviterId, commissionAmount * 0.07, 'Starter Upline Commission');
        }
    }
    
    const teamMembersSnapshot = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
    if (teamMembersSnapshot.exists()) {
        const team = [];
        teamMembersSnapshot.forEach(snap => {
            if (snap.val().profile?.userId !== newUserId) team.push(snap.val().profile.userId);
        });
        if (team.length > 0) {
            const share = (commissionAmount * 0.20) / team.length;
            for (const memberId of team) await addCommission(memberId, share, 'Starter Team Commission');
        }
    }
}

// ==================== API ROUTES ====================

app.post('/api/register', async (req, res) => {
    const { wallet, txHash, inviterId, username, profilePic, registrationCost } = req.body;
    if (!wallet || !txHash || !inviterId || !username || !registrationCost) {
        return res.status(400).json({ success: false, error: "Zaroori maloomat kam hai." });
    }

    try {
        const walletLower = wallet.toLowerCase();
        if ((await db.ref(`users/${walletLower}`).once('value')).exists()) {
            return res.status(400).json({ success: false, error: "Yeh wallet pehle se register hai." });
        }
        
        const isValidTx = await verifyTransaction(txHash, wallet, ADMIN_WALLET, registrationCost);
        if (!isValidTx) {
            return res.status(400).json({ success: false, error: "Transaction ki tasdeeq nahi ho saki." });
        }
        
        const idRes = await db.ref('nextUserId').transaction(id => (id || 1000) + 1);
        const userId = idRes.snapshot.val();
        const inviteCode = await generateInviteCode();

        await db.ref(`users/${walletLower}`).set({
            profile: { name: username.substring(0, 30), userId, joinDate: new Date().toLocaleDateString('en-GB'), profilePicUrl: profilePic || null },
            inviteCode, inviterId: parseInt(inviterId), paid: true, ztrBalance: 0, airdropPoints: 0, level: 0, teamSize: 0
        });
        await db.ref(`userIdMap/${userId}`).set(walletLower);
        await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower);

        const inviterWalletSnap = await db.ref(`userIdMap/${parseInt(inviterId)}`).once('value');
        if (inviterWalletSnap.exists()) {
            await db.ref(`users/${inviterWalletSnap.val()}/teamSize`).transaction(s => (s || 0) + 1);
        }

        await distributeRegistrationCommissions(parseInt(inviterId), userId);
        await distributeAirdropPoints(walletLower, 0);
        
        await db.ref('platformStats/totalParticipants').transaction(p => (p || 0) + 1);
        const levels = await getLevelsConfig();
        const starterFund = levels.find(l => l.id === 0)?.salaryFund || 0;
        if (starterFund > 0) {
            await db.ref('platformStats/totalWeeklySalaryFund').transaction(p => (p || 0) + starterFund);
        }

        res.status(201).json({ success: true, message: "Registration kamyab!", userId });
    } catch (error) {
        console.error("Registration mein Error:", error);
        res.status(500).json({ success: false, error: "Server mein koi masla hai." });
    }
});

app.get('/api/user/:wallet', async (req, res) => {
    try {
        const snap = await db.ref(`users/${req.params.wallet.toLowerCase()}`).once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, error: "User nahi mila" });
        res.json({ success: true, user: snap.val() });
    } catch (error) {
        res.status(500).json({ success: false, error: "Database error" });
    }
});

// ==================== SALARY SYSTEM ====================
app.post('/api/admin/distribute-salary', async (req, res) => {
    const { authorization } = req.headers;
    if (authorization !== `Bearer ${process.env.ADMIN_SECRET_KEY}`) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    try {
        console.log("Haftawar Salary ka process shuru...");
        const weeklyPool = (await db.ref('platformStats/totalWeeklySalaryFund').once('value')).val() || 0;
        if (weeklyPool <= 0) return res.json({ success: true, message: "Salary pool khali hai." });

        const eligibleUsersSnap = await db.ref('users').orderByChild('level').startAt(5).once('value');
        if (!eligibleUsersSnap.exists()) return res.json({ success: true, message: "Salary ke liye koi user nahi hai." });

        const usersData = [];
        eligibleUsersSnap.forEach(snap => usersData.push({ wallet: snap.key, ...snap.val() }));
        
        let totalPerformanceScore = 0;
        const usersWithScores = await Promise.all(usersData.map(async user => {
            let teamLevelSum = 0;
            const directTeamSnap = await db.ref('users').orderByChild('inviterId').equalTo(user.profile.userId).once('value');
            if (directTeamSnap.exists()) {
                directTeamSnap.forEach(memberSnap => { teamLevelSum += (memberSnap.val().level || 0); });
            }
            const performanceScore = (user.level * 10) + teamLevelSum;
            totalPerformanceScore += performanceScore;
            return { ...user, performanceScore };
        }));

        if (totalPerformanceScore === 0) return res.json({ success: true, message: "Total performance score 0 hai." });
        
        for (const user of usersWithScores) {
            const userShare = (user.performanceScore / totalPerformanceScore) * weeklyPool;
            if (userShare > 0) {
                const userRef = db.ref(`users/${user.wallet}`);
                await userRef.child('ztrBalance').transaction(b => (b || 0) + userShare);
                await userRef.child('salaryHistory').push({ amount: userShare, date: new Date().toISOString() });
            }
        }

        await db.ref('platformStats/totalWeeklySalaryFund').set(0);
        res.json({ success: true, message: `Salary Taqseem Hogayi.` });
    } catch (error) {
        console.error("Salary dene mein FATAL ERROR:", error);
        res.status(500).json({ success: false, error: 'Server mein masla hai.' });
    }
});

// Server ko start karna
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server port ${PORT} par chal raha hai.`));
