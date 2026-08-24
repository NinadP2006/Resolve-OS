const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const db = require('../src/db');
const orchestrator = require('../src/orchestrator');
const sandbox = require('../src/sandbox');
const agents = require('../src/agents');

describe('AI Engineering Automation Pipeline - Industry Readiness Test Suite', () => {

  before(async () => {
    await db.init();
    await sandbox.init();
    await sandbox.cleanup();
  });

  after(async () => {
    await sandbox.cleanup();
  });

  it('1. [Happy Path] Complete lifecycle from Incident Intake to Human Approval & Git Merge', async () => {
    const timestamp = Date.now();
    const result = await db.run(`
      INSERT INTO tickets (external_id, source, title, description, severity, priority, status, repository, branch, environment, owner, created_at, updated_at)
      VALUES (?, 'GitHub Issue', ?, ?, 'High', 'High', 'PENDING', 'sandbox', 'main', 'Production', 'Unassigned', ?, ?)
    `, [
      `PROD-${timestamp}`,
      `ZeroDivisionError in calculator math library - ${timestamp}`,
      'Division by zero raises uncaught exception instead of returning null.',
      new Date().toISOString(),
      new Date().toISOString()
    ]);

    const ticketId = result.lastID;
    assert.ok(ticketId > 0, 'Ticket must be created with valid ID');

    // Run pipeline through orchestrator
    await orchestrator.runPipeline(ticketId);

    // Poll until HUMAN_REVIEW is reached
    let ticket;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 600));
      ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
      if (ticket.status === 'HUMAN_REVIEW' || ticket.status === 'BLOCKED' || ticket.status === 'REJECTED') {
        break;
      }
    }

    assert.strictEqual(ticket.status, 'HUMAN_REVIEW', 'Ticket must successfully reach HUMAN_REVIEW state');

    // Verify Agent Execution Runs
    const runs = await db.all("SELECT * FROM agent_runs WHERE ticket_id = ?", [ticketId]);
    assert.strictEqual(runs.length, 8, 'All 8 agents must have recorded successful execution runs');

    // Verify Investigation & Diagnostics
    const investigation = await db.get("SELECT * FROM investigations WHERE ticket_id = ?", [ticketId]);
    assert.ok(investigation, 'Diagnostic investigation must be logged');
    assert.ok(investigation.root_cause.length > 0, 'Root cause must be identified');
    assert.ok(investigation.confidence >= 0.8, 'Confidence score must be >= 0.8');

    // Verify Validation Check Runs
    const validations = await db.all("SELECT * FROM validations WHERE ticket_id = ?", [ticketId]);
    assert.ok(validations.length >= 2, 'Linter and Unit tests must be logged');
    validations.forEach(v => {
      assert.strictEqual(v.status, 'SUCCESS', `Check ${v.check_name} must pass`);
    });

    // Verify PR Creation
    const pr = await db.get("SELECT * FROM pull_requests WHERE ticket_id = ?", [ticketId]);
    assert.ok(pr, 'Pull Request must be generated');
    assert.ok(pr.pr_number > 0, 'PR must have a valid issue number');

    // Verify Human Gate Release Action: Approve & Merge
    const approveResult = await orchestrator.approveTicket(ticketId, 'Lead Release Engineer');
    assert.strictEqual(approveResult.success, true, 'Approve and merge action must succeed');

    const finalTicket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
    assert.strictEqual(finalTicket.status, 'MERGED', 'Ticket status must be MERGED');

    const updatedPR = await db.get("SELECT * FROM pull_requests WHERE ticket_id = ?", [ticketId]);
    assert.strictEqual(updatedPR.merge_status, 'MERGED', 'PR merge status must be MERGED');
  });

  it('2. [Error Handling] Duplicate ticket is detected by Triage Agent and safely rejected', async () => {
    const title = `Duplicate Test Issue - ${Date.now()}`;
    const now = new Date().toISOString();

    // Insert first ticket and resolve it
    const ticket1 = await db.run(`
      INSERT INTO tickets (external_id, source, title, description, severity, priority, status, repository, branch, environment, owner, created_at, updated_at)
      VALUES (?, 'Slack Incident', ?, 'First report', 'Medium', 'Medium', 'MERGED', 'sandbox', 'main', 'Staging', 'Dev', ?, ?)
    `, [`DUP-1-${Date.now()}`, title, now, now]);

    // Insert identical second ticket
    const ticket2 = await db.run(`
      INSERT INTO tickets (external_id, source, title, description, severity, priority, status, repository, branch, environment, owner, created_at, updated_at)
      VALUES (?, 'Slack Incident', ?, 'Second duplicate report', 'Medium', 'Medium', 'PENDING', 'sandbox', 'main', 'Staging', 'Dev', ?, ?)
    `, [`DUP-2-${Date.now()}`, title, now, now]);

    await orchestrator.runPipeline(ticket2.lastID);

    // Wait for triage
    await new Promise(r => setTimeout(r, 1200));

    const secondTicket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticket2.lastID]);
    assert.strictEqual(secondTicket.status, 'REJECTED', 'Duplicate ticket must be rejected by Triage Agent');

    const events = await db.all("SELECT * FROM ticket_events WHERE ticket_id = ?", [ticket2.lastID]);
    const duplicateEvent = events.find(e => e.payload && e.payload.includes('Duplicate'));
    assert.ok(duplicateEvent, 'Duplicate event must be recorded in audit log');
  });

  it('3. [Feedback Loop] Human Gate Request Changes triggers Fix Agent refinement & re-validation', async () => {
    const timestamp = Date.now();
    const result = await db.run(`
      INSERT INTO tickets (external_id, source, title, description, severity, priority, status, repository, branch, environment, owner, created_at, updated_at)
      VALUES (?, 'Sentry Alert', ?, 'Division by zero in calc', 'High', 'High', 'PENDING', 'sandbox', 'main', 'Production', 'Unassigned', ?, ?)
    `, [
      `FBACK-${timestamp}`,
      `Refinement Loop Issue - ${timestamp}`,
      new Date().toISOString(),
      new Date().toISOString()
    ]);

    const ticketId = result.lastID;
    await orchestrator.runPipeline(ticketId);

    // Wait for HUMAN_REVIEW
    let ticket;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 600));
      ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
      if (ticket.status === 'HUMAN_REVIEW') break;
    }
    assert.strictEqual(ticket.status, 'HUMAN_REVIEW');

    // Request Changes
    const reqResult = await orchestrator.requestChanges(ticketId, 'QA Engineer', 'Add logging message when division by zero occurs.');
    assert.strictEqual(reqResult.success, true);

    // Wait for feedback loop completion
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 600));
      ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
      if (ticket.status === 'HUMAN_REVIEW') break;
    }

    assert.strictEqual(ticket.status, 'HUMAN_REVIEW', 'Ticket must return to HUMAN_REVIEW after refinement');

    const events = await db.all("SELECT * FROM ticket_events WHERE ticket_id = ?", [ticketId]);
    const requestEvent = events.find(e => e.event_type === 'REQUEST_CHANGES');
    assert.ok(requestEvent, 'REQUEST_CHANGES event must be logged');
  });

  it('4. [Rejection & Rollback] Human Gate Rejection safely cleans sandbox and records audit trail', async () => {
    const timestamp = Date.now();
    const result = await db.run(`
      INSERT INTO tickets (external_id, source, title, description, severity, priority, status, repository, branch, environment, owner, created_at, updated_at)
      VALUES (?, 'REST API', ?, 'Calculation bug', 'Low', 'Low', 'PENDING', 'sandbox', 'main', 'Dev', 'Unassigned', ?, ?)
    `, [
      `REJ-${timestamp}`,
      `Rejection Test Incident - ${timestamp}`,
      new Date().toISOString(),
      new Date().toISOString()
    ]);

    const ticketId = result.lastID;
    await orchestrator.runPipeline(ticketId);

    // Wait for HUMAN_REVIEW
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 600));
      const t = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
      if (t.status === 'HUMAN_REVIEW') break;
    }

    const rejResult = await orchestrator.rejectTicket(ticketId, 'Security Lead', 'Proposed patch does not satisfy compliance policy.');
    assert.strictEqual(rejResult.success, true);

    const rejectedTicket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
    assert.strictEqual(rejectedTicket.status, 'REJECTED', 'Ticket status must be REJECTED');

    const auditLog = await db.get("SELECT * FROM audit_log WHERE resource = ? AND action = 'REJECT_TICKET'", [`ticket/${ticketId}`]);
    assert.ok(auditLog, 'Audit log entry for rejection must be recorded');
  });

  it('5. [Multi-File Scenario] Null profile TypeError in auth.js is diagnosed and resolved', async () => {
    const timestamp = Date.now();
    const result = await db.run(`
      INSERT INTO tickets (external_id, source, title, description, severity, priority, status, repository, branch, environment, owner, created_at, updated_at)
      VALUES (?, 'Sentry Alert', ?, 'Cannot read properties of null (reading role) in login', 'Critical', 'High', 'PENDING', 'sandbox', 'main', 'Production', 'Unassigned', ?, ?)
    `, [
      `AUTH-${timestamp}`,
      `TypeError in auth login handler - ${timestamp}`,
      new Date().toISOString(),
      new Date().toISOString()
    ]);

    const ticketId = result.lastID;
    await orchestrator.runPipeline(ticketId);

    // Wait for HUMAN_REVIEW
    let ticket;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 600));
      ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
      if (ticket.status === 'HUMAN_REVIEW') break;
    }

    assert.strictEqual(ticket.status, 'HUMAN_REVIEW');

    const change = await db.get("SELECT * FROM changes WHERE ticket_id = ?", [ticketId]);
    assert.strictEqual(change.files_changed, 'auth.js', 'auth.js must be targeted and patched');

    // Approve & Merge
    await orchestrator.approveTicket(ticketId, 'Auth Team Lead');
    const finalTicket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
    assert.strictEqual(finalTicket.status, 'MERGED');
  });

});
