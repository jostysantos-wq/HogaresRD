#!/usr/bin/env node
/**
 * migrate-messages.js
 *
 * Extracts messages from the conversations.data JSONB blob into
 * the new `messages` table, then strips the messages array from
 * each conversation's data column.
 *
 * Safe to run multiple times — skips conversations whose messages
 * have already been migrated (checks for existing rows in messages).
 *
 * Usage:
 *   node scripts/migrate-messages.js          # dry-run (read-only)
 *   node scripts/migrate-messages.js --apply  # actually migrate
 */

require('dotenv').config();
const { Pool } = require('pg');

const DRY_RUN = !process.argv.includes('--apply');
const BATCH_SIZE = 100;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined,
});

async function migrate() {
  console.log(DRY_RUN ? '[DRY RUN] No changes will be written.\n' : '[APPLY] Migrating messages...\n');

  // 1. Ensure messages table + message_count column exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id       TEXT NOT NULL,
      sender_role     TEXT NOT NULL,
      sender_name     TEXT NOT NULL,
      text            TEXT NOT NULL,
      timestamp       TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages(conversation_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_conv_id ON messages(conversation_id);
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS message_count INTEGER DEFAULT 0;
  `);
  console.log('Schema ready.\n');

  // 2. Load all conversations
  const { rows: convRows } = await pool.query('SELECT id, data FROM conversations');
  console.log(`Found ${convRows.length} conversations.\n`);

  let totalMigrated = 0;
  let totalSkipped = 0;
  let totalConvsUpdated = 0;
  let errors = 0;

  for (let i = 0; i < convRows.length; i++) {
    const row = convRows[i];
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    const msgs = Array.isArray(data?.messages) ? data.messages : [];

    if (msgs.length === 0) {
      totalSkipped++;
      continue;
    }

    // Check if messages already migrated for this conversation
    const { rows: [{ count }] } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM messages WHERE conversation_id = $1',
      [row.id]
    );
    if (count > 0) {
      console.log(`  [skip] ${row.id} — already has ${count} messages in table`);
      totalSkipped++;
      continue;
    }

    console.log(`  [migrate] ${row.id} — ${msgs.length} messages`);

    if (DRY_RUN) {
      totalMigrated += msgs.length;
      totalConvsUpdated++;
      continue;
    }

    // Migrate in a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert messages in batches
      for (let b = 0; b < msgs.length; b += BATCH_SIZE) {
        const batch = msgs.slice(b, b + BATCH_SIZE);
        const values = [];
        const placeholders = [];
        let idx = 1;

        for (const m of batch) {
          placeholders.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5}, $${idx+6})`);
          values.push(
            m.id || `msg_migrated_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`,
            row.id,
            m.senderId || 'unknown',
            m.senderRole || 'unknown',
            m.senderName || '',
            m.text || '',
            m.timestamp || new Date().toISOString()
          );
          idx += 7;
        }

        await client.query(
          `INSERT INTO messages (id, conversation_id, sender_id, sender_role, sender_name, text, timestamp)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (id) DO NOTHING`,
          values
        );
      }

      // Strip messages from data blob and set message_count
      const { messages: _removed, ...cleanData } = data;
      await client.query(
        'UPDATE conversations SET data = $2, message_count = $3 WHERE id = $1',
        [row.id, JSON.stringify(cleanData), msgs.length]
      );

      await client.query('COMMIT');
      totalMigrated += msgs.length;
      totalConvsUpdated++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`  [ERROR] ${row.id}:`, err.message);
      errors++;
    } finally {
      client.release();
    }

    // Progress update every 50 conversations
    if ((i + 1) % 50 === 0) {
      console.log(`  ... processed ${i + 1}/${convRows.length} conversations`);
    }
  }

  console.log('\n══════════════════════════════════════');
  console.log(`Conversations processed: ${convRows.length}`);
  console.log(`Conversations updated:   ${totalConvsUpdated}`);
  console.log(`Conversations skipped:   ${totalSkipped}`);
  console.log(`Messages migrated:       ${totalMigrated}`);
  console.log(`Errors:                  ${errors}`);
  console.log('══════════════════════════════════════');

  if (DRY_RUN) {
    console.log('\nThis was a dry run. Re-run with --apply to execute the migration.');
  } else {
    // Verify
    const { rows: [{ count: msgCount }] } = await pool.query('SELECT COUNT(*)::int AS count FROM messages');
    console.log(`\nVerification: ${msgCount} total messages in messages table.`);
  }
}

migrate()
  .catch(err => { console.error('Migration failed:', err); process.exit(1); })
  .finally(() => pool.end());
