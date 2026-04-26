const express = require("express");
const app = express();

app.use(express.json());

// TEST ROUTE
app.get("/", (req, res) => {
  res.send("Backend Working ✅");
});

// ROUTES
app.use("/api/auth", require("../routes/auth"));
app.use("/api/user", require("../routes/user"));

module.exports = app;