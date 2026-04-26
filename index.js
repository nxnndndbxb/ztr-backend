const express = require("express");
const app = express();

app.use(express.json());

// MAIN TEST ROUTE
app.get("/", (req, res) => {
  res.send("Backend Working ✅");
});

// TEST API
app.get("/api/test", (req, res) => {
  res.json({ success: true });
});

module.exports = app;
