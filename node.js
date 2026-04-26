router.post("/activate-node", async (req, res) => {
  const wallet = req.user.wallet;

  // verify payment server-side later
  await db.ref(`users/${wallet}/node`).set({
    active: true,
    time: Date.now()
  });

  res.send("Node Activated");
});