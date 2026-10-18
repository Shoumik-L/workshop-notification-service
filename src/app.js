const express = require('express');
const { HttpError } = require('./httpError');

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/workshops', require('./routes/workshops'));
app.use('/notifications', require('./routes/notifications'));

app.use((req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

module.exports = app;
