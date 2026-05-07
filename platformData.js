const express = require('express');
const router = express.Router();
const { db } = require('../firebase');

router.get('/', async (req, res) => {
    try {
        const countersSnapshot = await db.ref('counters').once('value');
        const counters = countersSnapshot.val() || {};
        
        const usersSnapshot = await db.ref('users').once('value');
        const allUsers = usersSnapshot.val() || {};
        
        let salaryActiveMembers = 0;
        let totalZTRDistributed = 0;
        const leaderboard = [];

        Object.values(allUsers).forEach(user => {
            if (user.level >= 5) salaryActiveMembers++;
            const totalEarnings = (user.ztrBalance || 0) + Object.values(user.salaryHistory || {}).reduce((acc, s) => acc + s.amount, 0);
            totalZTRDistributed += totalEarnings;
            leaderboard.push({
                name: user.profile.name,
                userId: user.profile.userId,
                profilePicUrl: user.profile.profilePicUrl,
                earnings: totalEarnings
            });
        });
        
        leaderboard.sort((a, b) => b.earnings - a.earnings).splice(200); // Top 200 users

        const stats = {
            totalParticipants: counters.totalParticipants || 0,
            salaryActiveMembers: salaryActiveMembers,
            totalZTRDistributed: totalZTRDistributed,
            totalWeeklySalaryFund: 0, // Needs separate logic
            totalAirdropDistributed: 0, // Needs separate logic
        };
        
        res.status(200).json({ success: true, stats, leaderboard });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message || "An internal server error occurred." });
    }
});

module.exports = router;