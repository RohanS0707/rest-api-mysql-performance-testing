require('dotenv').config();
const { app } = require('./app');
const { initializeDatabase, pool } = require('./db');

const port = Number(process.env.PORT || 3000);

async function start() {
  await initializeDatabase();
  const server = app.listen(port, '0.0.0.0', () => console.log(`API listening on port ${port}`));
  const shutdown = () => server.close(async () => { await pool.end(); process.exit(0); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((error) => {
  console.error('API startup failed:', error.message);
  process.exit(1);
});
