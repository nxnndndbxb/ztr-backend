const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("Backend Working ✅");
});

module.exports = app;
