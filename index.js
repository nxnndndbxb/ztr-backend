const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Configuración del Administrador de Firebase desde Base64
try {
    const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!serviceAccountBase64) {
        throw new Error("ERROR FATAL: La variable de entorno FIREBASE_SERVICE_ACCOUNT_BASE64 no está configurada.");
    }
    const serviceAccountBuffer = Buffer.from(serviceAccountBase64, 'base64');
    const serviceAccount = JSON.parse(serviceAccountBuffer.toString('utf-8'));

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DB_URL
    });
} catch (error) {
    console.error("Falló la inicialización del Administrador de Firebase:", error.message);
    process.exit(1); // Detiene la aplicación si la configuración de Firebase es incorrecta
}

const db = admin.database();
const ADMIN_WALLET = "0x97efeaa1da1108acff52840550ec51dc5bbfd812";
const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";

// Proveedor de solo lectura para la verificación de transacciones
const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/");

const usdtAbi = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function decimals() view returns (uint8)"
];
const usdtContract = new ethers.Contract(USDT_CONTRACT, usdtAbi, provider);

/**
 * Valida un formato de dirección de billetera de Ethereum.
 * @param {string} address La dirección a validar.
 * @returns {boolean}
 */
function isValidWalletAddress(address) {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Verifica una transacción USDT en la red BSC.
 * @param {string} txHash El hash de la transacción.
 * @param {string} fromWallet La billetera del remitente.
 * @param {string} toWallet La billetera del receptor.
 * @param {number|string} expectedAmount La cantidad mínima esperada en USDT.
 * @returns {Promise<boolean>}
 */
async function verifyTransaction(txHash, fromWallet, toWallet, expectedAmount) {
    try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) {
            console.log(`Verificación fallida para ${txHash}: Recibo inválido o transacción fallida.`);
            return false;
        }
        const decimals = await usdtContract.decimals();
        const expectedAmountWei = ethers.parseUnits(expectedAmount.toString(), Number(decimals));

        return receipt.logs.some(log => {
            if (log.address.toLowerCase() !== USDT_CONTRACT.toLowerCase()) {
                return false;
            }
            try {
                const parsedLog = usdtContract.interface.parseLog(log);
                if (parsedLog && parsedLog.name === "Transfer") {
                    const { from, to, value } = parsedLog.args;
                    return (
                        from.toLowerCase() === fromWallet.toLowerCase() &&
                        to.toLowerCase() === toWallet.toLowerCase() &&
                        value >= expectedAmountWei
                    );
                }
            } catch (e) {
                // Ignora los logs que no son eventos de Transferencia
            }
            return false;
        });
    } catch (e) {
        console.error(`Error al verificar la transacción ${txHash}:`, e);
        return false;
    }
}


/**
 * Genera un código de invitación único de 8 caracteres.
 * @returns {Promise<string>}
 */
async function generateInviteCode() {
    let code;
    let isUnique = false;
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    while (!isUnique) {
        code = Array.from({ length: 8 }, () => characters.charAt(Math.floor(Math.random() * characters.length))).join('');
        const snapshot = await db.ref(`inviteCodeMap/${code}`).once('value');
        if (!snapshot.exists()) {
            isUnique = true;
        }
    }
    return code;
}


/**
 * Distribuye las comisiones de registro a la red.
 * @param {number} inviterId El ID de usuario del invitador.
 * @param {number} registrationCost El costo total del registro.
 */
async function distributeCommissions(inviterId, registrationCost) {
    console.log(`Iniciando distribución de comisiones para el ID de invitador: ${inviterId}`);
    
    const configSnapshot = await db.ref('config').once('value');
    const config = configSnapshot.val();
    
    if (!config || !Array.isArray(config.levels) || !config.levels[0] || typeof config.levels[0].price !== 'number') {
        console.error("FATAL: El precio del Nivel 1 no está configurado correctamente en la base de datos. No se pueden distribuir las comisiones.");
        return;
    }
    const commissionableAmountInZTR = config.levels[0].price;

    console.log(`Cantidad comisionable: ${commissionableAmountInZTR} ZTR`);

    const addCommission = async (userId, amount, type) => {
        if (!userId || isNaN(userId) || amount <= 0) return;
        const walletSnapshot = await db.ref(`userIdMap/${userId}`).once('value');
        if (!walletSnapshot.exists()) return;
        
        const wallet = walletSnapshot.val();
        const userRef = db.ref(`users/${wallet}`);
        
        await userRef.child('ztrBalance').transaction(balance => (balance || 0) + amount);
        await userRef.child('incomeHistory').push({
            amount: amount,
            type: type,
            date: new Date().toISOString()
        });
        console.log(`Acreditado ${amount} ZTR al ID de Usuario ${userId} (${type})`);
    };

    const directCommission = commissionableAmountInZTR * 0.55;
    await addCommission(inviterId, directCommission, 'Comisión Directa');

    const inviterWalletSnapshot = await db.ref(`userIdMap/${inviterId}`).once('value');
    if (inviterWalletSnapshot.exists()) {
        const inviterWallet = inviterWalletSnapshot.val();
        const inviterData = (await db.ref(`users/${inviterWallet}`).once('value')).val();
        if (inviterData && inviterData.inviterId) {
            const uplineId = inviterData.inviterId;
            const uplineCommission = commissionableAmountInZTR * 0.07;
            await addCommission(uplineId, uplineCommission, 'Comisión de Upline');
        }
    }

    const teamCommissionPool = commissionableAmountInZTR * 0.20;
    const teamMembersSnapshot = await db.ref('users').orderByChild('inviterId').equalTo(inviterId).once('value');
    
    if (teamMembersSnapshot.exists()) {
        const teamWallets = [];
        teamMembersSnapshot.forEach(child => {
            // Asegúrate de que solo los miembros existentes del equipo (no el nuevo usuario) reciban esto
            if (child.val() && child.val().profile) {
                 teamWallets.push(child.key);
            }
        });

        if (teamWallets.length > 0) {
            const sharePerMember = teamCommissionPool / teamWallets.length;
            for (const memberWallet of teamWallets) {
                const memberUserId = (await db.ref(`users/${memberWallet}/profile/userId`).once('value')).val();
                if (memberUserId) {
                   await addCommission(memberUserId, sharePerMember, 'Comisión de Equipo');
                }
            }
        }
    }
}


/**
 * Distribuye puntos de airdrop por una mejora de nivel.
 * @param {string} userWallet Billetera del usuario que mejora.
 * @param {number} levelId ID del nivel al que se mejora.
 */
async function distributeAirdropPoints(userWallet, levelId) {
    console.log(`Distribuyendo puntos de airdrop para la billetera ${userWallet} que mejora al nivel ${levelId}`);

    const levels = (await db.ref('config/levels').once('value')).val();
    if (!Array.isArray(levels)) {
        console.log("No se pudieron distribuir los puntos de airdrop: 'config/levels' no es un array.");
        return;
    }
    const levelConfig = levels.find(l => l.id === levelId);

    if (!levelConfig || typeof levelConfig.airdropPoints !== 'number' || levelConfig.airdropPoints <= 0) {
        console.log(`No hay puntos de airdrop configurados para el nivel ${levelId}.`);
        return;
    }

    const points = levelConfig.airdropPoints;
    const userWalletLower = userWallet.toLowerCase();
    const userRef = db.ref(`users/${userWalletLower}`);
    await userRef.child('airdropPoints').transaction(currentPoints => (currentPoints || 0) + points);
    console.log(`Otorgados ${points} puntos de airdrop a ${userWalletLower}`);

    const userData = (await userRef.once('value')).val();
    if (userData && userData.inviterId) {
        const inviterWallet = (await db.ref(`userIdMap/${userData.inviterId}`).once('value')).val();
        if (inviterWallet) {
            const inviterRef = db.ref(`users/${inviterWallet}`);
            await inviterRef.child('airdropPoints').transaction(currentPoints => (currentPoints || 0) + points);
            console.log(`Otorgados ${points} puntos de airdrop al invitador ${inviterWallet}`);
        }
    }
}

// --- ENDPOINTS DE LA API ---

app.post('/api/register', async (req, res) => {
    const { wallet, txHash, inviterId, username, profilePic, registrationCost } = req.body;
    
    if (!wallet || !txHash || !inviterId || !username || !registrationCost || !isValidWalletAddress(wallet)) {
        return res.status(400).json({ success: false, error: "Faltan campos requeridos o la billetera es inválida." });
    }

    try {
        const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, registrationCost); 
        if (!isValid) {
            return res.status(400).json({ success: false, error: "La verificación de la transacción falló." });
        }

        const walletLower = wallet.toLowerCase();
        const userRef = db.ref(`users/${walletLower}`);
        
        const snapshot = await userRef.once('value');
        if (snapshot.exists() && snapshot.val().profile) {
            return res.status(400).json({ success: false, error: "El usuario ya está registrado." });
        }
        
        const nextIdRef = db.ref('nextUserId');
        const idResult = await nextIdRef.transaction(currentId => (currentId || 1000) + 1);
        if (!idResult.committed) {
             throw new Error("No se pudo generar un nuevo ID de usuario.");
        }
        const userId = idResult.snapshot.val();
        
        const inviteCode = await generateInviteCode();
        const parsedInviterId = parseInt(inviterId, 10);

        const fullUserRecord = {
            profile: {
                name: username, userId,
                joinDate: new Date().toLocaleDateString('en-GB'),
                profilePicUrl: profilePic || null, avatar: 'fa-user-astronaut'
            },
            inviteCode, inviterId: parsedInviterId, paid: true,
            ztrBalance: 0, airdropPoints: 100, level: 1, teamSize: 0
        };

        await userRef.set(fullUserRecord); 
        await db.ref(`userIdMap/${userId}`).set(walletLower);
        await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower);

        const inviterWallet = (await db.ref(`userIdMap/${parsedInviterId}`).once('value')).val();
        if(inviterWallet) {
            await db.ref(`users/${inviterWallet}/teamSize`).transaction(size => (size || 0) + 1);
        }

        await distributeCommissions(parsedInviterId, parseFloat(registrationCost));
        
        // Aumentar el recuento total de usuarios para las estadísticas
        await db.ref('platformStats/totalParticipants').transaction(count => (count || 0) + 1);

        res.status(201).json({ success: true, profile: fullUserRecord.profile });

    } catch (error) {
        console.error("Registro fallido:", error);
        res.status(500).json({ success: false, error: "Ocurrió un error interno en el servidor." });
    }
});


app.post('/api/upgrade', async (req, res) => {
    const { wallet, txHash, levelId, upgradeCost } = req.body;

    if (!wallet || !txHash || !levelId || !upgradeCost || !isValidWalletAddress(wallet)) {
        return res.status(400).json({ success: false, error: "Faltan campos requeridos para la mejora o la billetera es inválida." });
    }

    try {
        const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, upgradeCost);
        if (!isValid) {
            return res.status(400).json({ success: false, error: "La verificación del pago para la mejora falló" });
        }

        const walletLower = wallet.toLowerCase();
        const userRef = db.ref(`users/${walletLower}`);

        // Verificar que el usuario exista y esté mejorando al siguiente nivel
        const userSnap = await userRef.child('level').once('value');
        if (!userSnap.exists() || userSnap.val() !== levelId - 1) {
            return res.status(400).json({ success: false, error: "Mejora de nivel no válida." });
        }
        
        const levels = (await db.ref('config/levels').once('value')).val();
        if (Array.isArray(levels)) {
            const levelConfig = levels.find(l => l.id === levelId);
            if (levelConfig && typeof levelConfig.salaryFund === 'number' && levelConfig.salaryFund > 0) {
                // Agregar al fondo de salarios y al total distribuido
                await db.ref('currentWeek/salaryPool').transaction(pool => (pool || 0) + levelConfig.salaryFund);
                await db.ref('platformStats/totalZTRDistributed').transaction(total => (total || 0) + levelConfig.price);
            }
            if (levelConfig.id >= 5) {
                await db.ref('platformStats/salaryActiveMembers').transaction(count => (count || 0) + 1);
            }
        }

        await userRef.child('level').set(levelId);
        await distributeAirdropPoints(walletLower, levelId);

        res.json({ success: true, message: "Mejora exitosa." });
    } catch (error) {
        console.error("El proceso de mejora falló:", error);
        res.status(500).json({ success: false, error: "Ocurrió un error interno en el servidor durante la mejora." });
    }
});


app.post('/api/withdraw', async (req, res) => {
    const { wallet } = req.body;
    if (!wallet || !isValidWalletAddress(wallet)) {
        return res.status(400).json({ success: false, error: "Dirección de billetera no válida." });
    }

    try {
        const userRef = db.ref(`users/${wallet.toLowerCase()}`);
        const snap = await userRef.once('value');
        const userData = snap.val();
        
        if (!userData || !userData.ztrBalance || userData.ztrBalance <= 0) {
            return res.status(400).json({ success: false, error: "No hay saldo para retirar." });
        }
        
        const withdrawalRequest = { 
            userWallet: wallet.toLowerCase(), amount: userData.ztrBalance, 
            status: 'pending', date: new Date().toISOString() 
        };

        await db.ref('withdrawals').push(withdrawalRequest);
        await userRef.child('ztrBalance').set(0);
        
        res.json({ success: true, message: "Solicitud de retiro enviada." });
    } catch (error) {
        console.error("La solicitud de retiro falló:", error);
        res.status(500).json({ success: false, error: "Ocurrió un error interno en el servidor." });
    }
});


app.post('/api/admin/distribute-salary', async (req, res) => {
    const { secret } = req.body;
    if (secret !== process.env.ADMIN_SECRET_KEY) {
        return res.status(403).json({ success: false, error: "No autorizado." });
    }

    console.log("--- Iniciando la Distribución Semanal de Salarios ---");
    try {
        const salaryPoolRef = db.ref('currentWeek/salaryPool');
        const salaryPoolSnap = await salaryPoolRef.once('value');
        const totalSalaryPool = salaryPoolSnap.val() || 0;

        if (totalSalaryPool <= 0) {
            console.log("El fondo de salarios está vacío. No se distribuye nada.");
            return res.json({ success: true, message: "El fondo de salarios está vacío." });
        }

        const distributablePool = totalSalaryPool * 0.90;
        console.log(`Fondo Total: ${totalSalaryPool} ZTR, Distribuible: ${distributablePool} ZTR`);

        const usersSnapshot = await db.ref('users').orderByChild('level').startAt(5).once('value');
        if (!usersSnapshot.exists()) {
            await salaryPoolRef.set(0); // Limpiar el fondo aunque nadie sea elegible
            console.log("No se encontraron miembros elegibles para el salario.");
            return res.json({ success: true, message: "No se encontraron miembros elegibles." });
        }

        const eligibleUsers = [];
        let totalPerformanceScore = 0;
        
        const usersData = usersSnapshot.val();
        const userWallets = Object.keys(usersData);

        await Promise.all(userWallets.map(async (wallet) => {
            const user = usersData[wallet];
            if (user && user.profile) {
                let performanceScore = user.level || 0; // Puntuación base
                const directTeamSnapshot = await db.ref('users').orderByChild('inviterId').equalTo(user.profile.userId).once('value');
                if (directTeamSnapshot.exists()) {
                    directTeamSnapshot.forEach(memberSnap => {
                        performanceScore += (memberSnap.val().level || 0);
                    });
                }
                
                totalPerformanceScore += performanceScore;
                eligibleUsers.push({ wallet, performanceScore, userId: user.profile.userId });
            }
        }));

        if (totalPerformanceScore <= 0) {
            await salaryPoolRef.set(0);
            console.log("No se encontró actividad de rendimiento entre los usuarios elegibles.");
            return res.json({ success: true, message: "No se encontró actividad de rendimiento entre los usuarios elegibles." });
        }

        console.log(`Puntuación Total de Rendimiento: ${totalPerformanceScore}`);
        
        await Promise.all(eligibleUsers.map(async (user) => {
            const userShare = (user.performanceScore / totalPerformanceScore) * distributablePool;
            if (userShare > 0) {
                const userRef = db.ref(`users/${user.wallet}`);
                await userRef.child('ztrBalance').transaction(balance => (balance || 0) + userShare);
                await userRef.child('salaryHistory').push({
                    amount: userShare,
                    date: new Date().toISOString(),
                    performanceScore: user.performanceScore
                });
                console.log(`Distribuido ${userShare.toFixed(4)} ZTR al ID de Usuario ${user.userId}`);
            }
        }));
        
        await db.ref('platformStats/totalWeeklySalaryFund').set(totalSalaryPool);
        await salaryPoolRef.set(0); // Restablecer el fondo
        
        console.log("--- Distribución Semanal de Salarios Completa ---");
        res.json({ success: true, message: `Salario distribuido exitosamente.` });

    } catch (error) {
        console.error("La distribución de salarios falló:", error);
        res.status(500).json({ success: false, error: "Ocurrió un error interno en el servidor." });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));```
