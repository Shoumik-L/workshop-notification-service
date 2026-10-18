// Demo: registration, duplicate protection, notification failure, recovery, cancellation.
// Start the database, the mock service and the backend first (see README), then:  npm run demo
const API = process.env.API_URL || 'http://localhost:3000';
const MOCK = process.env.MOCK_URL || 'http://localhost:4000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const api = (m, p, b) => call(API, m, p, b);
const mock = (m, p, b) => call(MOCK, m, p, b);

async function waitUntil(label, check, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return true;
    await sleep(500);
  }
  console.log(`   (gave up waiting for: ${label})`);
  return false;
}
const summary = async () => (await api('GET', '/notifications/summary')).body;
const checks = [];
const check = (name, ok) => { checks.push(ok); console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}`); };

async function main() {
  console.log('\n=== 0. Setup ===');
  await mock('POST', '/admin/up');
  await mock('POST', '/admin/reset');
  const w = (await api('POST', '/workshops', { title: `Intro to Backend ${new Date().toISOString()}` })).body;
  console.log('created workshop', w.id, '-', w.title);

  console.log('\n=== 1. Registration (replies without waiting for notifications) ===');
  for (const member of ['alice', 'bob', 'carol']) {
    const t0 = Date.now();
    const r = await api('POST', `/workshops/${w.id}/register`, { memberId: member });
    console.log(`   ${member}: HTTP ${r.status} in ${Date.now() - t0} ms`);
  }
  const dup = await api('POST', `/workshops/${w.id}/register`, { memberId: 'alice' });
  check('registering alice twice is rejected (409)', dup.status === 409);
  console.log('   waiting for confirmations (the mock service fails/times out randomly, so retries happen)...');
  await waitUntil('3 confirmations sent', async () => (await summary()).sent >= 3);
  check('3 confirmations delivered, no extra one for the failed duplicate registration', (await summary()).sent === 3);

  console.log('\n=== 2. Notification service goes DOWN, registrations still work ===');
  await mock('POST', '/admin/down');
  for (const member of ['dave', 'erin']) {
    const r = await api('POST', `/workshops/${w.id}/register`, { memberId: member });
    console.log(`   ${member}: HTTP ${r.status}`);
  }
  await sleep(5000);
  const pending = (await api('GET', '/notifications?status=pending')).body;
  console.log('   still pending after 5 s:', pending.map((n) => `${n.memberId}(attempts ${n.attempts})`).join(', '));
  check('dave and erin are pending and being retried', pending.length === 2 && pending.every((n) => n.attempts >= 1));

  console.log('\n=== 3. Service RECOVERS ===');
  await mock('POST', '/admin/up');
  await waitUntil('all 5 confirmations sent', async () => (await summary()).sent >= 5);
  check('all 5 confirmations delivered after recovery', (await summary()).sent === 5);

  console.log('\n=== 4. Cancel the workshop: everyone is notified ===');
  const cancel = await api('POST', `/workshops/${w.id}/cancel`);
  console.log('   cancel ->', JSON.stringify(cancel.body));
  check('cancel reports 5 members to notify', cancel.body.membersToNotify === 5);
  const again = await api('POST', `/workshops/${w.id}/cancel`);
  check('cancelling twice is rejected (409)', again.status === 409);
  const late = await api('POST', `/workshops/${w.id}/register`, { memberId: 'frank' });
  check('registering for a cancelled workshop is rejected (409)', late.status === 409);
  await waitUntil('10 notifications sent', async () => (await summary()).sent >= 10);

  console.log('\n=== 5. Final report ===');
  const s = await summary();
  const stats = (await mock('GET', '/admin/stats')).body;
  console.log('   outbox summary        :', JSON.stringify(s));
  console.log('   mock service counters :', JSON.stringify(stats));
  check('5 confirmations + 5 cancellations sent, none failed', s.sent === 10 && s.failed === 0 && s.pending === 0);
  check('the mock service holds exactly 10 unique deliveries (duplicates were ignored)', stats.uniqueDelivered === 10);

  console.log(`\n${checks.every(Boolean) ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}\n`);
  process.exit(checks.every(Boolean) ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
