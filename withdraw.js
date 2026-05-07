const express = require('express');
const router = express.Router();
const { db } = require('../firebase');

router.post('/', async (req, res) => {
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ success: false, error: "Wallet address is required." });
    
    const walletLower = wallet.toLowerCase();
    
    try {
        const userRef = db.ref(`users/${walletLower}`);
        const userSnapshot = await userRef.once('value');
        if (!userSnapshot.exists()) return res.status(404).json({ success: false, error: "User not found." });
        
        const userData = userSnapshot.val();
        const ztrBalance = userData.ztrBalance || 0;
        
        if (ztrBalance <= 0) return res.status(400).json({ success: false, error: "Insufficient ZTR balance." });
        
        const withdrawalRequest = {
            wallet: walletLower,
            userId: userData.profile.userId,
            amount: ztrBalance,
            status: 'pending',
            requestDate: new Date().toISOString()
        };
        
        await db.ref('withdrawals').push(withdrawalRequest);
        await userRef.child('ztrBalance').set(0); // Set user balance to 0 after request
        
        res.status(200).json({ success: true, message: "Withdrawal request submitted successfully. It will be processed after review." });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message || "An internal server error occurred." });
    }
});

module.exports = router;