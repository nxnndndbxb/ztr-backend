const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebase');

router.post('/', async (req, res) => {
    const { wallet, taskRequired, taskPoints } = req.body;
    if (!wallet || !taskRequired || !taskPoints) return res.status(400).json({ success: false, error: "Missing required fields." });

    const walletLower = wallet.toLowerCase();
    const taskKey = `task_${taskRequired}`;

    try {
        const userRef = db.ref(`users/${walletLower}`);
        const userSnapshot = await userRef.once('value');
        if (!userSnapshot.exists()) return res.status(404).json({ success: false, error: "User not found." });

        const userData = userSnapshot.val();
        if (userData.teamSize < taskRequired) return res.status(400).json({ success: false, error: "Task not completed yet." });
        if (userData.claimedTasks && userData.claimedTasks[taskKey]) return res.status(400).json({ success: false, error: "Reward already claimed." });
        
        const updates = {};
        updates[`users/${walletLower}/airdropPoints`] = admin.database.ServerValue.increment(taskPoints);
        updates[`users/${walletLower}/claimedTasks/${taskKey}`] = true;
        
        await db.ref().update(updates);
        res.status(200).json({ success: true, message: `Successfully claimed ${taskPoints} airdrop points!` });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message || "An internal server error occurred." });
    }
});

module.exports = router;