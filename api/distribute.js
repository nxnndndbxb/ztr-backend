const admin = require('firebase-admin');

// Firebase Admin Initialize karna (Vercel Environment Variables se)
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            // Vercel par private key mein \n ka masla aata hai, isliye replace lagaya hai
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
        databaseURL: process.env.FIREBASE_DATABASE_URL
    });
}

const db = admin.database();

export default async function handler(req, res) {
    // Security Check: Taake koi aam user API ko call na kar sake.
    // Vercel Cron job jab chalti hai to wo ek CRON_SECRET bhejti hai.
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized. Only Vercel Cron can trigger this.' });
    }

    try {
        const statsRef = db.ref('platformStats');
        const usersRef = db.ref('users');

        // 1. Database se stats aur users fetch karein
        const [statsSnapshot, usersSnapshot] = await Promise.all([
            statsRef.once('value'),
            usersRef.once('value')
        ]);

        const stats = statsSnapshot.val() || {};
        const users = usersSnapshot.val() || {};

        const totalWeeklySalaryFund = stats.totalWeeklySalaryFund || 0;

        // Agar fund 0 hai to kuch mat karo
        if (totalWeeklySalaryFund <= 0) {
            return res.status(200).json({ message: 'No salary fund to distribute.' });
        }

        // 2. 90% fund nikalna hai (Frontend ke rule ke mutabiq)
        const distributableFund = totalWeeklySalaryFund * 0.90;
        
        let totalSystemScore = 0;
        const eligibleUsers = [];

        // 3. Eligible Users (Level 5+ yani index 4 ya us se bara) aur unka score calculate karein
        for (const [wallet, userData] of Object.entries(users)) {
            const levelId = userData.level !== undefined ? userData.level : 0;
            
            if (levelId >= 4 && userData.profile) { // Level 5 (Index 4) ya upar
                const userId = userData.profile.userId;
                
                // Personal Score (us ka apna level)
                let userScore = levelId; 
                
                // Direct Team Score (Direct members ke levels ka total)
                let teamLevelSum = 0;
                for (const [childWallet, childData] of Object.entries(users)) {
                    if (childData.inviterId === userId) {
                        teamLevelSum += (childData.level !== undefined ? childData.level : 0);
                    }
                }

                userScore += teamLevelSum; // Final Performance Score
                totalSystemScore += userScore;

                eligibleUsers.push({
                    wallet: wallet,
                    score: userScore,
                    data: userData
                });
            }
        }

        if (eligibleUsers.length === 0 || totalSystemScore === 0) {
             return res.status(200).json({ message: 'No eligible users found for salary.' });
        }

        // 4. Sab eligible logon mein unke score ke hisab se 90% fund baant dena
        const updates = {};
        const timestamp = admin.database.ServerValue.TIMESTAMP;

        for (const user of eligibleUsers) {
            const userShare = (user.score / totalSystemScore) * distributableFund;
            
            if (userShare > 0) {
                const walletLower = user.wallet.toLowerCase();
                
                // ZTR Balance aur salleryEarnings update karein
                updates[`users/${walletLower}/ztrBalance`] = admin.database.ServerValue.increment(userShare);
                updates[`users/${walletLower}/salleryEarnings`] = admin.database.ServerValue.increment(userShare);
                
                // History mein record push karein
                const newHistoryRef = db.ref(`users/${walletLower}/incomeHistory`).push();
                updates[`users/${walletLower}/incomeHistory/${newHistoryRef.key}`] = {
                    amount: userShare,
                    type: 'Weekly Salary',
                    date: new Date().toISOString(),
                    timestamp: timestamp
                };
            }
        }

        // 5. Platform Stats Update karein (Fund ko 10% par le aayen, ya distribute hui amount minus kar dein)
        updates[`platformStats/totalWeeklySalaryFund`] = admin.database.ServerValue.increment(-distributableFund);
        updates[`platformStats/totalZTRDistributed`] = admin.database.ServerValue.increment(distributableFund);

        // Sab changes Database mein save karein (One atomic update)
        await db.ref().update(updates);

        return res.status(200).json({ 
            message: 'Salary Distributed Successfully!',
            fundDistributed: distributableFund,
            eligibleUsersCount: eligibleUsers.length
        });

    } catch (error) {
        console.error('Error distributing salary:', error);
        return res.status(500).json({ error: 'Failed to distribute salary', details: error.message });
    }
}
