const app = require('./app');
const { setupDatabase } = require('./setup');
const { workerLoop } = require('./worker');

const PORT = Number(process.env.PORT) || 3000;

async function main() {
  await setupDatabase();
  workerLoop(); // starts delivering anything already pending (this is what makes restarts safe)
  app.listen(PORT, () => console.log(`workshop service on http://localhost:${PORT}`));
}

main().catch((err) => {
  console.error('failed to start:', err);
  process.exit(1);
});
