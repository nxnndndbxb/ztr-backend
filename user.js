const express = require("express");
const router = express.Router();
const { db } = require("../config/firebase");

// GET USER PROFILE
router.get("/profile", async (req, res) => {
  try {
    const wallet = req.headers.wallet;

    if (!wallet) {
      return res.status(400).json({ error: "Wallet missing" });
    }

    const snap = await db.ref(`users/${wallet.toLowerCase()}`).once("value");

    res.json(snap.val() || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;