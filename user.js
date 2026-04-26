const express = require("express");
const router = express.Router();
const { db } = require("../config/firebase");

router.get("/profile", async (req, res) => {
  const wallet = req.user.wallet;

  const snap = await db.ref(`users/${wallet}`).once("value");
  res.json(snap.val());
});

module.exports = router;