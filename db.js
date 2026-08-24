const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.resolve(__dirname, '../database.sqlite');
const db = new sqlite3.Database(dbPath);

const run = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, lastID: this.lastID, changes: this.changes });
    });
  });
};

const all = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const get = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const initializeDatabase = async () => {
  await run(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT,
      source TEXT,
      title TEXT,
      description TEXT,
      severity TEXT,
      priority TEXT,
      status TEXT,
      repository TEXT,
      branch TEXT,
      environment TEXT,
      owner TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS ticket_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER,
      event_type TEXT,
      actor TEXT,
      payload TEXT,
      timestamp TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER,
      agent_name TEXT,
      model TEXT,
      prompt_version TEXT,
      status TEXT,
      input_ref TEXT,
      output_ref TEXT,
      cost REAL,
      duration INTEGER,
      error TEXT,
      created_at TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS investigations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER,
      hypotheses TEXT,
      evidence TEXT,
      reproduction_command TEXT,
      root_cause TEXT,
      confidence REAL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER,
      branch TEXT,
      commit_sha TEXT,
      files_changed TEXT,
      test_changes TEXT,
      risk_summary TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS validations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER,
      check_name TEXT,
      command TEXT,
      status TEXT,
      logs_ref TEXT,
      duration INTEGER
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS pull_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER,
      pr_url TEXT,
      pr_number INTEGER,
      review_status TEXT,
      merge_status TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT,
      action TEXT,
      resource TEXT,
      before TEXT,
      after TEXT,
      timestamp TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    )
  `);

  // Default settings
  const defaultSettings = [
    { key: 'llm_model', value: 'gemini-1.5-flash' },
    { key: 'max_retries', value: '2' },
    { key: 'auto_triage', value: 'true' },
    { key: 'auto_fix', value: 'true' },
    { key: 'auto_pr', value: 'true' },
    { key: 'human_gate_policy', value: 'strict' },
    { key: 'cost_alert_threshold', value: '0.05' },
    { key: 'environment_mode', value: 'Production' }
  ];

  for (const s of defaultSettings) {
    const existing = await get("SELECT * FROM system_settings WHERE key = ?", [s.key]);
    if (!existing) {
      await run("INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)", [s.key, s.value, new Date().toISOString()]);
    }
  }

  const count = await get("SELECT count(*) as count FROM tickets");
  if (count.count === 0) {
    const now = new Date().toISOString();
    
    const mergedTicketId = (await run(`
      INSERT INTO tickets (external_id, source, title, description, severity, priority, status, repository, branch, environment, owner, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      "GH-42", "GitHub", "SyntaxError in authentication callback module",
      "The auth callback crashes on undefined token properties when token retrieval fails. Needs default check logic.",
      "High", "High", "MERGED", "sandbox", "ticket-42-auth-fix", "Production", "Triage Agent", now, now
    ])).id;

    await run(`
      INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `, [mergedTicketId, "STATE_CHANGE", "System Orchestrator", JSON.stringify({ from: "INTAKE", to: "MERGED", reason: "Approved and merged by reviewer" }), now]);

    await run(`
      INSERT INTO agent_runs (ticket_id, agent_name, model, prompt_version, status, input_ref, output_ref, cost, duration, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [mergedTicketId, "Fix Agent", "gemini-1.5-pro", "v1.0", "SUCCESS", "auth.js", "auth.js diff patch", 0.004, 3400, null, now]);

    await run(`
      INSERT INTO pull_requests (ticket_id, pr_url, pr_number, review_status, merge_status)
      VALUES (?, ?, ?, ?, ?)
    `, [mergedTicketId, "https://github.com/org/sandbox/pull/42", 42, "APPROVED", "MERGED"]);

    await run(`
      INSERT INTO audit_log (actor, action, resource, before, after, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `, ["lead-developer", "APPROVE_PR", `ticket/${mergedTicketId}`, "HUMAN_REVIEW", "MERGED", now]);

    const blockedTicketId = (await run(`
      INSERT INTO tickets (external_id, source, title, description, severity, priority, status, repository, branch, environment, owner, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      "SLACK-108", "Slack", "Database connection timeout during spikes",
      "Users report intermittent 504 Gateway Timeouts. Sentry logs show postgres connection exhaustion.",
      "Critical", "High", "BLOCKED", "sandbox", "main", "Production", "Triage Agent", now, now
    ])).id;

    await run(`
      INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `, [blockedTicketId, "STATE_CHANGE", "Orchestrator", JSON.stringify({ from: "INVESTIGATING", to: "BLOCKED", reason: "Blocked: Insufficient local sandbox DB replicas to reproduce load spike." }), now]);
  }
};

const getSettings = async () => {
  const rows = await all("SELECT * FROM system_settings");
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  return settings;
};

const updateSettings = async (settingsObj) => {
  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(settingsObj)) {
    const strVal = String(value);
    await run(`
      INSERT INTO system_settings (key, value, updated_at) 
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `, [key, strVal, now]);
  }
  return await getSettings();
};

module.exports = {
  db,
  dbPath,
  run,
  all,
  get,
  init: initializeDatabase,
  initializeDatabase,
  getSettings,
  updateSettings
};
