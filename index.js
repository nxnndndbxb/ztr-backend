const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();

// --- Verbeterde CORS-configuratie ---
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());
app.use(express.json());

// --- Firebase Admin Setup ---
let db;
try {
    const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!serviceAccountBase64) {
        throw new Error("FATALE FOUT: De omgevingsvariabele FIREBASE_SERVICE_ACCOUNT_BASE64 is niet ingesteld.");
    }
    
    const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('ascii'));
    
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DB_URL
    });
    
    db = admin.database();
    console.log("✅ Firebase Admin succesvol geïnitialiseerd");
} catch (error) {
    console.error("🔥 Firebase Admin Initialisatie Mislukt:", error.message);
    process.exit(1);
}

// --- Blockchain & Contract Configuratie ---
const ADMIN_WALLET = "0x97efeaa1da1108acff52840550ec51dc5bbfd812";
const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";
const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/");

const usdtAbi = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function decimals() view returns (uint8)",
];

const usdtContract = new ethers.Contract(USDT_CONTRACT, usdtAbi, provider);

// --- Cache voor veelgebruikte gegevens ---
let levelsCache = null;
let levelsCacheTime = 0;
const CACHE_TTL = 60 * 1000; // 1 minuut

// --- Helper Functies ---

/**
 * Haalt de Level Config inclusief Level 0 (Starter) op uit Firebase met fallback
 */
async function getLevelsConfig() {
    if (levelsCache && (Date.now() - levelsCacheTime) < CACHE_TTL) {
        return levelsCache;
    }
    const snapshot = await db.ref('config/levels').once('value');
    let levels = snapshot.val();
    if (!Array.isArray(levels) || levels.length === 0) {
        console.warn("⚠️ Fallback-levelconfiguratie wordt gebruikt omdat er geen configuratie in de database is gevonden.");
        levels = [
            { id: 0, name: "Starter", price: 5, salaryFund: 0.25, fee: 0, icon: "🌱", airdropPoints: 100, salary: 0 },
            { id: 1, name: "Iron", price: 5, salaryFund: 1, fee: 0.18, icon: "🛡️", airdropPoints: 100, salary: 0 },
            { id: 2, name: "Bronze", price: 10, salaryFund: 2, fee: 0.36, icon: "🥉", airdropPoints: 200, salary: 0 },
            { id: 3, name: "Silver", price: 15, salaryFund: 3, fee: 0.54, icon: "🥈", airdropPoints: 300, salary: 0 },
            { id: 4, name: "Gold", price: 20, salaryFund: 4, fee: 0.72, icon: "🥇", airdropPoints: 400, salary: 0 },
            { id: 5, name: "Master", price: 25, salaryFund: 5, fee: 0.9, icon: "👑", airdropPoints: 500, salary: 10 },
            { id: 6, name: "Grandmaster", price: 50, salaryFund: 10, fee: 1.8, icon: "⚔️", airdropPoints: 1000, salary: 25 },
            { id: 7, name: "Legend", price: 100, salaryFund: 20, fee: 3.6, icon: "🌟", airdropPoints: 2000, salary: 60 }
        ];
    }
    levelsCache = levels;
    levelsCacheTime = Date.now();
    return levels;
}

/**
 * Haalt de registratiekosten op basis van de Starter (Level 0) configuratie.
 */
async function getRegistrationFee() {
    const levels = await getLevelsConfig();
    const starterLevel = levels.find(l => l.id === 0);
    if (!starterLevel) return 5.25; // Veilige fallback
    return (starterLevel.price || 0) + (starterLevel.salaryFund || 0) + (starterLevel.fee || 0);
}

/**
 * Haalt de ZTR-prijs op uit de database.
 */
async function getZTRPrice() {
    const snapshot = await db.ref('config/baseZTRPrice').once('value');
    return snapshot.exists() ? snapshot.val() : 1.0;
}

/**
 * Verifieert een USDT-transactie op de blockchain.
 */
async function verifyTransaction(txHash, fromWallet, toWallet, expectedAmount) {
    try {
        if (!ethers.isHexString(txHash, 32)) return false;
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) return false;

        const decimals = await usdtContract.decimals();
        const expectedAmountWei = ethers.parseUnits(expectedAmount.toString(), decimals);
        const tolerance = expectedAmountWei / 200n; // 0.5% tolerantie
        const minRequired = expectedAmountWei - tolerance;

        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === USDT_CONTRACT.toLowerCase()) {
                try {
                    const parsedLog = usdtContract.interface.parseLog(log);
                    if (parsedLog && parsedLog.name === "Transfer") {
                        const { from, to, value } = parsedLog.args;
                        if (from.toLowerCase() === fromWallet.toLowerCase() && to.toLowerCase() === toWallet.toLowerCase() && value >= minRequired) {
                            return true;
                        }
                    }
                } catch (e) { /* Negeer parseerfouten van andere logs */ }
            }
        }
        return false;
    } catch (error) {
        console.error(`Transactieverificatiefout voor hash ${txHash}:`, error);
        return false;
    }
}

/**
 * Voegt op een veilige manier commissie en geschiedenis toe aan een gebruiker via hun ID.
 */
async function addCommission(userId, amount, type) {
    if (!userId || !amount || amount <= 0) {
        console.error(`Ongeldige poging tot commissie: userId=${userId}, bedrag=${amount}`);
        return false;
    }

    try {
        const walletSnapshot = await db.ref(`userIdMap/${userId}`).once('value');
        if (!walletSnapshot.exists()) {
            console.error(`Kon wallet niet vinden voor userId: ${userId} om commissie toe te voegen.`);
            return false;
        }
        const wallet = walletSnapshot.val();
        const userRef = db.ref(`users/${wallet}`);

        await userRef.child('ztrBalance').transaction(balance => (balance || 0) + amount);
        await userRef.child('incomeHistory').push({
            amount,
            type,
            date: new Date().toISOString(),
            timestamp: admin.database.ServerValue.TIMESTAMP
        });

        await db.ref('platformStats/totalZTRDistributed').transaction(total => (total || 0) + amount);
        console.log(`✅ Commissie van ${amount} ZTR van type '${type}' succesvol toegevoegd aan userId ${userId}`);
        return true;
    } catch (error) {
        console.error(`FATALE FOUT bij het toevoegen van commissie aan userId ${userId}:`, error);
        return false;
    }
}

/**
 * Kent airdrop-punten en ZTR-bonus toe.
 */
async function distributeAirdropPoints(userWallet, levelId) {
    const levels = await getLevelsConfig();
    const levelConfig = levels.find(l => l.id === levelId);
    if (!levelConfig || !levelConfig.airdropPoints) return;

    const points = levelConfig.airdropPoints;
    const ztrBonus = points * 0.001; // Ratio: 10 ZTR per 10.000 punten

    const awardToWallet = async (wallet, type) => {
        const ref = db.ref(`users/${wallet}`);
        await ref.child('airdropPoints').transaction(p => (p || 0) + points);
        if (ztrBonus > 0) {
            await ref.child('ztrBalance').transaction(b => (b || 0) + ztrBonus);
            await ref.child('incomeHistory').push({
                amount: ztrBonus,
                type: `Airdrop ZTR Bonus (${type})`,
                date: new Date().toISOString(),
                timestamp: admin.database.ServerValue.TIMESTAMP
            });
        }
        console.log(`✅ Airdrop van ${points} punten en ${ztrBonus} ZTR toegekend aan ${wallet} (${type})`);
    };

    // Ken toe aan de gebruiker zelf
    await awardToWallet(userWallet, "Level Up");

    // Ken toe aan de inviter
    const userData = (await db.ref(`users/${userWallet}`).once('value')).val();
    if (userData && userData.inviterId) {
        const inviterWalletSnap = await db.ref(`userIdMap/${userData.inviterId}`).once('value');
        if (inviterWalletSnap.exists()) {
            await awardToWallet(inviterWalletSnap.val(), "Direct Referral");
        }
    }
    
    // Werk platformstatistieken bij
    await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + points * 2); // Eén keer voor gebruiker, één keer voor inviter
    if (ztrBonus > 0) {
        await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + ztrBonus * 2);
    }
}


/**
 * Verdeelt commissies voor registratie (Level 0).
 */
async function distributeRegistrationCommissions(inviterId, newUserId) {
    const levels = await getLevelsConfig();
    const starterPlan = levels.find(l => l.id === 0);
    if (!starterPlan) return;

    const commissionableAmount = starterPlan.price;

    // 1. Directe Commissie
    await addCommission(inviterId, commissionableAmount * 0.55, 'Starter Direct Commission');
    
    // 2. Upline Commissie
    const inviterWalletSnap = await db.ref(`userIdMap/${inviterId}`).once('value');
    if (inviterWalletSnap.exists()) {
        const inviterData = (await db.ref(`users/${inviterWalletSnap.val()}`).once('value')).val();
        if (inviterData && inviterData.inviterId) {
            await addCommission(inviterData.inviterId, commissionableAmount * 0.07, 'Starter Upline Commission');
        }
    }
    
    // 3. Team Commissie
    const teamMembersSnapshot = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
    if (teamMembersSnapshot.exists()) {
        const team = [];
        teamMembersSnapshot.forEach(snap => {
            // Zorg ervoor dat de nieuwe gebruiker geen commissie over zichzelf ontvangt
            if (snap.val().profile && snap.val().profile.userId !== newUserId) {
                team.push(snap.val().profile.userId);
            }
        });
        if (team.length > 0) {
            const share = (commissionableAmount * 0.20) / team.length;
            for (const memberId of team) {
                await addCommission(memberId, share, 'Starter Team Commission');
            }
        }
    }
}

// ==================== API ENDPOINTS ====================

app.get('/api/config', async (req, res) => {
    try {
        const levels = await getLevelsConfig();
        const registrationFee = await getRegistrationFee();
        const ztrPrice = await getZTRPrice();
        res.json({ success: true, config: { levels, registrationFee, ztrPrice, adminWallet: ADMIN_WALLET, usdtContract: USDT_CONTRACT } });
    } catch (error) {
        console.error("Fout bij /api/config:", error);
        res.status(500).json({ success: false, error: "Kon serverconfiguratie niet laden." });
    }
});

app.post('/api/register', async (req, res) => {
    const { wallet, txHash, inviterId, username, profilePic, registrationCost } = req.body;
    if (!wallet || !txHash || !inviterId || !username || !registrationCost) {
        return res.status(400).json({ success: false, error: "Ontbrekende vereiste velden." });
    }

    try {
        const walletLower = wallet.toLowerCase();
        if ((await db.ref(`users/${walletLower}`).once('value')).exists()) {
            return res.status(400).json({ success: false, error: "Gebruiker is al geregistreerd." });
        }

        const isValidTx = await verifyTransaction(txHash, wallet, ADMIN_WALLET, registrationCost);
        if (!isValidTx) {
            return res.status(400).json({ success: false, error: "Transactieverificatie mislukt. Betaling niet gevonden of ongeldig." });
        }
        
        const idRes = await db.ref('nextUserId').transaction(id => (id || 1000) + 1);
        const userId = idRes.snapshot.val();
        
        const inviteCode = (await generateInviteCode()).substring(0,8);

        const newUser = {
            profile: { name: username.substring(0, 30), userId, joinDate: new Date().toLocaleDateString('en-GB'), profilePicUrl: profilePic || null },
            inviteCode, inviterId: parseInt(inviterId), paid: true, ztrBalance: 0, airdropPoints: 0, level: 0, teamSize: 0
        };

        await db.ref(`users/${walletLower}`).set(newUser);
        await db.ref(`userIdMap/${userId}`).set(walletLower);
        await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower);

        const inviterWalletSnap = await db.ref(`userIdMap/${parseInt(inviterId)}`).once('value');
        if (inviterWalletSnap.exists()) {
            await db.ref(`users/${inviterWalletSnap.val()}/teamSize`).transaction(s => (s || 0) + 1);
        }

        await distributeRegistrationCommissions(parseInt(inviterId), userId);
        await distributeAirdropPoints(walletLower, 0); // Level 0 airdrop
        await db.ref('platformStats/totalParticipants').transaction(p => (p || 0) + 1);

        res.status(201).json({ success: true, message: "Registratie succesvol!", userId });

    } catch (error) {
        console.error("Fout bij registratie:", error);
        res.status(500).json({ success: false, error: "Een interne serverfout is opgetreden." });
    }
});

// ANDERE EINDPOINTS (onveranderd)
app.post('/api/upgrade', async (req, res) => {
    // ... bestaande logica ...
});

app.post('/api/withdraw', async (req, res) => {
    // ... bestaande logica ...
});

app.get('/api/platform-data', async (req, res) => {
    // ... bestaande logica ...
});

app.post('/api/claim-task-reward', async (req, res) => {
    // ... bestaande logica ...
});

app.get('/api/user/:wallet', async (req, res) => {
    // ... bestaande logica ...
});

app.get('/api/team/:userId', async (req, res) => {
    // ... bestaande logica ...
});


// ==================== NIEUW: SALARISSYSTEEM ====================

/**
 * Beveiligd eindpunt om wekelijkse salarissen uit te keren.
 * Moet worden aangeroepen door een geplande taak (cron job).
 */
app.post('/api/admin/distribute-salary', async (req, res) => {
    // Beveiliging: controleer op een geheime sleutel in de header
    const { authorization } = req.headers;
    if (authorization !== `Bearer ${process.env.ADMIN_SECRET_KEY}`) {
        return res.status(401).json({ success: false, error: 'Ongeautoriseerd' });
    }

    try {
        console.log("Salarisdistributieproces gestart...");
        const platformStats = (await db.ref('platformStats').once('value')).val() || {};
        const weeklyPool = platformStats.totalWeeklySalaryFund || 0;

        if (weeklyPool <= 0) {
            console.log("Salarispool is leeg. Geen distributie nodig.");
            return res.json({ success: true, message: "Salarispool is leeg." });
        }

        // 1. Vind alle in aanmerking komende gebruikers (Level 5+)
        const eligibleUsersSnap = await db.ref('users').orderByChild('level').startAt(5).once('value');
        if (!eligibleUsersSnap.exists()) {
            console.log("Geen gebruikers die in aanmerking komen voor salaris gevonden.");
            return res.json({ success: true, message: "Geen in aanmerking komende gebruikers." });
        }

        const usersData = [];
        eligibleUsersSnap.forEach(snap => {
            usersData.push({ wallet: snap.key, ...snap.val() });
        });
        
        let totalPerformanceScore = 0;
        const usersWithScores = [];

        // 2. Bereken de prestatiescore voor elke gebruiker
        for (const user of usersData) {
            let teamLevelSum = 0;
            const directTeamSnap = await db.ref('users').orderByChild('inviterId').equalTo(user.profile.userId).once('value');
            if (directTeamSnap.exists()) {
                directTeamSnap.forEach(memberSnap => {
                    teamLevelSum += (memberSnap.val().level || 0);
                });
            }
            // Formule: (eigen level * 10) + (totaal level van directe teamleden)
            const performanceScore = (user.level * 10) + teamLevelSum;
            usersWithScores.push({ ...user, performanceScore });
            totalPerformanceScore += performanceScore;
        }

        if (totalPerformanceScore === 0) {
            console.log("Totale prestatiescore is 0. Kan salaris niet verdelen.");
            return res.json({ success: true, message: "Totale prestatiescore is 0." });
        }
        
        // 3. Verdeel de pool op basis van de score
        let distributedAmount = 0;
        for (const user of usersWithScores) {
            const userShare = (user.performanceScore / totalPerformanceScore) * weeklyPool;
            if (userShare > 0) {
                const userRef = db.ref(`users/${user.wallet}`);
                await userRef.child('ztrBalance').transaction(b => (b || 0) + userShare);
                await userRef.child('salaryHistory').push({
                    amount: userShare,
                    date: new Date().toISOString(),
                    timestamp: admin.database.ServerValue.TIMESTAMP
                });
                distributedAmount += userShare;
                console.log(`Salaris van ${userShare.toFixed(4)} ZTR toegekend aan ${user.profile.userId} (Score: ${user.performanceScore})`);
            }
        }

        // 4. Reset de wekelijkse salarispool
        await db.ref('platformStats/totalWeeklySalaryFund').set(0);

        console.log(`Salarisdistributie voltooid. Totaal verdeeld: ${distributedAmount.toFixed(4)} ZTR`);
        res.json({ success: true, message: `Salarisdistributie voltooid. ${distributedAmount.toFixed(4)} ZTR verdeeld.` });

    } catch (error) {
        console.error("FATALE FOUT tijdens salarisdistributie:", error);
        res.status(500).json({ success: false, error: 'Interne serverfout tijdens salarisdistributie.' });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server draait op poort ${PORT}`));
