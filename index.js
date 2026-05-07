const express = require('express');
const cors = require('cors');
const { db } = require('../firebase');

const app = express();
app.use(cors());
app.use(express.json());

// ================ Helper Functions ================
function isValidWalletAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/i.test(address);
}

async function getUserByWallet(wallet) {
  if (!isValidWalletAddress(wallet)) return null;
  const snapshot = await db.ref(`users/${wallet.toLowerCase()}`).once('value');
  return snapshot.exists() ? snapshot.val() : null;
}

async function getProfileByWallet(wallet) {
  const user = await getUserByWallet(wallet);
  return user?.profile || null;
}

// ================ API Endpoints ================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now(), message: 'ZTR Backend is running!' });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    name: 'ZTR Coin Backend API',
    version: '1.0.0',
    endpoints: [
      '/api/health',
      '/api/platform-data',
      '/api/register',
      '/api/upgrade',
      '/api/withdraw',
      '/api/claim-task-reward',
      '/api/user/:wallet'
    ]
  });
});

// Get platform-wide stats and leaderboard
app.get('/api/platform-data', async (req, res) => {
  try {
    const usersSnapshot = await db.ref('users').once('value');
    let totalParticipants = 0;
    let salaryActiveMembers = 0;
    let totalZTRDistributed = 0;
    let totalWeeklySalaryFund = 0;
    let totalAirdropDistributed = 0;
    const leaderboardData = [];

    if (usersSnapshot.exists()) {
      const users = usersSnapshot.val();
      totalParticipants = Object.keys(users).length;

      for (const [wallet, userData] of Object.entries(users)) {
        if (userData.ztrBalance) totalZTRDistributed += userData.ztrBalance;
        if (userData.airdropPoints) totalAirdropDistributed += userData.airdropPoints;
        if (userData.level && userData.level >= 5) salaryActiveMembers++;
        
        if (userData.profile && userData.ztrBalance) {
          leaderboardData.push({
            wallet,
            userId: userData.profile.userId,
            name: userData.profile.name || 'Anonymous',
            profilePicUrl: userData.profile.profilePicUrl || null,
            earnings: userData.ztrBalance
          });
        }
      }
    }

    leaderboardData.sort((a, b) => b.earnings - a.earnings);
    const topUsers = leaderboardData.slice(0, 20);

    // Get weekly salary fund from config
    const configSnapshot = await db.ref('config/weeklySalaryFund').once('value');
    totalWeeklySalaryFund = configSnapshot.exists() ? configSnapshot.val() : 5000;

    res.json({
      success: true,
      stats: {
        totalParticipants,
        salaryActiveMembers,
        totalZTRDistributed: Math.floor(totalZTRDistributed),
        totalWeeklySalaryFund,
        totalAirdropDistributed: Math.floor(totalAirdropDistributed)
      },
      leaderboard: topUsers
    });
  } catch (error) {
    console.error('Platform data error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Registration endpoint
app.post('/api/register', async (req, res) => {
  const { wallet, txHash, inviterId, username, profilePic, registrationCost } = req.body;

  if (!isValidWalletAddress(wallet)) {
    return res.status(400).json({ success: false, error: 'Invalid wallet address' });
  }

  const walletLower = wallet.toLowerCase();

  try {
    // Check if user already exists
    const existingUser = await getUserByWallet(wallet);
    if (existingUser?.profile) {
      return res.status(400).json({ success: false, error: 'User already registered' });
    }

    // Check if payment was made
    const paidCheck = await db.ref(`users/${walletLower}/paid`).once('value');
    if (!paidCheck.exists() || paidCheck.val() !== true) {
      return res.status(400).json({ success: false, error: 'Payment not confirmed yet' });
    }

    // Generate unique userId
    const userIdCounterRef = db.ref('meta/userIdCounter');
    let newUserId = 1;
    await userIdCounterRef.transaction(current => {
      newUserId = (current || 0) + 1;
      return newUserId;
    });

    // Generate unique invite code
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
    let inviteCode = '';
    for (let i = 0; i < 8; i++) inviteCode += chars[Math.floor(Math.random() * chars.length)];
    
    let codeExists = await db.ref(`inviteCodeMap/${inviteCode}`).once('value');
    while (codeExists.exists()) {
      inviteCode = '';
      for (let i = 0; i < 8; i++) inviteCode += chars[Math.floor(Math.random() * chars.length)];
      codeExists = await db.ref(`inviteCodeMap/${inviteCode}`).once('value');
    }

    const joinDate = new Date().toISOString();

    // Prepare user data
    const userData = {
      paid: true,
      paidAt: joinDate,
      registrationTx: txHash,
      registrationCost: parseFloat(registrationCost),
      level: 0,
      ztrBalance: 0,
      airdropPoints: 0,
      teamSize: 0,
      inviterId: inviterId ? parseInt(inviterId) : null,
      profile: {
        userId: newUserId,
        name: username,
        joinDate,
        profilePicUrl: profilePic || null
      },
      createdAt: joinDate
    };

    // Save user
    await db.ref(`users/${walletLower}`).set(userData);
    await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower);
    await db.ref(`userIdMap/${newUserId}`).set(walletLower);
    await db.ref(`users/${walletLower}/inviteCode`).set(inviteCode);

    // Update inviter's team size
    if (inviterId) {
      const inviterWallet = await db.ref(`userIdMap/${inviterId}`).once('value');
      if (inviterWallet.exists()) {
        const inviterWalletAddr = inviterWallet.val();
        await db.ref(`users/${inviterWalletAddr}/teamSize`).transaction(current => (current || 0) + 1);
      }
    }

    res.json({ success: true, userId: newUserId, inviteCode });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Level upgrade endpoint
app.post('/api/upgrade', async (req, res) => {
  const { wallet, txHash, levelId, upgradeCost, levelPrice } = req.body;

  if (!isValidWalletAddress(wallet)) {
    return res.status(400).json({ success: false, error: 'Invalid wallet address' });
  }

  const walletLower = wallet.toLowerCase();

  try {
    const user = await getUserByWallet(wallet);
    if (!user?.profile) {
      return res.status(400).json({ success: false, error: 'User not registered' });
    }

    const currentLevel = user.level || 0;
    if (currentLevel >= levelId) {
      return res.status(400).json({ success: false, error: 'Already achieved this level' });
    }
    if (currentLevel !== levelId - 1) {
      return res.status(400).json({ success: false, error: 'Must upgrade sequentially' });
    }

    // Get level config from Firebase
    const levelsSnapshot = await db.ref('config/levels').once('value');
    const levels = levelsSnapshot.exists() ? levelsSnapshot.val() : [];
    const targetLevel = levels.find(l => l.id === levelId);
    
    if (!targetLevel) {
      return res.status(400).json({ success: false, error: 'Level configuration not found' });
    }

    // Calculate ZTR reward for this upgrade (level price * 5)
    const ztrReward = (targetLevel.price || 0) * 5;

    // Update user level and add ZTR balance
    await db.ref(`users/${walletLower}/level`).set(levelId);
    await db.ref(`users/${walletLower}/ztrBalance`).transaction(current => (current || 0) + ztrReward);
    
    // Record upgrade transaction
    const upgradeRecord = {
      fromLevel: currentLevel,
      toLevel: levelId,
      costUSDT: parseFloat(upgradeCost),
      ztrReward: ztrReward,
      txHash: txHash,
      timestamp: Date.now()
    };
    await db.ref(`users/${walletLower}/upgradeHistory/${Date.now()}`).set(upgradeRecord);

    // Record income history
    const incomeRecord = {
      amount: ztrReward,
      type: `Level ${levelId} Upgrade Reward`,
      date: Date.now()
    };
    await db.ref(`users/${walletLower}/incomeHistory/${Date.now()}`).set(incomeRecord);

    // Award airdrop points for this level
    const airdropPoints = targetLevel.airdropPoints || 0;
    if (airdropPoints > 0) {
      await db.ref(`users/${walletLower}/airdropPoints`).transaction(current => (current || 0) + airdropPoints);
    }

    res.json({ success: true, newLevel: levelId, ztrReward, airdropPoints });
  } catch (error) {
    console.error('Upgrade error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Withdrawal request endpoint
app.post('/api/withdraw', async (req, res) => {
  const { wallet } = req.body;

  if (!isValidWalletAddress(wallet)) {
    return res.status(400).json({ success: false, error: 'Invalid wallet address' });
  }

  const walletLower = wallet.toLowerCase();

  try {
    const user = await getUserByWallet(wallet);
    if (!user?.profile) {
      return res.status(400).json({ success: false, error: 'User not registered' });
    }

    const ztrBalance = user.ztrBalance || 0;
    if (ztrBalance <= 0) {
      return res.status(400).json({ success: false, error: 'No ZTR balance to withdraw' });
    }

    // Create withdrawal request
    const withdrawalRequest = {
      wallet: walletLower,
      amount: ztrBalance,
      status: 'pending',
      requestedAt: Date.now()
    };

    await db.ref(`withdrawalRequests/${Date.now()}`).set(withdrawalRequest);

    res.json({ success: true, message: 'Withdrawal request submitted successfully' });
  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Claim task reward endpoint
app.post('/api/claim-task-reward', async (req, res) => {
  const { wallet, taskRequired, taskPoints } = req.body;

  if (!isValidWalletAddress(wallet)) {
    return res.status(400).json({ success: false, error: 'Invalid wallet address' });
  }

  const walletLower = wallet.toLowerCase();

  try {
    const user = await getUserByWallet(wallet);
    if (!user?.profile) {
      return res.status(400).json({ success: false, error: 'User not registered' });
    }

    const teamSize = user.teamSize || 0;
    if (teamSize < taskRequired) {
      return res.status(400).json({ success: false, error: `Need ${taskRequired} team members to claim this reward` });
    }

    const claimedTasks = user.claimedTasks || {};
    const taskKey = `task_${taskRequired}`;
    
    if (claimedTasks[taskKey]) {
      return res.status(400).json({ success: false, error: 'Reward already claimed' });
    }

    // Award airdrop points
    await db.ref(`users/${walletLower}/airdropPoints`).transaction(current => (current || 0) + taskPoints);
    await db.ref(`users/${walletLower}/claimedTasks/${taskKey}`).set(true);

    res.json({ success: true, message: `Claimed ${taskPoints} airdrop points!` });
  } catch (error) {
    console.error('Claim task error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get user data endpoint
app.get('/api/user/:wallet', async (req, res) => {
  const { wallet } = req.params;

  if (!isValidWalletAddress(wallet)) {
    return res.status(400).json({ success: false, error: 'Invalid wallet address' });
  }

  try {
    const user = await getUserByWallet(wallet);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({
      success: true,
      user: {
        level: user.level || 0,
        ztrBalance: user.ztrBalance || 0,
        airdropPoints: user.airdropPoints || 0,
        teamSize: user.teamSize || 0,
        profile: user.profile,
        paid: user.paid || false,
        inviterId: user.inviterId || null
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Export for Vercel
module.exports = app;
