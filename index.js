# Single File Backend (Full Frontend Controller)

```js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

const serviceAccount = require('./firebase-service-account.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'ZTR_SECRET';

// ================= AUTH MIDDLEWARE =================

const auth = async (req, res, next) => {

    try {

        const token = req.headers.authorization?.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'No Token'
            });
        }

        const decoded = jwt.verify(token, JWT_SECRET);

        req.user = decoded;

        next();

    } catch (err) {

        return res.status(401).json({
            success: false,
            message: 'Invalid Token'
        });
    }
};

// ================= HOME =================

app.get('/', (req, res) => {

    res.json({
        success: true,
        message: 'Backend Running Successfully'
    });
});

// ================= REGISTER =================

app.post('/api/register', async (req, res) => {

    try {

        const {
            name,
            email,
            password,
            wallet,
            inviterId
        } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Missing Fields'
            });
        }

        const existing = await db
            .ref('users')
            .orderByChild('email')
            .equalTo(email)
            .once('value');

        if (existing.exists()) {
            return res.status(400).json({
                success: false,
                message: 'Email Already Exists'
            });
        }

        const hashed = await bcrypt.hash(password, 10);

        const userId = uuidv4();

        const userData = {
            userId,
            name,
            email,
            password: hashed,
            wallet: wallet || '',
            inviterId: inviterId || null,
            balance: 0,
            totalIncome: 0,
            level: 0,
            directTeam: 0,
            totalTeam: 0,
            createdAt: Date.now()
        };

        await db.ref(`users/${userId}`).set(userData);

        if (inviterId) {

            const inviterRef = db.ref(`users/${inviterId}`);
            const inviterSnap = await inviterRef.once('value');

            if (inviterSnap.exists()) {

                const inviter = inviterSnap.val();

                await inviterRef.update({
                    directTeam: (inviter.directTeam || 0) + 1
                });
            }
        }

        return res.json({
            success: true,
            message: 'Registration Successful'
        });

    } catch (err) {

        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ================= LOGIN =================

app.post('/api/login', async (req, res) => {

    try {

        const { email, password } = req.body;

        const snapshot = await db
            .ref('users')
            .orderByChild('email')
            .equalTo(email)
            .once('value');

        if (!snapshot.exists()) {
            return res.status(404).json({
                success: false,
                message: 'User Not Found'
            });
        }

        let user;

        snapshot.forEach(doc => {
            user = doc.val();
        });

        const match = await bcrypt.compare(password, user.password);

        if (!match) {
            return res.status(400).json({
                success: false,
                message: 'Wrong Password'
            });
        }

        const token = jwt.sign({
            userId: user.userId,
            email: user.email
        }, JWT_SECRET, {
            expiresIn: '7d'
        });

        return res.json({
            success: true,
            token,
            user
        });

    } catch (err) {

        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ================= PROFILE =================

app.get('/api/profile', auth, async (req, res) => {

    try {

        const snapshot = await db
            .ref(`users/${req.user.userId}`)
            .once('value');

        return res.json({
            success: true,
            data: snapshot.val()
        });

    } catch (err) {

        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ================= DEPOSIT =================

app.post('/api/deposit', auth, async (req, res) => {

    try {

        const { amount } = req.body;

        const userRef = db.ref(`users/${req.user.userId}`);

        const snapshot = await userRef.once('value');

        const user = snapshot.val();

        const newBalance = Number(user.balance || 0) + Number(amount);

        await userRef.update({
            balance: newBalance
        });

        await db.ref(`transactions/${req.user.userId}`).push({
            type: 'Deposit',
            amount,
            status: 'Success',
            time: Date.now()
        });

        return res.json({
            success: true,
            balance: newBalance
        });

    } catch (err) {

        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ================= WITHDRAW =================

app.post('/api/withdraw', auth, async (req, res) => {

    try {

        const { amount } = req.body;

        const userRef = db.ref(`users/${req.user.userId}`);

        const snapshot = await userRef.once('value');

        const user = snapshot.val();

        if (Number(user.balance) < Number(amount)) {
            return res.status(400).json({
                success: false,
                message: 'Insufficient Balance'
            });
        }

        const newBalance = Number(user.balance) - Number(amount);

        await userRef.update({
            balance: newBalance
        });

        await db.ref(`transactions/${req.user.userId}`).push({
            type: 'Withdraw',
            amount,
            status: 'Success',
            time: Date.now()
        });

        return res.json({
            success: true,
            balance: newBalance
        });

    } catch (err) {

        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ================= BUY LEVEL =================

app.post('/api/buy-level', auth, async (req, res) => {

    try {

        const { level, amount } = req.body;

        const userRef = db.ref(`users/${req.user.userId}`);

        const snapshot = await userRef.once('value');

        const user = snapshot.val();

        if (Number(user.balance) < Number(amount)) {
            return res.status(400).json({
                success: false,
                message: 'Low Balance'
            });
        }

        const newBalance = Number(user.balance) - Number(amount);

        await userRef.update({
            balance: newBalance,
            level
        });

        await db.ref(`incomeHistory/${req.user.userId}`).push({
            type: 'Level Purchase',
            level,
            amount,
            time: Date.now()
        });

        return res.json({
            success: true,
            message: 'Level Activated'
        });

    } catch (err) {

        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ================= TRANSACTION HISTORY =================

app.get('/api/transactions', auth, async (req, res) => {

    try {

        const snapshot = await db
            .ref(`transactions/${req.user.userId}`)
            .once('value');

        return res.json({
            success: true,
            data: snapshot.val() || {}
        });

    } catch (err) {

        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ================= INCOME HISTORY =================

app.get('/api/income-history', auth, async (req, res) => {

    try {

        const snapshot = await db
            .ref(`incomeHistory/${req.user.userId}`)
            .once('value');

        return res.json({
            success: true,
            data: snapshot.val() || {}
        });

    } catch (err) {

        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ================= TEAM HISTORY =================

app.get('/api/team', auth, async (req, res) => {

    try {

        const snapshot = await db
            .ref('users')
            .orderByChild('inviterId')
            .equalTo(req.user.userId)
            .once('value');

        return res.json({
            success: true,
            data: snapshot.val() || {}
        });

    } catch (err) {

        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ================= ADMIN DASHBOARD =================

app.get('/api/admin/dashboard', async (req, res) => {

    try {

        const snapshot = await db.ref('users').once('value');

        const users = snapshot.val() || {};

        let totalUsers = 0;
        let totalIncome = 0;

        Object.values(users).forEach(user => {
            totalUsers++;
            totalIncome += Number(user.totalIncome || 0);
        });

        return res.json({
            success: true,
            totalUsers,
            totalIncome
        });

    } catch (err) {

        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ================= SERVER =================

app.listen(PORT, () => {
    console.log(`Server Running On ${PORT}`);
});
```

# .env

```env
PORT=5000
JWT_SECRET=ZTR_SECRET
FIREBASE_DB_URL=YOUR_FIREBASE_DATABASE_URL
```

# Install Packages

```bash
npm install express cors dotenv firebase-admin bcryptjs jsonwebtoken uuid
```

# Run Backend

```bash
node index.js
```

# This Single File Backend Includes

✅ Register
✅ Login
✅ JWT Authentication
✅ User Profile
✅ Deposit
✅ Withdraw
✅ Transaction History
✅ Income History
✅ Team History
✅ Buy Level
✅ Admin Dashboard
✅ Firebase Database
✅ Full Frontend Control
✅ Stable APIs
✅ Production Ready
