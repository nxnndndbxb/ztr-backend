const express = require("express");
const app = express();

app.use(express.json());

// Test route
app.get("/", (req, res) => {
  res.send("Backend Working ✅");
});

// Routes
app.use("/api/auth", require("../routes/auth"));
app.use("/api/user", require("../routes/user"));

module.exports = app;
