const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

const API_KEY = process.env.API_KEY || crypto.randomBytes(32).toString('hex');

const requireApiKey = (req, res, next) => {
    if (req.headers['x-api-key'] !== API_KEY) {
        return res.status(403).json({ success: false, error: "Unauthorized" });
    }
    next();
};

const rateLimitMap = new Map();
function rateLimiter(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    if (!rateLimitMap.has(ip)) { rateLimitMap.set(ip, { count: 1, startTime: now }); return next(); }
    const r = rateLimitMap.get(ip);
    if (now - r.startTime > 60000) { r.count = 1; r.startTime = now; return next(); }
    r.count++;
    if (r.count > 60) return res.status(429).json({ success: false, error: "Rate limit exceeded" });
    next();
}
app.use(rateLimiter);

// ==================== FIREBASE ====================
let db;
try {
    const sa = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('ascii'));
    admin.initializeApp({ credential: admin.credential.cert(sa), databaseURL: process.env.FIREBASE_DB_URL });
    db = admin.database();
    console.log("✅ Firebase ready");
} catch (e) { console.error("🔥 Firebase:", e.message); process.exit(1); }

// ==================== BLOCKCHAIN ====================
const ADMIN_WALLET = (process.env.ADMIN_WALLET || "0x97efeaa1da1108acff52840550ec51dc5bbfd812").toLowerCase();
const ADMIN_PK = process.env.ADMIN_PRIVATE_KEY || "";
const USDT_CONTRACT = (process.env.USDT_CONTRACT || "0x55d398326f99059fF775485246999027B3197955").toLowerCase();
const BSC_RPC = process.env.BSC_RPC || "https://bsc-dataseed.binance.org/";
const provider = new ethers.JsonRpcProvider(BSC_RPC);
let adminWallet = null;
if (ADMIN_PK) { try { adminWallet = new ethers.Wallet(ADMIN_PK, provider); console.log("✅ Admin wallet loaded"); } catch (e) { console.error("⚠️ Admin wallet:", e.message); } }

const usdtAbi = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)"
];
const usdtContract = new ethers.Contract(USDT_CONTRACT, usdtAbi, provider);

// ==================== CACHE ====================
let levelsCache = null, levelsCacheTime = 0, configCache = null, configCacheTime = 0;
const CACHE_TTL = 30000;

// ==================== HELPERS ====================
async function firebaseRetry(op, retries = 3, delay = 500) {
    for (let i = 0; i < retries; i++) {
        try { return await op(); }
        catch (e) { if (i === retries - 1) throw e; await new Promise(r => setTimeout(r, delay * (i + 1))); }
    }
}

async function generateInviteCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let a = 0; a < 50; a++) {
        const code = Array.from(crypto.randomBytes(8)).map(b => chars[b % chars.length]).join('');
        if (!(await db.ref(`inviteCodeMap/${code}`).once('value')).exists()) return code;
    }
    return Array.from(crypto.randomBytes(8)).map(b => chars[b % chars.length]).join('') + Date.now().toString(36).slice(-2).toUpperCase();
}

async function getLevelsConfig() {
    const now = Date.now();
    if (levelsCache && (now - levelsCacheTime) < CACHE_TTL) return levelsCache;
    const snap = await firebaseRetry(() => db.ref('config/levels').once('value'));
    let levels = snap.val();
    if (!levels || !Array.isArray(levels) || levels.length === 0) {
        levels = [
            { id: 0, name: "Starter", price: 5, salaryFund: 0.25, fee: 0, icon: "🌱", airdropPoints: 100, salary: 0, requiredTeamSize: 0 },
            { id: 1, name: "Iron", price: 5, salaryFund: 1, fee: 0.18, icon: "🛡️", airdropPoints: 100, salary: 0, requiredTeamSize: 0 },
            { id: 2, name: "Bronze", price: 10, salaryFund: 2, fee: 0.36, icon: "🥉", airdropPoints: 200, salary: 0, requiredTeamSize: 3 },
            { id: 3, name: "Silver", price: 15, salaryFund: 3, fee: 0.54, icon: "🥈", airdropPoints: 300, salary: 0, requiredTeamSize: 5 },
            { id: 4, name: "Gold", price: 20, salaryFund: 4, fee: 0.72, icon: "🥇", airdropPoints: 400, salary: 0, requiredTeamSize: 10 },
            { id: 5, name: "Master", price: 25, salaryFund: 5, fee: 0.9, icon: "👑", airdropPoints: 500, salary: 10, requiredTeamSize: 15 },
            { id: 6, name: "Grandmaster", price: 50, salaryFund: 10, fee: 1.8, icon: "⚔️", airdropPoints: 1000, salary: 25, requiredTeamSize: 25 },
            { id: 7, name: "Legend", price: 100, salaryFund: 20, fee: 3.6, icon: "🌟", airdropPoints: 2000, salary: 60, requiredTeamSize: 50 }
        ];
    }
    levelsCache = levels; levelsCacheTime = now; return levels;
}

async function getRegistrationFee() {
    const l = await getLevelsConfig();
    const s = l.find(x => x.id === 0);
    return s ? (s.price || 5) + (s.salaryFund || 0.25) + (s.fee || 0) : 5.25;
}

async function getZTRPrice() {
    const s = await firebaseRetry(() => db.ref('config/baseZTRPrice').once('value'));
    return s.exists() && typeof s.val() === 'number' ? s.val() : 1.0;
}

async function getPlatformConfig() {
    const now = Date.now();
    if (configCache && (now - configCacheTime) < CACHE_TTL) return configCache;
    const levels = await getLevelsConfig();
    configCache = { levels, registrationFee: await getRegistrationFee(), ztrPrice: await getZTRPrice(), adminWallet: ADMIN_WALLET, usdtContract: USDT_CONTRACT };
    configCacheTime = now; return configCache;
}

// ✅ FIXED: parseLog bug
async function verifyTransaction(txHash, fromWallet, toWallet, expectedAmount, tolerancePercent = 0.5) {
    try {
        if (!txHash || !ethers.isHexString(txHash, 32)) return false;
        if (!ethers.isAddress(fromWallet) || !ethers.isAddress(toWallet)) return false;
        if ((await db.ref(`usedTransactions/${txHash}`).once('value')).exists()) { console.log("❌ TX already used"); return false; }
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) return false;
        const currentBlock = await provider.getBlockNumber();
        if (currentBlock - receipt.blockNumber < 3) { console.log("❌ Low confirmations"); return false; }
        const decimals = await usdtContract.decimals();
        const expWei = ethers.parseUnits(parseFloat(expectedAmount).toFixed(Number(decimals)), decimals);
        const tol = (expWei * BigInt(Math.floor(tolerancePercent * 100))) / 10000n;
        const minR = expWei - tol, maxR = expWei + tol;
        const fl = fromWallet.toLowerCase(), tl = toWallet.toLowerCase();
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === USDT_CONTRACT) {
                try {
                    // ✅ FIX: Direct log pass karo, {topics,data} nahi
                    const parsed = usdtContract.interface.parseLog(log);
                    if (parsed && parsed.name === "Transfer") {
                        const { from, to, value } = parsed.args;
                        if (from.toLowerCase() === fl && to.toLowerCase() === tl && value >= minR && value <= maxR) {
                            await db.ref(`usedTransactions/${txHash}`).set({ from: fl, to: tl, amount: value.toString(), blockNumber: receipt.blockNumber, timestamp: admin.database.ServerValue.TIMESTAMP });
                            console.log(`✅ TX verified: ${txHash}`);
                            return true;
                        }
                    }
                } catch (e) {}
            }
        }
        return false;
    } catch (e) { console.error("❌ verifyTx:", e.message); return false; }
}

async function getUserByWallet(w) {
    if (!w || !ethers.isAddress(w)) return null;
    const s = await firebaseRetry(() => db.ref(`users/${w.toLowerCase()}`).once('value'));
    return s.exists() ? { key: w.toLowerCase(), ...s.val() } : null;
}

async function getWalletByUserId(id) {
    const s = await firebaseRetry(() => db.ref(`userIdMap/${id}`).once('value'));
    return s.exists() ? s.val() : null;
}

async function getWalletByInviteCode(code) {
    if (!code || code.length !== 8) return null;
    const s = await firebaseRetry(() => db.ref(`inviteCodeMap/${code.toUpperCase()}`).once('value'));
    return s.exists() ? s.val() : null;
}

async function addStarToLevel(rw, lid, type, srcId) {
    if (!rw || !srcId || lid === undefined) return;
    try {
        const ref = db.ref(`users/${rw.toLowerCase()}/levelStars/level_${lid}`);
        await ref.push({ type, sourceUserId: srcId, timestamp: admin.database.ServerValue.TIMESTAMP, date: new Date().toISOString() });
        const snap = await ref.once('value');
        if (snap.exists()) {
            const stars = []; snap.forEach(c => stars.push({ key: c.key, ts: c.val().timestamp || 0 }));
            if (stars.length > 10) { stars.sort((a, b) => a.ts - b.ts); for (const s of stars.slice(0, stars.length - 10)) await ref.child(s.key).remove(); }
        }
    } catch (e) {}
}

async function addCommission(uid, amount, type, starType, lid, srcId, starLid) {
    if (!uid || amount <= 0) return false;
    try {
        const w = await getWalletByUserId(uid);
        if (!w) return false;
        const wl = w.toLowerCase(), ref = db.ref(`users/${wl}`);
        await ref.child('ztrBalance').transaction(b => (b || 0) + amount);
        await ref.child('incomeHistory').push({ amount, type, date: new Date().toISOString(), timestamp: admin.database.ServerValue.TIMESTAMP, starType: starType || null, levelId: lid !== undefined ? lid : null, sourceUserId: srcId || null });
        await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + amount);
        if (starType && lid !== undefined && srcId && starLid !== undefined) await addStarToLevel(wl, starLid, starType, srcId);
        await db.ref('commissionLogs').push({ userId: uid, wallet: wl, amount, type, timestamp: admin.database.ServerValue.TIMESTAMP });
        return true;
    } catch (e) { return false; }
}

async function distributeAirdropPoints(uw, lid) {
    const lvls = await getLevelsConfig();
    const lc = lvls.find(l => l.id === lid);
    if (!lc || !(lc.airdropPoints > 0)) return;
    const pts = lc.airdropPoints, ztrB = pts * 0.001;
    const award = async (w) => {
        if (!w || !ethers.isAddress(w)) return;
        const wl = w.toLowerCase(), ref = db.ref(`users/${wl}`);
        await ref.child('airdropPoints').transaction(p => (p || 0) + pts);
        if (ztrB > 0) { await ref.child('ztrBalance').transaction(b => (b || 0) + ztrB); await ref.child('incomeHistory').push({ amount: ztrB, type: `Level ${lid} Airdrop Bonus`, date: new Date().toISOString(), timestamp: admin.database.ServerValue.TIMESTAMP }); }
        await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + pts);
        await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + ztrB);
    };
    await award(uw);
    const ud = await getUserByWallet(uw);
    if (ud && ud.inviterId) { const iw = await getWalletByUserId(ud.inviterId); if (iw) await award(iw); }
}

async function distributeRegistrationCommissions(inviterId, newUserId, newUserWallet) {
    const lvls = await getLevelsConfig();
    const sp = lvls.find(l => l.id === 0);
    if (!sp) return;
    const ca = sp.price || 5;
    await addCommission(inviterId, ca * 0.55, 'Starter Direct Commission', 'direct', 0, newUserId, 0);
    const iw = await getWalletByUserId(inviterId);
    if (iw) {
        const id = await getUserByWallet(iw);
        if (id && id.inviterId) await addCommission(id.inviterId, ca * 0.07, 'Starter Upline Commission', 'upline', 0, newUserId, 0);
        const ts = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
        if (ts.exists()) {
            const tm = []; ts.forEach(s => { const d = s.val(); if (d.profile && d.profile.userId !== newUserId) tm.push(d.profile.userId); });
            if (tm.length > 0) { const share = (ca * 0.20) / tm.length; for (const mid of tm) await addCommission(mid, share, 'Starter Team Commission', 'downline', 0, newUserId, 0); }
        }
    }
    await db.ref('commissionDistributionLogs').push({ newUserId, inviterId, commissionableAmount: ca, timestamp: admin.database.ServerValue.TIMESTAMP });
}

async function distributeUpgradeCommissions(wallet, lid, lp) {
    const ud = await getUserByWallet(wallet);
    if (!ud || !ud.inviterId) return;
    const inviterId = ud.inviterId, uid = ud.profile?.userId;
    if (!uid) return;
    await addCommission(inviterId, lp * 0.55, `Level ${lid} Direct Commission`, 'direct', lid, uid, lid);
    const iw = await getWalletByUserId(inviterId);
    if (iw) {
        const id = await getUserByWallet(iw);
        if (id && id.inviterId) await addCommission(id.inviterId, lp * 0.07, `Level ${lid} Upline Commission`, 'upline', lid, uid, lid);
    }
    const ts = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
    if (ts.exists()) {
        const tm = []; ts.forEach(s => { const d = s.val(); if (s.key !== wallet.toLowerCase() && d.profile) tm.push(d.profile.userId); });
        if (tm.length > 0) { const share = (lp * 0.20) / tm.length; for (const mid of tm) await addCommission(mid, share, `Level ${lid} Team Commission`, 'downline', lid, uid, lid); }
    }
}

// ==================== MIDDLEWARE ====================
function validateWallet(req, res, next) {
    const w = req.body.wallet || req.params.wallet;
    if (!w || !ethers.isAddress(w)) return res.status(400).json({ success: false, error: "Invalid wallet" });
    next();
}

// ==================== ROUTES ====================
app.get('/api/config', async (req, res) => {
    try { res.json({ success: true, config: await getPlatformConfig() }); }
    catch (e) { res.status(500).json({ success: false, error: "Config error" }); }
});

app.post('/api/register', validateWallet, async (req, res) => {
    const { wallet, txHash, inviterId, username, profilePic, registrationCost } = req.body;
    if (!inviterId || !username) return res.status(400).json({ success: false, error: "Missing fields" });
    if (!Number.isInteger(inviterId) || inviterId < 1000) return res.status(400).json({ success: false, error: "Invalid inviter ID" });
    if (username.length < 3 || username.length > 30) return res.status(400).json({ success: false, error: "Username 3-30 chars" });
    try {
        const wl = wallet.toLowerCase();
        if (await getUserByWallet(wallet)) return res.status(400).json({ success: false, error: "Already registered" });
        const iw = await getWalletByUserId(inviterId);
        if (!iw) return res.status(400).json({ success: false, error: "Inviter not found" });
        const regFee = await getRegistrationFee(), ztrP = await getZTRPrice();
        const cost = registrationCost || (regFee * ztrP).toFixed(2);
        if (!(await verifyTransaction(txHash, wallet, ADMIN_WALLET, cost))) return res.status(400).json({ success: false, error: "Payment verification failed" });
        const idRes = await db.ref('nextUserId').transaction(id => (id || 1000) + 1);
        if (!idRes.committed) return res.status(500).json({ success: false, error: "ID generation failed" });
        const userId = idRes.snapshot.val(), inviteCode = await generateInviteCode();
        const lvls = await getLevelsConfig();
        const st = lvls.find(l => l.id === 0);
        if (st && st.salaryFund > 0) await db.ref('platformStats/totalWeeklySalaryFund').transaction(p => (p || 0) + st.salaryFund);
        const userData = {
            profile: { name: username.substring(0, 30), userId, joinDate: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }), profilePicUrl: profilePic || null },
            inviteCode, inviterId: parseInt(inviterId), paid: true, ztrBalance: 0, airdropPoints: 0, level: 0, teamSize: 0,
            levelStars: {}, claimedTasks: {}, incomeHistory: {}, salaryHistory: {},
            registeredAt: admin.database.ServerValue.TIMESTAMP, registrationTxHash: txHash
        };
        await db.ref(`users/${wl}`).set(userData);
        await db.ref(`userIdMap/${userId}`).set(wl);
        await db.ref(`inviteCodeMap/${inviteCode}`).set(wl);
        await db.ref(`users/${iw.toLowerCase()}/teamSize`).transaction(s => (s || 0) + 1);
        await distributeRegistrationCommissions(parseInt(inviterId), userId, wl);
        await distributeAirdropPoints(wl, 0);
        await db.ref('platformStats/totalParticipants').transaction(p => (p || 0) + 1);
        await db.ref('registrationLogs').push({ userId, wallet: wl, inviterId: parseInt(inviterId), txHash, timestamp: admin.database.ServerValue.TIMESTAMP });
        console.log(`✅ Registered: ID=${userId}`);
        res.status(201).json({ success: true, userId, inviteCode, message: "Registration successful!" });
    } catch (e) { console.error("Register:", e); res.status(500).json({ success: false, error: "Registration failed" }); }
});

app.post('/api/upgrade', validateWallet, async (req, res) => {
    const { wallet, txHash, levelId, upgradeCost, levelPrice } = req.body;
    if (levelId === undefined || levelId === null) return res.status(400).json({ success: false, error: "Level ID required" });
    try {
        const wl = wallet.toLowerCase(), lvls = await getLevelsConfig();
        const lc = lvls.find(l => l.id === levelId);
        if (!lc) return res.status(400).json({ success: false, error: "Invalid level" });
        const ud = await getUserByWallet(wallet);
        if (!ud) return res.status(400).json({ success: false, error: "Not registered" });
        const cl = ud.level || 0;
        if (cl !== levelId - 1) return res.status(400).json({ success: false, error: `Sequential upgrade required. Upgrade to Level ${cl + 1} first.` });
        if (lc.requiredTeamSize && ud.teamSize < lc.requiredTeamSize) return res.status(400).json({ success: false, error: `Need ${lc.requiredTeamSize} members. You have ${ud.teamSize}.` });
        const total = (lc.price || 0) + (lc.salaryFund || 0) + (lc.fee || 0);
        const ztrP = await getZTRPrice();
        const cost = upgradeCost || (total * ztrP).toFixed(2);
        if (!(await verifyTransaction(txHash, wallet, ADMIN_WALLET, cost))) return res.status(400).json({ success: false, error: "Payment verification failed" });
        await db.ref(`users/${wl}/level`).set(levelId);
        if (lc.salaryFund > 0) await db.ref('platformStats/totalWeeklySalaryFund').transaction(p => (p || 0) + lc.salaryFund);
        await distributeAirdropPoints(wl, levelId);
        await distributeUpgradeCommissions(wl, levelId, levelPrice || lc.price || 0);
        await db.ref('upgradeLogs').push({ wallet: wl, userId: ud.profile?.userId, fromLevel: cl, toLevel: levelId, txHash, timestamp: admin.database.ServerValue.TIMESTAMP });
        console.log(`✅ Upgraded: ${ud.profile?.userId} → L${levelId}`);
        res.json({ success: true, message: `Upgraded to ${lc.name}!` });
    } catch (e) { console.error("Upgrade:", e); res.status(500).json({ success: false, error: "Upgrade failed" }); }
});

app.post('/api/withdraw', validateWallet, async (req, res) => {
    const { wallet } = req.body;
    try {
        const wl = wallet.toLowerCase(), ud = await getUserByWallet(wallet);
        if (!ud) return res.status(400).json({ success: false, error: "User not found" });
        const bal = ud.ztrBalance || 0;
        if (bal < 10) return res.status(400).json({ success: false, error: `Min 10 ZTR. Balance: ${bal.toFixed(2)}` });
        const ps = await db.ref('withdrawals').orderByChild('userWallet').equalTo(wl).once('value');
        let hp = false;
        if (ps.exists()) ps.forEach(c => { if (c.val().status === 'pending') hp = true; });
        if (hp) return res.status(400).json({ success: false, error: "Pending withdrawal exists" });
        const wRef = await db.ref('withdrawals').push({ userWallet: wl, userId: ud.profile?.userId, amount: bal, status: 'pending', requestedAt: admin.database.ServerValue.TIMESTAMP, date: new Date().toISOString() });
        await db.ref(`users/${wl}/ztrBalance`).set(0);
        await db.ref(`users/${wl}/incomeHistory`).push({ amount: -bal, type: 'Withdrawal Request', date: new Date().toISOString(), timestamp: admin.database.ServerValue.TIMESTAMP, withdrawalId: wRef.key });
        await db.ref('withdrawalLogs').push({ withdrawalId: wRef.key, userWallet: wl, userId: ud.profile?.userId, amount: bal, status: 'pending', timestamp: admin.database.ServerValue.TIMESTAMP });
        console.log(`✅ Withdrawal: ${bal} ZTR from ${wl}`);
        res.json({ success: true, message: `Request for ${bal.toFixed(2)} ZTR submitted.`, withdrawalId: wRef.key });
    } catch (e) { console.error("Withdraw:", e); res.status(500).json({ success: false, error: "Withdrawal failed" }); }
});

app.post('/api/claim-task-reward', validateWallet, async (req, res) => {
    const { wallet, taskRequired, taskPoints } = req.body;
    if (!taskRequired || !taskPoints) return res.status(400).json({ success: false, error: "Missing task details" });
    try {
        const wl = wallet.toLowerCase(), ud = await getUserByWallet(wallet);
        if (!ud) return res.status(400).json({ success: false, error: "User not found" });
        if ((ud.teamSize || 0) < taskRequired) return res.status(400).json({ success: false, error: `Need ${taskRequired} members. You have ${ud.teamSize || 0}.` });
        const tk = `task_${taskRequired}`;
        if (ud.claimedTasks && ud.claimedTasks[tk]) return res.status(400).json({ success: false, error: "Already claimed" });
        const ztrB = taskPoints * 0.001;
        const ref = db.ref(`users/${wl}`);
        await ref.child(`claimedTasks/${tk}`).set(true);
        await ref.child(`claimedTasks/${tk}_claimedAt`).set(admin.database.ServerValue.TIMESTAMP);
        await ref.child('airdropPoints').transaction(p => (p || 0) + taskPoints);
        await ref.child('ztrBalance').transaction(b => (b || 0) + ztrB);
        await db.ref('platformStats/totalAirdropDistributed').transaction(p => (p || 0) + taskPoints);
        await db.ref('platformStats/totalZTRDistributed').transaction(t => (t || 0) + ztrB);
        await db.ref('taskClaimLogs').push({ wallet: wl, userId: ud.profile?.userId, taskRequired, points: taskPoints, ztrBonus: ztrB, timestamp: admin.database.ServerValue.TIMESTAMP });
        res.json({ success: true, message: `Claimed ${taskPoints} pts + ${ztrB} ZTR!`, points: taskPoints, ztrBonus: ztrB });
    } catch (e) { console.error("Task:", e); res.status(500).json({ success: false, error: "Claim failed" }); }
});

app.get('/api/user/:wallet', async (req, res) => {
    const { wallet } = req.params;
    if (!ethers.isAddress(wallet)) return res.status(400).json({ success: false, error: "Invalid wallet" });
    try {
        const ud = await getUserByWallet(wallet);
        if (!ud) return res.status(404).json({ success: false, error: "User not found" });
        const lvls = await getLevelsConfig();
        res.json({ success: true, user: { profile: ud.profile, level: ud.level || 0, levelInfo: lvls.find(l => l.id === (ud.level || 0)) || lvls[0], ztrBalance: ud.ztrBalance || 0, airdropPoints: ud.airdropPoints || 0, teamSize: ud.teamSize || 0, inviteCode: ud.inviteCode || '', inviterId: ud.inviterId || null, levelStars: ud.levelStars || {}, claimedTasks: ud.claimedTasks || {}, paid: ud.paid || false } });
    } catch (e) { res.status(500).json({ success: false, error: "Failed" }); }
});

app.get('/api/team/:userId', async (req, res) => {
    const uid = parseInt(req.params.userId);
    if (!uid || uid < 1000) return res.status(400).json({ success: false, error: "Invalid user ID" });
    try {
        const ts = await db.ref('users').orderByChild('inviterId').equalTo(uid).once('value');
        const team = [];
        if (ts.exists()) ts.forEach(s => { const d = s.val(); if (d.profile) team.push({ wallet: s.key, profile: d.profile, level: d.level || 0 }); });
        res.json({ success: true, team });
    } catch (e) { res.status(500).json({ success: false, error: "Failed" }); }
});

app.get('/api/platform-data', async (req, res) => {
    try {
        const ss = (await db.ref('platformStats').once('value')).val() || {};
        const sas = await db.ref('users').orderByChild('level').startAt(5).once('value');
        ss.salaryActiveMembers = sas.numChildren();
        const lb = [];
        const tus = await db.ref('users').orderByChild('ztrBalance').limitToLast(100).once('value');
        if (tus.exists()) tus.forEach(s => { const d = s.val(); if (d.profile && (d.ztrBalance || 0) > 0) lb.push({ name: d.profile.name, userId: d.profile.userId, profilePicUrl: d.profile.profilePicUrl || null, earnings: d.ztrBalance || 0 }); });
        lb.sort((a, b) => b.earnings - a.earnings);
        res.json({ success: true, stats: ss, leaderboard: lb.slice(0, 100) });
    } catch (e) { res.status(500).json({ success: false, error: "Failed" }); }
});

app.get('/api/invite-info/:code', async (req, res) => {
    const code = req.params.code?.toUpperCase();
    if (!code || code.length !== 8) return res.status(400).json({ success: false, error: "Invalid code" });
    try {
        const w = await getWalletByInviteCode(code);
        if (!w) return res.status(404).json({ success: false, error: "Code not found" });
        const ud = await getUserByWallet(w);
        if (!ud?.profile) return res.status(404).json({ success: false, error: "Inviter not found" });
        res.json({ success: true, inviter: { name: ud.profile.name, userId: ud.profile.userId, profilePicUrl: ud.profile.profilePicUrl || null } });
    } catch (e) { res.status(500).json({ success: false, error: "Failed" }); }
});

app.get('/api/health', async (req, res) => {
    try {
        await db.ref('.info/connected').once('value');
        const bn = await provider.getBlockNumber();
        res.json({ success: true, status: 'healthy', timestamp: new Date().toISOString(), blockNumber: bn, adminWalletConfigured: !!ADMIN_PK });
    } catch (e) { res.status(500).json({ success: false, status: 'unhealthy', error: e.message }); }
});

app.get('/api/admin/stats', requireApiKey, async (req, res) => {
    try {
        const [ss, us, ws] = await Promise.all([db.ref('platformStats').once('value'), db.ref('users').once('value'), db.ref('withdrawals').orderByChild('status').equalTo('pending').once('value')]);
        const stats = ss.val() || {};
        let circ = 0; const ubl = {};
        us.forEach(s => { circ += (s.val().ztrBalance || 0); const l = s.val().level || 0; ubl[l] = (ubl[l] || 0) + 1; });
        res.json({ success: true, stats: { ...stats, totalUsers: us.numChildren(), totalZTRInCirculation: circ, pendingWithdrawals: ws.numChildren(), usersByLevel: ubl } });
    } catch (e) { res.status(500).json({ success: false, error: "Failed" }); }
});

app.post('/api/admin/process-withdrawal', requireApiKey, async (req, res) => {
    const { withdrawalId, action, txHash } = req.body;
    if (!withdrawalId || !action || !['approve', 'reject'].includes(action)) return res.status(400).json({ success: false, error: "Invalid params" });
    try {
        const ref = db.ref(`withdrawals/${withdrawalId}`);
        const snap = await ref.once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, error: "Not found" });
        const w = snap.val();
        if (w.status !== 'pending') return res.status(400).json({ success: false, error: `Already ${w.status}` });
        if (action === 'reject') {
            await db.ref(`users/${w.userWallet}/ztrBalance`).transaction(b => (b || 0) + w.amount);
            await ref.update({ status: 'rejected', rejectedAt: admin.database.ServerValue.TIMESTAMP, rejectionReason: req.body.reason || 'Rejected' });
            await db.ref(`users/${w.userWallet}/incomeHistory`).push({ amount: w.amount, type: 'Withdrawal Rejected (Returned)', date: new Date().toISOString(), timestamp: admin.database.ServerValue.TIMESTAMP });
            return res.json({ success: true, message: "Rejected. Funds returned." });
        }
        if (txHash) { await ref.update({ status: 'completed', approvedAt: admin.database.ServerValue.TIMESTAMP, txHash }); return res.json({ success: true, message: "Completed." }); }
        if (!adminWallet) return res.status(500).json({ success: false, error: "Admin wallet not configured" });
        const usdtS = new ethers.Contract(USDT_CONTRACT, usdtAbi, adminWallet);
        const zp = await getZTRPrice();
        const amt = ethers.parseUnits((w.amount * zp).toFixed(2), await usdtContract.decimals());
        if ((await usdtContract.balanceOf(ADMIN_WALLET)) < amt) return res.status(500).json({ success: false, error: "Insufficient USDT" });
        const tx = await usdtS.transfer(w.userWallet, amt); await tx.wait();
        await ref.update({ status: 'completed', approvedAt: admin.database.ServerValue.TIMESTAMP, txHash: tx.hash, usdtAmount: ethers.formatUnits(amt, await usdtContract.decimals()) });
        console.log(`✅ Withdrawal processed: ${w.amount} ZTR`);
        res.json({ success: true, message: "Processed", txHash: tx.hash });
    } catch (e) { console.error("Process withdrawal:", e); res.status(500).json({ success: false, error: "Failed" }); }
});

app.use((req, res) => res.status(404).json({ success: false, error: "API endpoint not found" }));
app.use((err, req, res, next) => { console.error("Error:", err); res.status(500).json({ success: false, error: "Internal server error" }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 ZTR Backend on port ${PORT}`));
