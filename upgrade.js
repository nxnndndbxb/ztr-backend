const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebase');
const { verifyUsdtTransaction } = require('../utils');

router.post('/', async (req, res) => {
    const { wallet, txHash, levelId, upgradeCost } = req.body;
    
    if (!wallet || !txHash || !levelId || !upgradeCost) {
        return res.status(400).json({ success: false, error: "Missing required fields." });
    }
    
    const walletLower = wallet.toLowerCase();

    try {
        const userRef = db.ref(`users/${walletLower}`);
        const userSnapshot = await userRef.once('value');
        if (!userSnapshot.exists()) return res.status(404).json({ success: false, error: "User not found." });
        
        const userData = userSnapshot.val();
        if (userData.level >= levelId) return res.status(400).json({ success: false, error: "Level already unlocked." });
        if (userData.level !== levelId - 1) return res.status(400).json({ success: false, error: "Please unlock previous levels first." });
        
        const txHashSnapshot = await db.ref(`usedTxHashes/${txHash}`).once('value');
        if (txHashSnapshot.exists()) return res.status(400).json({ success: false, error: "Transaction has already been processed." });
        
        await verifyUsdtTransaction(txHash, wallet, parseFloat(upgradeCost));
        
        const levelConfig = (await db.ref(`config/levels/${levelId - 1}`).once('value')).val();
        if (!levelConfig) return res.status(500).json({ success: false, error: "Level configuration not found." });

        const updates = {};
        const now = Date.now();
        
        updates[`users/${walletLower}/level`] = levelId;
        updates[`users/${walletLower}/airdropPoints`] = admin.database.ServerValue.increment(levelConfig.airdropPoints || 0);
        updates[`usedTxHashes/${txHash}`] = true;
        
        if (userData.inviterId) {
            const inviterWallet = (await db.ref(`userIdMap/${userData.inviterId}`).once('value')).val();
            if(inviterWallet) {
                updates[`users/${inviterWallet}/airdropPoints`] = admin.database.ServerValue.increment(levelConfig.airdropPoints || 0);
            }
        }
        
        await db.ref().update(updates);
        res.status(200).json({ success: true, message: `Level ${levelId} unlocked successfully!` });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message || "An internal server error occurred." });
    }
});

module.exports = router;