const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

router.post("/login", async (req, res) => {
  const { wallet } = req.body;

  if (!wallet) return res.status(400).send("Wallet required");

  const token = jwt.sign({ wallet }, process.env.JWT_SECRET);
  res.json({ token });
});

module.exports = router;