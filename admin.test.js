const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const db = require('../src/db');
const sandbox = require('../src/sandbox');
const { startServer } = require('../src/index');

let testServer;

// Helper to make local HTTP requests to Express server
function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 5000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const contentType = res.headers['content-type'] || '';
          if (contentType.includes('application/json')) {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } else {
            resolve({ status: res.statusCode, text: data, headers: res.headers });
          }
        } catch (e) {
          resolve({ status: res.statusCode, text: data });
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe('Admin CMS & Server Control Dashboard Test Suite', () => {

  before(async () => {
    await db.init();
    await sandbox.init();
    testServer = await startServer();
  });

  after(async () => {
    if (testServer?.listening) {
      await new Promise(resolve => testServer.close(resolve));
    }
  });

  it('1. [Server Vitals] Returns live memory, uptime, database size, and ticket stats', async () => {
    const res = await request('GET', '/api/admin/vitals');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(res.data.process.uptime >= 0, 'Uptime must be a valid number');
    assert.ok(res.data.process.memory.rssMB > 0, 'Memory RSS must be reported');
    assert.ok(res.data.database.sizeBytes > 0, 'Database size must be positive');
  });

  it('2. [Database Optimization] Executes VACUUM and logs audit event', async () => {
    const res = await request('POST', '/api/admin/vacuum');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(res.data.beforeBytes >= res.data.afterBytes, 'Vacuum should compact or maintain size');

    const audit = await db.get("SELECT * FROM audit_log WHERE action = 'DB_VACUUM' ORDER BY id DESC LIMIT 1");
    assert.ok(audit, 'Audit log entry for vacuum must exist');
  });

  it('3. [Pipeline Settings CMS] Reads and persists custom settings across restarts', async () => {
    const customSettings = {
      llm_model: 'gemini-1.5-pro',
      max_retries: '3',
      auto_triage: 'true',
      auto_fix: 'true',
      human_gate_policy: 'strict'
    };

    const updateRes = await request('PUT', '/api/admin/settings', customSettings);
    assert.strictEqual(updateRes.status, 200);
    assert.strictEqual(updateRes.data.settings.llm_model, 'gemini-1.5-pro');
    assert.strictEqual(updateRes.data.settings.max_retries, '3');

    const fetchRes = await request('GET', '/api/admin/settings');
    assert.strictEqual(fetchRes.status, 200);
    assert.strictEqual(fetchRes.data.settings.llm_model, 'gemini-1.5-pro');
  });

  it('4. [Ticket Content CMS] Edits ticket metadata and status override', async () => {
    // Create a temporary ticket
    const now = new Date().toISOString();
    const created = await db.run(`
      INSERT INTO tickets (external_id, source, title, description, severity, priority, status, repository, branch, environment, owner, created_at, updated_at)
      VALUES ('CMS-TEST-1', 'Admin CMS', 'Original CMS Title', 'Original Desc', 'Low', 'Low', 'PENDING', 'sandbox', 'main', 'Staging', 'None', ?, ?)
    `, [now, now]);

    const ticketId = created.lastID;

    // Edit ticket via CMS API
    const editRes = await request('PUT', `/api/admin/tickets/${ticketId}`, {
      title: 'Updated CMS Incident Title',
      severity: 'Critical',
      priority: 'High',
      status: 'HUMAN_REVIEW',
      owner: 'Principal Architect'
    });

    assert.strictEqual(editRes.status, 200);
    assert.strictEqual(editRes.data.ticket.title, 'Updated CMS Incident Title');
    assert.strictEqual(editRes.data.ticket.severity, 'Critical');
    assert.strictEqual(editRes.data.ticket.status, 'HUMAN_REVIEW');
    assert.strictEqual(editRes.data.ticket.owner, 'Principal Architect');

    // Verify audit trail
    const audit = await db.get("SELECT * FROM audit_log WHERE resource = ? AND action = 'EDIT_TICKET'", [`ticket/${ticketId}`]);
    assert.ok(audit, 'Audit log entry for ticket edit must exist');
  });

  it('5. [Ticket Deletion CMS] Cascades and completely removes ticket and associated runs', async () => {
    const now = new Date().toISOString();
    const created = await db.run(`
      INSERT INTO tickets (external_id, source, title, description, severity, priority, status, repository, branch, environment, owner, created_at, updated_at)
      VALUES ('CMS-DEL-1', 'Admin CMS', 'Ticket To Delete', 'Will be deleted', 'Low', 'Low', 'PENDING', 'sandbox', 'main', 'Dev', 'None', ?, ?)
    `, [now, now]);

    const ticketId = created.lastID;

    // Attach mock agent run
    await db.run(`
      INSERT INTO agent_runs (ticket_id, agent_name, model, prompt_version, status, input_ref, output_ref, cost, duration, error, created_at)
      VALUES (?, 'Intake Agent', 'gemini-1.5-flash', 'v1.0', 'SUCCESS', 'In', 'Out', 0.0001, 50, null, ?)
    `, [ticketId, now]);

    const delRes = await request('DELETE', `/api/admin/tickets/${ticketId}`);
    assert.strictEqual(delRes.status, 200);

    const checkTicket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
    assert.strictEqual(checkTicket, undefined, 'Ticket must be deleted from DB');

    const checkRuns = await db.all("SELECT * FROM agent_runs WHERE ticket_id = ?", [ticketId]);
    assert.strictEqual(checkRuns.length, 0, 'Associated agent runs must be cascaded');
  });

  it('6. [Sandbox Code Editor CMS] Writes file content directly to sandbox repository', async () => {
    const filename = 'cms_test_file.js';
    const content = '// Created via CMS Editor\nmodule.exports = { test: true };\n';

    const saveRes = await request('POST', '/api/admin/sandbox/file', { filename, content });
    assert.strictEqual(saveRes.status, 200);
    assert.strictEqual(saveRes.data.success, true);

    const diskContent = await sandbox.readFile(filename);
    assert.strictEqual(diskContent, content, 'Content on disk must match CMS save payload');
  });

  it('7. [Audit Logs Export] Exports logs as CSV and JSON formats', async () => {
    const jsonRes = await request('GET', '/api/admin/export-logs?format=json');
    assert.strictEqual(jsonRes.status, 200);
    assert.ok(Array.isArray(jsonRes.data.logs), 'JSON logs must be an array');
    assert.ok(jsonRes.data.logs.length > 0, 'Must have recorded logs');

    const csvRes = await request('GET', '/api/admin/export-logs?format=csv');
    assert.strictEqual(csvRes.status, 200);
    assert.ok(csvRes.headers['content-type'].includes('text/csv'), 'Header must indicate text/csv');
    assert.ok(csvRes.text.startsWith('id,actor,action,resource'), 'CSV must have correct header row');
  });

});
