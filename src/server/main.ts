import { existsSync } from 'node:fs';
import express from 'express';
import { createApiServer } from './app.js';
import { CastDatabase } from './db.js';

const port = Number(process.env.PORT ?? 5565);
const host = process.env.HOST ?? '127.0.0.1';
const db = new CastDatabase();
db.ensureSeeded();
const app = createApiServer(db);
const distDirectory = new URL('../../dist', import.meta.url).pathname;
if (existsSync(distDirectory)) {
  app.use(express.static(distDirectory));
}
app.use((request, response, next) => {
  if (request.method === 'GET' && !request.path.startsWith('/api')) {
    response.sendFile(`${distDirectory}/index.html`);
  } else {
    next();
  }
});
app.listen(port, host, () => {
  console.log(`深海投放校正台: http://${host}:${port}`);
});
