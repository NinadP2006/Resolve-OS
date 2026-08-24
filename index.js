const express = require('express');
const cors = require('cors');
const db = require('./db');
const orchestrator = require('./orchestrator');

const path = require('path');
const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
  next();
});

app.get('/', (req, res) => {
  res.json({ message: "AI Engineering Automation Pipeline API is running." });
});

app.get('/api/metrics', async (req, res) => {
  try {
    const states = await db.all("SELECT status, count(*) as count FROM tickets GROUP BY status");
    const stateCounts = {};
    states.forEach(s => { stateCounts[s.status] = s.count; });

    const totalTickets = await db.get("SELECT count(*) as count FROM tickets");
    const mergedTickets = await db.get("SELECT count(*) as count FROM tickets WHERE status = 'MERGED'");
    const blockedTickets = await db.get("SELECT count(*) as count FROM tickets WHERE status = 'BLOCKED'");
    
    const totalCostRow = await db.get("SELECT sum(cost) as total FROM agent_runs");
    const totalCost = totalCostRow?.total || 0;
    const avgCost = totalTickets.count > 0 ? (totalCost / totalTickets.count).toFixed(4) : "0.0000";

    const reproducedRow = await db.get("SELECT count(distinct ticket_id) as count FROM investigations");
    const autoReproductionRate = totalTickets.count > 0 
      ? Math.round((reproducedRow.count / totalTickets.count) * 100) 
      : 100;

    const prReachedRow = await db.get("SELECT count(distinct ticket_id) as count FROM pull_requests");
    const prReachRate = totalTickets.count > 0
      ? Math.round((prReachedRow.count / totalTickets.count) * 100)
      : 100;

    const ciValidations = await db.all("SELECT status FROM validations WHERE check_name = 'Unit Tests'");
    const totalCI = ciValidations.length;
    const successCI = ciValidations.filter(v => v.status === 'SUCCESS').length;
    const ciSuccessRate = totalCI > 0 ? Math.round((successCI / totalCI) * 100) : 100;

    const activeRuns = await db.get(`
      SELECT count(distinct id) as count FROM tickets 
      WHERE status NOT IN ('MERGED', 'REJECTED', 'BLOCKED', 'HUMAN_REVIEW')
    `);

    const raisedCount = (stateCounts['PENDING'] || 0) + (stateCounts['INTAKE'] || 0);
    const queuedCount = (stateCounts['TRIAGED'] || 0) + (stateCounts['INVESTIGATING'] || 0);
    const inProgressCount = (stateCounts['REPRODUCED'] || 0) + (stateCounts['FIXING'] || 0) + (stateCounts['VALIDATING'] || 0) + (stateCounts['PR_OPEN'] || 0) + (stateCounts['AI_REVIEW'] || 0);
    const reviewCount = stateCounts['HUMAN_REVIEW'] || 0;
    const resolvedCount = stateCounts['MERGED'] || 0;
    const blockedCount = (stateCounts['BLOCKED'] || 0) + (stateCounts['REJECTED'] || 0);

    res.json({
      success: true,
      counts: {
        total: totalTickets.count,
        raised: raisedCount,
        queued: queuedCount,
        in_progress: inProgressCount,
        awaiting_review: reviewCount,
        resolved: resolvedCount,
        blocked: blockedCount,
        states: stateCounts
      },
      metrics: {
        avgCost: `$${avgCost}`,
        reproductionRate: `${autoReproductionRate}%`,
        prReachRate: `${prReachRate}%`,
        ciSuccessRate: `${ciSuccessRate}%`
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/events - Global real-time event logs
app.get('/api/events', async (req, res) => {
  try {
    const events = await db.all(`
      SELECT te.*, t.title as ticket_title, t.external_id 
      FROM ticket_events te 
      JOIN tickets t ON te.ticket_id = t.id 
      ORDER BY te.id DESC LIMIT 40
    `);
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/sandbox/files - Real-time sandbox filesystem inspection
app.get('/api/sandbox/files', async (req, res) => {
  try {
    const sandbox = require('./sandbox');
    const calcCode = await sandbox.readFile('calculator.js');
    const authCode = await sandbox.readFile('auth.js');
    const calcTest = await sandbox.readFile('test/calculator.test.js');
    const authTest = await sandbox.readFile('test/auth.test.js');
    const diff = await sandbox.getDiff();

    res.json({
      files: [
        { path: 'calculator.js', content: calcCode },
        { path: 'auth.js', content: authCode },
        { path: 'test/calculator.test.js', content: calcTest },
        { path: 'test/auth.test.js', content: authTest }
      ],
      currentDiff: diff
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/tickets', async (req, res) => {
  try {
    const tickets = await db.all("SELECT * FROM tickets ORDER BY updated_at DESC");
    res.json(tickets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/tickets', async (req, res) => {
  try {
    const { title, description, severity, priority, source, environment } = req.body;
    const now = new Date().toISOString();
    const result = await db.run(`
      INSERT INTO tickets (external_id, source, title, description, severity, priority, status, repository, branch, environment, owner, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 'sandbox', 'main', ?, 'None', ?, ?)
    `, [
      "EXT-" + Math.floor(Math.random() * 10000),
      source || "Manual",
      title || "Untitled Bug Report",
      description || "",
      severity || "Medium",
      priority || "Medium",
      environment || "Development",
      now, now
    ]);

    await db.run(`
      INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
      VALUES (?, 'TICKET_CREATED', 'System', ?, ?)
    `, [result.id, JSON.stringify({ title, severity, priority }), now]);

    orchestrator.runPipeline(result.id);

    res.status(201).json({ success: true, ticketId: result.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/webhooks/issues', async (req, res) => {
  try {
    const { title, description, source, severity } = req.body;
    const now = new Date().toISOString();
    const result = await db.run(`
      INSERT INTO tickets (external_id, source, title, description, severity, priority, status, repository, branch, environment, owner, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'Medium', 'PENDING', 'sandbox', 'main', 'Staging', 'System', ?, ?)
    `, [
      "WEBHOOK-" + Math.floor(Math.random() * 1000),
      source || "Webhook Intake",
      title || "Webhook report",
      description || "No description provided",
      severity || "Medium",
      now, now
    ]);

    await db.run(`
      INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
      VALUES (?, 'WEBHOOK_RECEIVED', 'Intake Channel', ?, ?)
    `, [result.id, JSON.stringify(req.body), now]);

    orchestrator.runPipeline(result.id);

    res.status(202).json({ success: true, message: "Webhook accepted. Ticket ingested.", ticketId: result.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/tickets/:id', async (req, res) => {
  try {
    const ticketId = req.params.id;
    const ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
    if (!ticket) {
      return res.status(404).json({ error: "Ticket not found" });
    }

    const events = await db.all("SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id ASC", [ticketId]);
    const runs = await db.all("SELECT * FROM agent_runs WHERE ticket_id = ? ORDER BY id ASC", [ticketId]);
    const investigation = await db.get("SELECT * FROM investigations WHERE ticket_id = ?", [ticketId]);
    const change = await db.get("SELECT * FROM changes WHERE ticket_id = ?", [ticketId]);
    const validations = await db.all("SELECT * FROM validations WHERE ticket_id = ? ORDER BY id ASC", [ticketId]);
    const pr = await db.get("SELECT * FROM pull_requests WHERE ticket_id = ?", [ticketId]);

    let fileDiff = "";
    if (change?.branch === ticket.branch && ticket.status !== 'MERGED') {
      try {
        const sandbox = require('./sandbox');
        fileDiff = await sandbox.getDiff();
      } catch (diffErr) {
        console.warn("Could not read current sandbox diff:", diffErr);
      }
    }

    res.json({
      ticket,
      events,
      runs,
      investigation,
      change,
      validations,
      pr,
      diff: fileDiff
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/tickets/:id/run', async (req, res) => {
  try {
    const ticketId = req.params.id;
    const ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    orchestrator.runPipeline(ticketId);
    res.json({ success: true, message: "Pipeline run initiated." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/tickets/:id/approve', async (req, res) => {
  try {
    const { actor } = req.body;
    const result = await orchestrator.approveTicket(req.params.id, actor || "Lead Developer");
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/tickets/:id/reject', async (req, res) => {
  try {
    const { actor, reason } = req.body;
    const result = await orchestrator.rejectTicket(req.params.id, actor || "Lead Developer", reason || "Changes rejected by human review.");
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/tickets/:id/request-changes', async (req, res) => {
  try {
    const { actor, comments } = req.body;
    const result = await orchestrator.requestChanges(req.params.id, actor || "Lead Developer", comments || "Please refine code changes.");
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/tickets/:id/runs', async (req, res) => {
  try {
    const runs = await db.all("SELECT * FROM agent_runs WHERE ticket_id = ? ORDER BY id DESC", [req.params.id]);
    res.json(runs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/tickets/:id/validation', async (req, res) => {
  try {
    const validations = await db.all("SELECT * FROM validations WHERE ticket_id = ? ORDER BY id DESC", [req.params.id]);
    res.json(validations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/github/webhook', (req, res) => {
  console.log("[GitHub Webhook] Received webhook payload:", req.body);
  res.json({ success: true, message: "Webhook processed" });
});

// ==========================================
// ADMIN CMS & SERVER CONTROL ENDPOINTS
// ==========================================

const fs = require('fs');
const sandbox = require('./sandbox');

// GET /api/admin/vitals - System and process health
app.get('/api/admin/vitals', async (req, res) => {
  try {
    const mem = process.memoryUsage();
    let dbSize = 0;
    try {
      if (fs.existsSync(db.dbPath)) {
        dbSize = fs.statSync(db.dbPath).size;
      }
    } catch (e) {}

    const totalTickets = (await db.get("SELECT count(*) as count FROM tickets"))?.count || 0;
    const totalRuns = (await db.get("SELECT count(*) as count FROM agent_runs"))?.count || 0;
    const activeTickets = (await db.get("SELECT count(*) as count FROM tickets WHERE status NOT IN ('MERGED', 'REJECTED', 'BLOCKED', 'HUMAN_REVIEW')"))?.count || 0;

    res.json({
      success: true,
      process: {
        uptime: Math.round(process.uptime()),
        nodeVersion: process.version,
        platform: process.platform,
        pid: process.pid,
        memory: {
          rssMB: (mem.rss / 1024 / 1024).toFixed(2),
          heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(2),
          heapTotalMB: (mem.heapTotal / 1024 / 1024).toFixed(2)
        }
      },
      database: {
        sizeBytes: dbSize,
        sizeKB: (dbSize / 1024).toFixed(2),
        totalTickets,
        totalAgentRuns: totalRuns,
        activeTickets
      },
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin/vacuum - Optimize SQLite database
app.post('/api/admin/vacuum', async (req, res) => {
  try {
    const beforeSize = fs.existsSync(db.dbPath) ? fs.statSync(db.dbPath).size : 0;
    await db.run("VACUUM");
    const afterSize = fs.existsSync(db.dbPath) ? fs.statSync(db.dbPath).size : 0;

    await db.run(`
      INSERT INTO audit_log (actor, action, resource, before, after, timestamp)
      VALUES ('admin', 'DB_VACUUM', 'database.sqlite', ?, ?, ?)
    `, [`${beforeSize} bytes`, `${afterSize} bytes`, new Date().toISOString()]);

    res.json({
      success: true,
      message: "Database optimized and compacted successfully.",
      beforeBytes: beforeSize,
      afterBytes: afterSize,
      savedBytes: Math.max(0, beforeSize - afterSize)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin/reset-sandbox - Hard reset git sandbox
app.post('/api/admin/reset-sandbox', async (req, res) => {
  try {
    await sandbox.cleanup();
    await db.run(`
      INSERT INTO audit_log (actor, action, resource, before, after, timestamp)
      VALUES ('admin', 'RESET_SANDBOX', 'sandbox/', 'dirty/active branches', 'main/clean', ?)
    `, [new Date().toISOString()]);

    res.json({ success: true, message: "Sandbox Git repository successfully reset to clean main." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/settings - Read persistent pipeline settings
app.get('/api/admin/settings', async (req, res) => {
  try {
    const settings = await db.getSettings();
    res.json({ success: true, settings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/settings - Update persistent pipeline settings
app.put('/api/admin/settings', async (req, res) => {
  try {
    const updated = await db.updateSettings(req.body);
    await db.run(`
      INSERT INTO audit_log (actor, action, resource, before, after, timestamp)
      VALUES ('admin', 'UPDATE_SETTINGS', 'system_settings', null, ?, ?)
    `, [JSON.stringify(req.body), new Date().toISOString()]);

    res.json({ success: true, settings: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/tickets/:id - CMS Ticket Edit
app.put('/api/admin/tickets/:id', async (req, res) => {
  try {
    const { title, description, severity, priority, status, environment, owner } = req.body;
    const existing = await db.get("SELECT * FROM tickets WHERE id = ?", [req.params.id]);
    if (!existing) return res.status(404).json({ error: "Ticket not found" });

    const now = new Date().toISOString();
    await db.run(`
      UPDATE tickets 
      SET title = COALESCE(?, title),
          description = COALESCE(?, description),
          severity = COALESCE(?, severity),
          priority = COALESCE(?, priority),
          status = COALESCE(?, status),
          environment = COALESCE(?, environment),
          owner = COALESCE(?, owner),
          updated_at = ?
      WHERE id = ?
    `, [title, description, severity, priority, status, environment, owner, now, req.params.id]);

    await db.run(`
      INSERT INTO audit_log (actor, action, resource, before, after, timestamp)
      VALUES ('admin', 'EDIT_TICKET', ?, ?, ?, ?)
    `, [`ticket/${req.params.id}`, JSON.stringify(existing), JSON.stringify(req.body), now]);

    const updated = await db.get("SELECT * FROM tickets WHERE id = ?", [req.params.id]);
    res.json({ success: true, ticket: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/admin/tickets/:id - CMS Ticket Delete
app.delete('/api/admin/tickets/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const existing = await db.get("SELECT * FROM tickets WHERE id = ?", [id]);
    if (!existing) return res.status(404).json({ error: "Ticket not found" });

    await db.run("DELETE FROM ticket_events WHERE ticket_id = ?", [id]);
    await db.run("DELETE FROM agent_runs WHERE ticket_id = ?", [id]);
    await db.run("DELETE FROM validations WHERE ticket_id = ?", [id]);
    await db.run("DELETE FROM investigations WHERE ticket_id = ?", [id]);
    await db.run("DELETE FROM changes WHERE ticket_id = ?", [id]);
    await db.run("DELETE FROM pull_requests WHERE ticket_id = ?", [id]);
    await db.run("DELETE FROM tickets WHERE id = ?", [id]);

    await db.run(`
      INSERT INTO audit_log (actor, action, resource, before, after, timestamp)
      VALUES ('admin', 'DELETE_TICKET', ?, ?, 'DELETED', ?)
    `, [`ticket/${id}`, JSON.stringify(existing), new Date().toISOString()]);

    res.json({ success: true, message: `Ticket #${id} and associated runs deleted successfully.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin/sandbox/file - CMS Code Editor Save
app.post('/api/admin/sandbox/file', async (req, res) => {
  try {
    const { filename, content } = req.body;
    if (!filename || content === undefined) {
      return res.status(400).json({ error: "Filename and content are required." });
    }

    await sandbox.writeFile(filename, content);
    await db.run(`
      INSERT INTO audit_log (actor, action, resource, before, after, timestamp)
      VALUES ('admin', 'EDIT_SANDBOX_FILE', ?, null, 'Updated via CMS Editor', ?)
    `, [`sandbox/${filename}`, new Date().toISOString()]);

    res.json({ success: true, message: `File ${filename} saved to sandbox successfully.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/export-logs - Export Audit Logs as CSV or JSON
app.get('/api/admin/export-logs', async (req, res) => {
  try {
    const format = (req.query.format || 'json').toLowerCase();
    const logs = await db.all("SELECT * FROM audit_log ORDER BY id DESC");

    if (format === 'csv') {
      let csv = "id,actor,action,resource,before,after,timestamp\n";
      logs.forEach(l => {
        const clean = (val) => `"${String(val || '').replace(/"/g, '""')}"`;
        csv += `${l.id},${clean(l.actor)},${clean(l.action)},${clean(l.resource)},${clean(l.before)},${clean(l.after)},${clean(l.timestamp)}\n`;
      });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="audit_logs.csv"');
      return res.send(csv);
    }

    res.json({ success: true, logs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

let server;

async function startServer(port = PORT) {
  await db.initializeDatabase();
  if (server?.listening) return server;

  await new Promise((resolve, reject) => {
    server = app.listen(port, resolve);
    server.once('error', reject);
  });

  console.log(`[Server] Express running at http://localhost:${port}`);
  return server;
}

// Enterprise IT Operations Platform endpoints
const lifecycleMap = { PENDING: 'New', INTAKE: 'New', TRIAGED: 'Assigned', INVESTIGATING: 'In Progress', REPRODUCED: 'In Progress', FIXING: 'In Progress', VALIDATING: 'In Progress', PR_OPEN: 'Waiting', AI_REVIEW: 'Waiting', HUMAN_REVIEW: 'Waiting', MERGED: 'Resolved', REJECTED: 'Closed', BLOCKED: 'Waiting' };
const priorityMinutes = { Critical: 120, High: 240, Medium: 720, Low: 2880 };
const aiForTicket = (ticket) => {
  const text = `${ticket.title} ${ticket.description}`.toLowerCase();
  const category = /vpn|network|wifi|connection|gateway/.test(text) ? 'Network' : /login|auth|password|mfa|access/.test(text) ? 'Identity & Access' : /laptop|desktop|monitor|device/.test(text) ? 'End User Computing' : 'Application Support';
  const team = category === 'Network' ? 'Infrastructure' : category === 'Identity & Access' ? 'Identity Operations' : category === 'End User Computing' ? 'Workplace Technology' : 'Applications';
  return { category, team, priority: ticket.priority || ticket.severity || 'Medium', confidence: 92, summary: `${ticket.title} requires ${team.toLowerCase()} review.`, solution: category === 'Network' ? 'Check VPN gateway health and certificate validity before reconnecting the user.' : 'Review recent changes, validate access, and use the relevant runbook.', rootCause: category === 'Network' ? 'Potential connectivity or VPN certificate issue.' : 'Configuration or access state may be out of sync.' };
};
app.get('/api/platform/overview', async (req, res) => {
  try {
    const tickets = await db.all('SELECT * FROM tickets ORDER BY updated_at DESC');
    const now = Date.now();
    const byPriority = ['Critical', 'High', 'Medium', 'Low'].map(priority => ({ label: priority, value: tickets.filter(t => (t.priority || t.severity) === priority).length }));
    const active = tickets.filter(t => !['MERGED','REJECTED'].includes(t.status));
    const breached = active.filter(t => now - new Date(t.created_at).getTime() > (priorityMinutes[t.priority || t.severity] || 720) * 60000).length;
    res.json({ kpis: { total: tickets.length, open: active.length, critical: tickets.filter(t => t.severity === 'Critical').length, breached, avgResolution: '3.8h', aiAssisted: '78%', csat: '4.7/5' }, byPriority, workload: [{label:'Infrastructure',value:4},{label:'Applications',value:3},{label:'Workplace',value:2},{label:'Identity',value:2}], insight: 'Network-related requests are trending upward this week. Review VPN gateway health and certificate rotation.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/tickets/:id/ai', async (req, res) => {
  try { const ticket = await db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id]); if (!ticket) return res.status(404).json({error:'Ticket not found'}); const similar = await db.all('SELECT id, external_id, title, status FROM tickets WHERE id != ? ORDER BY updated_at DESC LIMIT 3', [req.params.id]); const articles = await db.all('SELECT * FROM knowledge_articles ORDER BY helpful DESC LIMIT 3'); res.json({ ...aiForTicket(ticket), similar, articles }); } catch (e) { res.status(500).json({error:e.message}); }
});
app.patch('/api/tickets/:id/lifecycle', async (req, res) => {
  try { const { status, owner } = req.body; const ticket = await db.get('SELECT * FROM tickets WHERE id=?', [req.params.id]); if (!ticket) return res.status(404).json({error:'Ticket not found'}); const pipelineStatus = {New:'PENDING',Assigned:'TRIAGED','In Progress':'FIXING',Waiting:'HUMAN_REVIEW',Resolved:'MERGED',Closed:'REJECTED'}[status] || ticket.status; const now = new Date().toISOString(); await db.run('UPDATE tickets SET status=?, owner=COALESCE(?,owner), updated_at=? WHERE id=?',[pipelineStatus,owner,now,req.params.id]); await db.run("INSERT INTO ticket_events (ticket_id,event_type,actor,payload,timestamp) VALUES (?, 'LIFECYCLE_UPDATE','Operations Portal',?,?)",[req.params.id,JSON.stringify({from:lifecycleMap[ticket.status],to:status}),now]); await db.run('INSERT INTO notifications (title,body,type,created_at) VALUES (?,?,?,?)',['Ticket updated', `${ticket.external_id} moved to ${status}`, 'ticket', now]); res.json({success:true}); } catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/knowledge', async (req,res)=>{ try { res.json(await db.all('SELECT * FROM knowledge_articles ORDER BY helpful DESC, updated_at DESC')); } catch(e){res.status(500).json({error:e.message});} });
app.post('/api/knowledge/:id/helpful', async (req,res)=>{ try { await db.run('UPDATE knowledge_articles SET helpful=helpful+1 WHERE id=?',[req.params.id]); res.json({success:true}); } catch(e){res.status(500).json({error:e.message});} });
app.get('/api/assets', async (req,res)=>{ try { const assets=await db.all('SELECT * FROM assets ORDER BY asset_tag'); const tickets=await db.all('SELECT description, title FROM tickets'); res.json(assets.map(a=>({...a, related_tickets:tickets.filter(t=>`${t.title} ${t.description}`.toLowerCase().includes(a.asset_tag.toLowerCase())).length}))); }catch(e){res.status(500).json({error:e.message});} });
app.get('/api/incidents', async (req,res)=>{ try { const incidents=await db.all('SELECT * FROM incidents ORDER BY updated_at DESC'); for(const i of incidents){i.tickets=await db.all('SELECT t.id,t.external_id,t.title,t.status FROM tickets t JOIN incident_tickets it ON it.ticket_id=t.id WHERE it.incident_id=?',[i.id]);} res.json(incidents); }catch(e){res.status(500).json({error:e.message});} });
app.post('/api/incidents', async (req,res)=>{ try { const {title,severity='High',commander='On-call Manager',services='Core Services',ticketIds=[]}=req.body; const now=new Date().toISOString(); const result=await db.run('INSERT INTO incidents (incident_key,title,severity,status,commander,services,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',[`INC-${Math.floor(1000+Math.random()*9000)}`,title,severity,'Investigating',commander,services,now,now]); for(const id of ticketIds) await db.run('INSERT OR IGNORE INTO incident_tickets (incident_id,ticket_id) VALUES (?,?)',[result.id,id]); await db.run('INSERT INTO notifications (title,body,type,created_at) VALUES (?,?,?,?)',['Incident created',title,'incident',now]); res.json({success:true,id:result.id}); }catch(e){res.status(500).json({error:e.message});} });
app.get('/api/notifications', async (req,res)=>{try{res.json(await db.all('SELECT * FROM notifications ORDER BY id DESC LIMIT 20'));}catch(e){res.status(500).json({error:e.message});}});
db.run(`CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, incident_key TEXT UNIQUE, title TEXT, severity TEXT, status TEXT, commander TEXT, services TEXT, root_cause TEXT, resolution TEXT, created_at TEXT, updated_at TEXT)`).catch(console.error);
db.run(`CREATE TABLE IF NOT EXISTS incident_tickets (incident_id INTEGER, ticket_id INTEGER, PRIMARY KEY (incident_id,ticket_id))`).catch(console.error);
db.run(`CREATE TABLE IF NOT EXISTS knowledge_articles (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, category TEXT, tags TEXT, helpful INTEGER DEFAULT 0, not_helpful INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)`).catch(console.error);
db.run(`CREATE TABLE IF NOT EXISTS assets (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_tag TEXT UNIQUE, name TEXT, type TEXT, assigned_to TEXT, status TEXT, warranty_until TEXT, created_at TEXT)`).catch(console.error);
db.run(`CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, type TEXT, is_read INTEGER DEFAULT 0, created_at TEXT)`).catch(console.error);
(async () => {
  try {
    const now = new Date().toISOString();
    const articleCount = await db.get('SELECT count(*) AS count FROM knowledge_articles');
    if (!articleCount.count) {
      await db.run('INSERT INTO knowledge_articles (title,body,category,tags,helpful,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',['Restore secure VPN access','Verify the VPN certificate expiry, renew the certificate, restart the gateway service, and ask users to reconnect after five minutes.','Network','vpn, certificate, remote access',42,now,now]);
      await db.run('INSERT INTO knowledge_articles (title,body,category,tags,helpful,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',['Resolve laptop sign-in problems','Confirm the account is active, clear cached credentials, and re-enrol the device when MFA remains out of sync.','Identity','login, mfa, laptop',28,now,now]);
    }
    const assetCount = await db.get('SELECT count(*) AS count FROM assets');
    if (!assetCount.count) {
      await db.run('INSERT INTO assets (asset_tag,name,type,assigned_to,status,warranty_until,created_at) VALUES (?,?,?,?,?,?,?)',['LAP-2048','MacBook Pro 14 inch','Laptop','Aarav Shah','In use','2027-04-18',now]);
      await db.run('INSERT INTO assets (asset_tag,name,type,assigned_to,status,warranty_until,created_at) VALUES (?,?,?,?,?,?,?)',['NET-118','VPN Edge Gateway','Network device','Infrastructure','Operational','2028-01-11',now]);
    }
  } catch (err) { console.error('Enterprise module seed failed:', err.message); }
})();
const frontendDist = path.join(__dirname, '../../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res) => res.sendFile(path.join(frontendDist, 'index.html')));
}
if (require.main === module) {
  startServer().catch(err => {
    console.error("Database initialization failed:", err);
    process.exitCode = 1;
  });
}

module.exports = { app, startServer };