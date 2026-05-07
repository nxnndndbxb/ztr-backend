const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebase');
const { verifyUsdtTransaction } = require('../utils');

async function getNextId(counterName) {
    const counterRef = db.ref(`counters/${counterName}`);
    const snapshot = await counterRef.transaction(currentCount => (currentCount || 0) + 1);
    return snapshot.snapshot.val();
}

function generateInviteCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;
}

router.post('/', async (req, res) => {
    const { wallet, txHash, inviterId, username, profilePic, registrationCost } = req.body;

    if (!wallet || !txHash || !inviterId || !username || !registrationCost) {
        return res.status(400).json({ success: false, error: "Missing required fields." });
    }

    const walletLower = wallet.toLowerCase();

    try {
        const userSnapshot = await db.ref(`users/${walletLower}`).once('value');
        if (userSnapshot.exists()) {
            return res.status(400).json({ success: false, error: "User is already registered." });
        }

        const txHashSnapshot = await db.ref(`usedTxHashes/${txHash}`).once('value');
        if (txHashSnapshot.exists()) {
            return res.status(400).json({ success: false, error: "Transaction has already been processed." });
        }

        await verifyUsdtTransaction(txHash, wallet, parseFloat(registrationCost));

        const inviterWalletSnapshot = await db.ref('userIdMap').child(inviterId.toString()).once('value');
        if (!inviterWalletSnapshot.exists()) return res.status(400).json({ success: false, error: "Inviter not found." });
        
        const inviterWallet = inviterWalletSnapshot.val();
        const inviterData = (await db.ref(`users/${inviterWallet}`).once('value')).val();

        const newUserId = await getNextId('userCounter');
        let newInviteCode;
        do { newInviteCode = generateInviteCode(); } 
        while ((await db.ref(`inviteCodeMap/${newInviteCode}`).once('value')).exists());
        
        const totalFeeInZTR = parseFloat(registrationCost) / 1.0; // Assume 1 ZTR = 1 USDT
        const directCommission = totalFeeInZTR * 0.55;
        const uplineCommission = totalFeeInZTR * 0.07;
        const teamSplitCommission = totalFeeInZTR * 0.20;
        
        const updates = {};
        const now = Date.now();
        
        updates[`users/${inviterWallet}/ztrBalance`] = admin.database.ServerValue.increment(directCommission);
        updates[`users/${inviterWallet}/incomeHistory/${now}`] = { type: 'Direct Commission', amount: directCommission, from: newUserId, date: now };
        updates[`users/${inviterWallet}/teamSize`] = admin.database.ServerValue.increment(1);
        updates[`users/${inviterWallet}/airdropPoints`] = admin.database.ServerValue.increment(100); // 100 points for inviting

        if (inviterData.inviterId) {
            const uplineWallet = (await db.ref('userIdMap').child(inviterData.inviterId.toString()).once('value')).val();
            if (uplineWallet) {
                updates[`users/${uplineWallet}/ztrBalance`] = admin.database.ServerValue.increment(uplineCommission);
                updates[`users/${uplineWallet}/incomeHistory/${now + 1}`] = { type: 'Upline Commission', amount: uplineCommission, from: newUserId, date: now + 1 };
            }
        }

        const directMembersSnapshot = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
        if (directMembersSnapshot.exists()) {
            const memberKeys = Object.keys(directMembersSnapshot.val());
            if (memberKeys.length > 0) {
                const splitPerMember = teamSplitCommission / memberKeys.length;
                memberKeys.forEach((key, i) => {
                    updates[`users/${key}/ztrBalance`] = admin.database.ServerValue.increment(splitPerMember);
                    updates[`users/${key}/incomeHistory/${now+2+i}`] = { type: 'Team Split', amount: splitPerMember, from: newUserId, date: now+2+i };
                });
            }
        }
        
        updates[`users/${walletLower}`] = {
            paid: true, inviterId, level: 0, ztrBalance: 0, airdropPoints: 0, teamSize: 0, inviteCode: newInviteCode,
            profile: { userId: newUserId, name: username, profilePicUrl: profilePic || null, joinDate: new Date(now).toLocaleDateString() }
        };
        updates[`inviteCodeMap/${newInviteCode}`] = walletLower;
        updates[`userIdMap/${newUserId}`] = walletLower;
        updates[`usedTxHashes/${txHash}`] = true;
        updates['counters/totalParticipants'] = admin.database.ServerValue.increment(1);

        await db.ref().update(updates);
        res.status(201).json({ success: true, message: "Registration successful!" });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message || "An internal server error occurred." });
    }
});

module.exports = router;