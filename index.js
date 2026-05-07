const express = require('express');
const cors = require('cors');
const app = express();

// Middleware
app.use(cors()); // Frontend se request allow karne ke liye
app.use(express.json()); // JSON data ko samajhne ke liye

// Initialize Firebase Admin
require('./firebase');

// API Routes (Har feature ke liye alag file)
app.use('/api/register', require('./routes/register'));
app.use('/api/upgrade', require('./routes/upgrade'));
app.use('/api/withdraw', require('./routes/withdraw'));
app.use('/api/platform-data', require('./routes/platformData'));
app.use('/api/claim-task-reward', require('./routes/claimTask'));

// Welcome Route
app.get('/api', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send('<h1>ZTR Backend is Live!</h1><p>Ready to connect to the blockchain.</p>');
});

// Vercel ke liye app ko export karein
module.exports = app;
