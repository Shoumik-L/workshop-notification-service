// A fake notification service ("email/SMS provider") that misbehaves on purpose.
//   - FAIL_RATE:    fraction of requests answered with 500       (default 0.2)
//   - TIMEOUT_RATE: fraction of requests that never answer       (default 0.1)
//   - POST /admin/down  -> every request fails with 503;  POST /admin/up -> works again
// A 2xx answer means "delivered".
const express = require('express');

const PORT = Number(process.env.PORT) || 4000;
const FAIL_RATE = Number(process.env.FAIL_RATE ?? 0.2);
const TIMEOUT_RATE = Number(process.env.TIMEOUT_RATE ?? 0.1);

const app = express();
app.use(express.json());

let down = false;
const delivered = new Map(); // idempotency key -> what was delivered
const counters = { requests: 0, delivered: 0, duplicatesIgnored: 0, failures: 0, timeouts: 0, downRejections: 0 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function recordDelivery(key, body) {
  if (delivered.has(key)) {
    counters.duplicatesIgnored++;
    return false;
  }
  delivered.set(key, { ...body, at: new Date().toISOString() });
  counters.delivered++;
  return true;
}

app.post('/notify', async (req, res) => {
  counters.requests++;
  const key = req.get('Idempotency-Key') || `no-key-${Date.now()}-${Math.random()}`;

  if (down) {
    counters.downRejections++;
    return res.status(503).json({ error: 'service unavailable' });
  }

  if (Math.random() < TIMEOUT_RATE) {
    counters.timeouts++;
    // Half of the timeouts are the nasty kind: the message WAS delivered but the reply is lost.
    // The backend will retry, which shows duplicate handling (idempotency key) in action.
    if (Math.random() < 0.5) recordDelivery(key, req.body);
    await sleep(10000); // never answers within the client's timeout
    return res.status(504).end();
  }

  if (Math.random() < FAIL_RATE) {
    counters.failures++;
    return res.status(500).json({ error: 'random failure' });
  }

  const isNew = recordDelivery(key, req.body);
  res.json({ status: 'delivered', duplicate: !isNew });
});

app.post('/admin/down', (req, res) => { down = true; res.json({ down }); });
app.post('/admin/up', (req, res) => { down = false; res.json({ down }); });
app.get('/admin/stats', (req, res) => res.json({ down, uniqueDelivered: delivered.size, ...counters }));
app.get('/admin/delivered', (req, res) => res.json([...delivered.entries()].map(([key, v]) => ({ key, ...v }))));
app.post('/admin/reset', (req, res) => {
  delivered.clear();
  Object.keys(counters).forEach((k) => { counters[k] = 0; });
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`mock notification service on http://localhost:${PORT} (fail ${FAIL_RATE}, timeout ${TIMEOUT_RATE})`));
