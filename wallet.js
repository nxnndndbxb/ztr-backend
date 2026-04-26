router.post("/withdraw", async (req, res) => {
  const wallet = req.user.wallet;
  const { amount } = req.body;

  if (amount <= 0) return res.status(400).send("Invalid amount");

  await db.ref(`withdrawals`).push({
    wallet,
    amount,
    status: "pending",
    createdAt: Date.now()
  });

  res.send("Withdrawal Requested");
});