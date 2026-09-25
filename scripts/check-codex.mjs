import { CodexClient } from '../server/codex.mjs';
const client = new CodexClient();
try {
  await client.start();
  const account = await client.call('account/read', { refreshToken: false });
  const models = await client.models();
  console.log(JSON.stringify({ connected: true, loggedIn: Boolean(account.account), models: models.map(m => m.model) }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { client.close(); }
