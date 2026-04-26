const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

// LOGIN (wallet based)
router.post("/login", (req, res) => {
  const { wallet } = req.body;

  if (!wallet) {
    return res.status(400).json({ error: "Wallet required" });
  }

  const token = jwt.sign({ wallet }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });

  res.json({ token });
});

module.exports = router;