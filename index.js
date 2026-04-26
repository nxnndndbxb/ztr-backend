// --- FILE: index.js ---

// ... (sara purana code waise hi rakhein)

// --- API ENDPOINTS ---

// 1. User Registration (After Payment)
app.post('/api/register', async (req, res) => {
    // FIX 1: 'amountPaid' ko request body se hasil karein.
    const { wallet, txHash, inviterId, username, profilePic, amountPaid } = req.body;
    
    // FIX 2: Check karein ke 'amountPaid' field mojood hai.
    if (!wallet || !txHash || !inviterId || !username || !amountPaid) {
        return res.status(400).json({ success: false, error: "Missing required fields." });
    }

    // --- YEH SAB SE ZAROORI FIX HAI ---
    // FIX 3: Verification ke liye hardcoded "JOINING_FEE_USDT" ki jagah frontend se aane wala 'amountPaid' istemal karein.
    const isValid = await verifyTransaction(txHash, wallet, ADMIN_WALLET, amountPaid.toString()); 
    if (!isValid) {
        return res.status(400).json({ success: false, error: "Transaction verification failed. Please ensure the correct amount was sent." });
    }

    const walletLower = wallet.toLowerCase();
    const userRef = db.ref(`users/${walletLower}`);
    
    const snapshot = await userRef.once('value');
    if (snapshot.exists()) {
        return res.status(400).json({ success: false, error: "User is already registered." });
    }

    try {
        // ... (baaqi ka code bilkul same rahega)
        
        const nextIdRef = db.ref('nextUserId');
        const idResult = await nextIdRef.transaction(currentId => (currentId || 1000) + 1);
        if (!idResult.committed) {
             throw new Error("Could not generate new user ID.");
        }
        const userId = idResult.snapshot.val();
        
        const inviteCode = await generateInviteCode();

        const newUser = {
            profile: {
                name: username,
                userId: userId,
                joinDate: new Date().toLocaleDateString(),
                profilePicUrl: profilePic || null,
                avatar: 'fa-user-astronaut'
            },
            inviteCode: inviteCode,
            inviterId: parseInt(inviterId),
            paid: true,
            ztrBalance: 0,
            level: 0,
            teamSize: 0
        };

        await userRef.set(newUser);
        await db.ref(`userIdMap/${userId}`).set(walletLower);
        await db.ref(`inviteCodeMap/${inviteCode}`).set(walletLower);

        await distributeCommissions(walletLower, parseInt(inviterId));
        
        res.status(201).json({ success: true, profile: newUser.profile });

    } catch (error) {
        console.error("Registration failed:", error);
        res.status(500).json({ success: false, error: "An internal server error occurred." });
    }
});

// ... (baaqi ka sara code waise hi rakhein)
