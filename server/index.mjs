// Entry point of the intake service ("api" in docker-compose).
//
//   DATA_DIR=./data node --disable-warning=ExperimentalWarning server/index.mjs

import { mkdirSync } from 'node:fs';
import { createApp } from './app.mjs';
import { config } from './config.mjs';
import { openDb } from './db.mjs';
import { createDiscover } from './discover.mjs';
import { createIntake } from './intake.mjs';
import { createLlm } from './llm.mjs';
import { createScheduler } from './scheduler.mjs';
import { seedFromCatalog } from './seed.mjs';
import { createStore } from './store.mjs';

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

if (config.production && !config.workerToken) {
  console.error('WORKER_TOKEN is required in production');
  process.exit(1);
}

mkdirSync(config.paths.shots, { recursive: true });
mkdirSync(config.paths.publicShots, { recursive: true });

const store = createStore(openDb(config.paths.db));
const llm = createLlm(config.llm, { log });
const intake = createIntake({ store, config, llm, log });
const discover = createDiscover({ store, config, log });
const scheduler = createScheduler({ store, intake, discover, config, log });
const { server } = createApp({ store, intake, discover, scheduler, config, log });

seedFromCatalog({ store, intake, config, log });
// Make sure the site has something to load even before the first approval.
intake.publish();

server.listen(config.port, config.host, () => {
  log(`api listening on ${config.host}:${config.port} (data in ${config.dataDir}; ai ${llm.enabled ? config.llm.model : 'off'})`);
  scheduler.start();
});

// A forgotten catch in some background task must not take the review desk down with it.
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e?.stack || e}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    scheduler.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
