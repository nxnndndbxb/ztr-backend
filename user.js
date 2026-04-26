const express = require("express");
const router = express.Router();
const { db } = require("../config/firebase");

router.get("/profile", async (req, res) => {
  const wallet = req.headers.wallet;

  if (!wallet) {
    return res.status(400).send("Wallet missing");
  }

  const snap = await db.ref(`users/${wallet}`).once("value");

  res.json(snap.val());
});

module.exports = router;
