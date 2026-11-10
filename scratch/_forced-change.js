// Test helper — 4.0.1.
// A fresh install now ALWAYS forces the admin to choose a password on the first
// login (S: the operator must own the credential, whether it was generated or
// came from ADMIN_PASSWORD). Harnesses that log in as the seeded admin simulate
// an installation where that already happened, so this clears the flag once the
// boot finished seeding. It is test plumbing, not a production bypass: nothing
// in src/ reads it.
module.exports = async function settleForcedChange() {
  let db;
  try { db = require('../src/db/database'); } catch (e) { return false; }
  for (let i = 0; i < 120; i++) {
    try {
      const row = await db.queryOne("SELECT id FROM users WHERE email='admin@status.local'");
      if (row) {
        await db.run("UPDATE users SET must_change_password=0 WHERE email='admin@status.local'");
        return true;
      }
    } catch (e) { /* database not ready yet */ }
    await new Promise(r => setTimeout(r, 25));
  }
  return false;
};
