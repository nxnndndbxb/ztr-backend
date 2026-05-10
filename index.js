require('dotenv').config();

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// =========================
// FIREBASE INIT
// =========================

const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();

// =========================
// CONFIG
// =========================

const PORT = process.env.PORT || 3000;
const ADMIN_WALLET = '0x0000000000000000000000000000000000000000';

// =========================
// HELPERS
// =========================

async function generateInviteCode() {

    let code;
    let exists = true;

    while (exists) {

        code = 'ZTR' + Math.floor(100000 + Math.random() * 900000);

        const snap = await db.ref(`inviteCodeMap/${code}`).once('value');

        exists = snap.exists();
    }

    return code;
}

async function verifyTransaction(txHash) {

    try {

        if (!txHash || txHash.length < 10) {
            return false;
        }

        return true;

    } catch (error) {
        return false;
    }
}

async function getLevelsConfig() {

    return [
        {
            id: 0,
            price: 5,
            salary: 0
        },
        {
            id: 1,
            price: 10,
            salary: 1
        },
        {
            id: 2,
            price: 20,
            salary: 2
        },
        {
            id: 3,
            price: 50,
            salary: 5
        },
        {
            id: 4,
            price: 100,
            salary: 10
        },
        {
            id: 5,
            price: 200,
            salary: 20
        }
    ];
}

async function addStarToLevel(wallet, levelId, type, sourceUserId) {

    try {

        const ref = db.ref(`users/${wallet}/levelStars/${levelId}`);

        const snap = await ref.once('value');

        let stars = snap.val() || [];

        stars.push({
            type,
            sourceUserId,
            createdAt: Date.now()
        });

        await ref.set(stars);

    } catch (error) {
        console.log(error.message);
    }
}

async function distributeAirdropPoints(wallet, level) {

    try {

        const points = (level + 1) * 100;

        await db.ref(`users/${wallet}/airdropPoints`).transaction(current => {
            return (Number(current) || 0) + points;
        });

    } catch (error) {
        console.log(error.message);
    }
}

// =========================
// COMMISSION SYSTEM
// =========================

async function addCommission(userId, amount, type, starType, levelId, sourceUserId, starLevelId) {

    try {

        if (!userId || amount <= 0) {
            return false;
        }

        const walletSnap = await db.ref(`userIdMap/${userId}`).once('value');

        if (!walletSnap.exists()) {
            return false;
        }

        const wallet = walletSnap.val().toLowerCase();

        const userRef = db.ref(`users/${wallet}`);

        await userRef.child('ztrBalance').transaction(balance => {
            return (Number(balance) || 0) + Number(amount);
        });

        await userRef.child('incomeHistory').push({
            amount: Number(amount),
            type,
            levelId: levelId || 0,
            sourceUserId: sourceUserId || null,
            createdAt: Date.now()
        });

        await db.ref('platformStats/totalZTRDistributed').transaction(total => {
            return (Number(total) || 0) + Number(amount);
        });

        if (starType) {
            await addStarToLevel(wallet, starLevelId || levelId, starType, sourceUserId);
        }

        return true;

    } catch (error) {

        console.log('Commission Error:', error.message);
        return false;
    }
}

async function distributeRegistrationCommissions(inviterId, newUserId) {

    try {

        const levels = await getLevelsConfig();

        const starterPlan = levels.find(level => level.id === 0);

        const amount = Number(starterPlan.price || 5);

        // DIRECT BONUS
        await addCommission(
            inviterId,
            amount * 0.55,
            'Direct Invite Commission',
            'direct',
            0,
            newUserId,
            0
        );

        // UPLINE BONUS
        const inviterWalletSnap = await db.ref(`userIdMap/${inviterId}`).once('value');

        if (inviterWalletSnap.exists()) {

            const inviterWallet = inviterWalletSnap.val();

            const inviterDataSnap = await db.ref(`users/${inviterWallet}`).once('value');

            const inviterData = inviterDataSnap.val();

            if (inviterData && inviterData.inviterId) {

                await addCommission(
                    inviterData.inviterId,
                    amount * 0.07,
                    'Upline Bonus',
                    'upline',
                    0,
                    newUserId,
                    0
                );
            }
        }

        // TEAM BONUS
        const teamSnap = await db.ref('users')
            .orderByChild('inviterId')
            .equalTo(inviterId)
            .once('value');

        if (teamSnap.exists()) {

            const members = [];

            teamSnap.forEach(item => {

                const val = item.val();

                if (val.profile && val.profile.userId !== newUserId) {
                    members.push(val.profile.userId);
                }
            });

            if (members.length > 0) {

                const share = (amount * 0.20) / members.length;

                for (const memberId of members) {

                    await addCommission(
                        memberId,
                        share,
                        'Team Reward',
                        'downline',
                        0,
                        newUserId,
                        0
                    );
                }
            }
        }

    } catch (error) {
        console.log(error.message);
    }
}

// =========================
// WEEKLY SALARY SYSTEM
// =========================

async function distributeWeeklySalary() {

    try {

        const usersSnap = await db.ref('users').once('value');

        if (!usersSnap.exists()) {
            return;
        }

        const users = usersSnap.val();

        const fundSnap = await db.ref('platformStats/totalWeeklySalaryFund').once('value');

        const totalFund = Number(fundSnap.val() || 0);

        if (totalFund <= 0) {
            return;
        }

        const eligibleUsers = [];

        Object.keys(users).forEach(wallet => {

            const user = users[wallet];

            if ((user.level || 0) >= 5) {
                eligibleUsers.push({ wallet, user });
            }
        });

        if (eligibleUsers.length === 0) {
            return;
        }

        const share = totalFund / eligibleUsers.length;

        for (const item of eligibleUsers) {

            const wallet = item.wallet;

            const userRef = db.ref(`users/${wallet}`);

            await userRef.child('ztrBalance').transaction(balance => {
                return (Number(balance) || 0) + share;
            });

            await userRef.child('salaryHistory').push({
                amount: share,
                type: 'Weekly Salary',
                createdAt: Date.now()
            });

            await userRef.child('incomeHistory').push({
                amount: share,
                type: 'Weekly Salary',
                createdAt: Date.now()
            });
        }

        await db.ref('platformStats/totalWeeklySalaryFund').set(0);

    } catch (error) {
        console.log(error.message);
    }
}

// =========================
// REGISTER API
// =========================

app.post('/api/register', async (req, res) => {

    try {

        const {
            wallet,
            txHash,
            inviterId,
            username,
            profilePic,
            registrationCost
        } = req.body;

        if (!wallet || !txHash || !inviterId || !username) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }

        const walletLower = wallet.toLowerCase();

        const existing = await db.ref(`users/${walletLower}`).once('value');

        if (existing.exists()) {
            return res.status(400).json({
                success: false,
                error: 'Wallet already registered'
            });
        }

        const txValid = await verifyTransaction(txHash);

        if (!txValid) {
            return res.status(400).json({
                success: false,
                error: 'Invalid transaction'
            });
        }

        const nextIdRef = db.ref('nextUserId');

        const transaction = await nextIdRef.transaction(current => {
            return (current || 1000) + 1;
        });

        const userId = transaction.snapshot.val();

        const inviteCode = await generateInviteCode();

        await db.ref(`users/${walletLower}`).set({

            profile: {
                name: username,
                userId,
                profilePicUrl: profilePic || '',
                joinDate: new Date().toISOString()
            },

            inviteCode,
            inviterId: Number(inviterId),
            paid: true,
            level: 0,
            teamSize: 0,
            ztrBalance: 1,
            airdropPoints: 100,
            incomeHistory: {},
            salaryHistory: {},
            levelStars: {},
            claimedTasks: {}
        });

        await db.ref(`userIdMap/${userId}`).set(walletLower);

        await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower);

        const inviterWalletSnap = await db.ref(`userIdMap/${inviterId}`).once('value');

        if (inviterWalletSnap.exists()) {

            const inviterWallet = inviterWalletSnap.val();

            await db.ref(`users/${inviterWallet}/teamSize`).transaction(size => {
                return (Number(size) || 0) + 1;
            });
        }

        await distributeRegistrationCommissions(Number(inviterId), userId);

        await distributeAirdropPoints(walletLower, 0);

        await db.ref('platformStats/totalParticipants').transaction(total => {
            return (Number(total) || 0) + 1;
        });

        await db.ref('platformStats/totalWeeklySalaryFund').transaction(total => {
            return (Number(total) || 0) + Number(registrationCost || 5) * 0.10;
        });

        res.status(201).json({
            success: true,
            userId,
            inviteCode
        });

    } catch (error) {

        console.log(error.message);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// =========================
// LOGIN API
// =========================

app.post('/api/login', async (req, res) => {

    try {

        const { wallet } = req.body;

        if (!wallet) {
            return res.status(400).json({
                success: false,
                error: 'Wallet required'
            });
        }

        const walletLower = wallet.toLowerCase();

        const snap = await db.ref(`users/${walletLower}`).once('value');

        if (!snap.exists()) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        res.json({
            success: true,
            user: snap.val()
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// =========================
// USER API
// =========================

app.get('/api/user/:wallet', async (req, res) => {

    try {

        const wallet = req.params.wallet.toLowerCase();

        const snap = await db.ref(`users/${wallet}`).once('value');

        if (!snap.exists()) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        const user = snap.val();

        const incomeHistory = [];

        if (user.incomeHistory) {

            Object.keys(user.incomeHistory).forEach(key => {
                incomeHistory.push(user.incomeHistory[key]);
            });
        }

        incomeHistory.sort((a, b) => b.createdAt - a.createdAt);

        const salaryHistory = [];

        if (user.salaryHistory) {

            Object.keys(user.salaryHistory).forEach(key => {
                salaryHistory.push(user.salaryHistory[key]);
            });
        }

        salaryHistory.sort((a, b) => b.createdAt - a.createdAt);

        res.json({
            success: true,
            user: {
                ...user,
                incomeHistory,
                salaryHistory
            }
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// =========================
// LEVEL UPGRADE
// =========================

app.post('/api/upgrade-level', async (req, res) => {

    try {

        const {
            wallet,
            level,
            txHash
        } = req.body;

        const walletLower = wallet.toLowerCase();

        const userSnap = await db.ref(`users/${walletLower}`).once('value');

        if (!userSnap.exists()) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        const user = userSnap.val();

        const txValid = await verifyTransaction(txHash);

        if (!txValid) {
            return res.status(400).json({
                success: false,
                error: 'Invalid transaction'
            });
        }

        await db.ref(`users/${walletLower}/level`).set(level);

        await distributeAirdropPoints(walletLower, level);

        await db.ref(`users/${walletLower}/incomeHistory`).push({
            type: 'Level Upgrade',
            amount: 0,
            level,
            createdAt: Date.now()
        });

        res.json({
            success: true,
            message: 'Level upgraded successfully'
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// =========================
// CLAIM TASK
// =========================

app.post('/api/claim-task', async (req, res) => {

    try {

        const {
            wallet,
            taskId,
            reward
        } = req.body;

        const walletLower = wallet.toLowerCase();

        const taskSnap = await db.ref(`users/${walletLower}/claimedTasks/${taskId}`).once('value');

        if (taskSnap.exists()) {
            return res.status(400).json({
                success: false,
                error: 'Task already claimed'
            });
        }

        await db.ref(`users/${walletLower}/claimedTasks/${taskId}`).set(true);

        await db.ref(`users/${walletLower}/ztrBalance`).transaction(balance => {
            return (Number(balance) || 0) + Number(reward || 0);
        });

        await db.ref(`users/${walletLower}/incomeHistory`).push({
            amount: Number(reward || 0),
            type: 'Task Reward',
            createdAt: Date.now()
        });

        res.json({
            success: true,
            message: 'Reward claimed successfully'
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// =========================
// RUN SALARY API
// =========================

app.post('/api/run-weekly-salary', async (req, res) => {

    try {

        await distributeWeeklySalary();

        res.json({
            success: true,
            message: 'Weekly salary distributed successfully'
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// =========================
// PLATFORM STATS
// =========================

app.get('/api/stats', async (req, res) => {

    try {

        const snap = await db.ref('platformStats').once('value');

        res.json({
            success: true,
            stats: snap.val() || {}
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// =========================
// HOME
// =========================

app.get('/', (req, res) => {

    res.json({
        success: true,
        message: 'ZTR Backend Running Successfully'
    });
});

// =========================
// START SERVER
// =========================

app.listen(PORT, () => {
    console.log(`Server Running On Port ${PORT}`);
});
