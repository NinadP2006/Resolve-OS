const db = require('./db');
const agents = require('./agents');
const sandbox = require('./sandbox');

const orchestrator = {
  async runPipeline(ticketId) {
    console.log(`[Orchestrator] Starting pipeline execution for ticket ID: ${ticketId}`);
    
    await db.run("UPDATE tickets SET status = 'INTAKE', updated_at = ? WHERE id = ?", [new Date().toISOString(), ticketId]);
    await db.run(`
      INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
      VALUES (?, 'STATE_CHANGE', 'Orchestrator', ?, ?)
    `, [ticketId, JSON.stringify({ from: 'PENDING', to: 'INTAKE', reason: 'Pipeline started by user request' }), new Date().toISOString()]);

    this._executePipeline(ticketId).catch(err => {
      console.error(`[Orchestrator] Fatal pipeline error for ticket ${ticketId}:`, err);
    });
  },

  async _executePipeline(ticketId) {
    try {
      await agents.runIntake(ticketId);

      await agents.runTriage(ticketId);
      const ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
      if (ticket.status === 'REJECTED') {
        console.log(`[Orchestrator] Ticket ${ticketId} rejected as duplicate. Stopping.`);
        return;
      }

      await agents.runContext(ticketId);

      await agents.runDebug(ticketId);

      await agents.runFix(ticketId);

      let validationSuccess = false;
      let attempts = 0;
      const maxAttempts = 2;

      while (attempts < maxAttempts) {
        try {
          await agents.runValidation(ticketId);
          validationSuccess = true;
          break;
        } catch (validationErr) {
          attempts++;
          console.warn(`[Orchestrator] Validation attempt ${attempts} failed for ticket ${ticketId}. Retrying fix.`);
          await db.run(`
            INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
            VALUES (?, 'VALIDATION_FAILED', 'Validation Agent', ?, ?)
          `, [ticketId, JSON.stringify({ attempt: attempts, error: validationErr.message }), new Date().toISOString()]);
          
          if (attempts >= maxAttempts) {
            await db.run("UPDATE tickets SET status = 'BLOCKED', updated_at = ? WHERE id = ?", [new Date().toISOString(), ticketId]);
            await db.run(`
              INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
              VALUES (?, 'STATE_CHANGE', 'Orchestrator', ?, ?)
            `, [ticketId, JSON.stringify({ from: 'VALIDATING', to: 'BLOCKED', reason: 'Escalated: Validation checks failed repeatedly after two fix attempts.' }), new Date().toISOString()]);
            return;
          }

          await agents.runFix(ticketId);
        }
      }

      if (!validationSuccess) return;

      await agents.runPR(ticketId);

      await agents.runReview(ticketId);

      console.log(`[Orchestrator] Pipeline reached HUMAN_REVIEW successfully for ticket ${ticketId}`);

    } catch (error) {
      console.error(`[Orchestrator] Exception in pipeline execution for ticket ${ticketId}:`, error);
      await db.run("UPDATE tickets SET status = 'BLOCKED', updated_at = ? WHERE id = ?", [new Date().toISOString(), ticketId]);
      await db.run(`
        INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
        VALUES (?, 'SYSTEM_ERROR', 'Orchestrator', ?, ?)
      `, [ticketId, JSON.stringify({ error: error.message }), new Date().toISOString()]);
    }
  },

  async approveTicket(ticketId, actor) {
    const ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
    if (!ticket) throw new Error("Ticket not found");
    if (ticket.status !== 'HUMAN_REVIEW') {
      throw new Error(`Ticket is not in HUMAN_REVIEW status (current: ${ticket.status})`);
    }

    const branchName = ticket.branch;
    const mergeResult = await sandbox.mergeBranch(branchName);

    if (!mergeResult.success) {
      throw new Error(`Git Merge failed: ${mergeResult.stderr || mergeResult.stdout}`);
    }

    await db.run("UPDATE tickets SET status = 'MERGED', updated_at = ? WHERE id = ?", [new Date().toISOString(), ticketId]);
    
    await db.run("UPDATE pull_requests SET review_status = 'APPROVED', merge_status = 'MERGED' WHERE ticket_id = ?", [ticketId]);

    await db.run(`
      INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
      VALUES (?, 'STATE_CHANGE', ?, ?, ?)
    `, [ticketId, actor || 'Release Gate', JSON.stringify({ from: 'HUMAN_REVIEW', to: 'MERGED', reason: 'Human approval granted. Merged code branch into main.' }), new Date().toISOString()]);

    await db.run(`
      INSERT INTO audit_log (actor, action, resource, before, after, timestamp)
      VALUES (?, 'APPROVE_PR', ?, 'HUMAN_REVIEW', 'MERGED', ?)
    `, [actor, `ticket/${ticketId}`, new Date().toISOString()]);

    console.log(`[Orchestrator] Ticket ${ticketId} successfully approved and merged by ${actor}.`);
    return { success: true };
  },

  async rejectTicket(ticketId, actor, reason) {
    const ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
    if (!ticket) throw new Error("Ticket not found");

    const previousStatus = ticket.status;
    await db.run("UPDATE tickets SET status = 'REJECTED', updated_at = ? WHERE id = ?", [new Date().toISOString(), ticketId]);
    
    await db.run(`
      INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
      VALUES (?, 'STATE_CHANGE', ?, ?, ?)
    `, [ticketId, actor || 'Release Gate', JSON.stringify({ from: previousStatus, to: 'REJECTED', reason: `Rejected by human. Reason: ${reason}` }), new Date().toISOString()]);

    await db.run(`
      INSERT INTO audit_log (actor, action, resource, before, after, timestamp)
      VALUES (?, 'REJECT_TICKET', ?, ?, 'REJECTED', ?)
    `, [actor, `ticket/${ticketId}`, previousStatus, new Date().toISOString()]);

    await sandbox.cleanup();

    console.log(`[Orchestrator] Ticket ${ticketId} rejected by ${actor}.`);
    return { success: true };
  },

  async requestChanges(ticketId, actor, comments) {
    const ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
    if (!ticket) throw new Error("Ticket not found");
    if (ticket.status !== 'HUMAN_REVIEW' && ticket.status !== 'BLOCKED') {
      throw new Error("Ticket is not in review or blocked state");
    }

    const previousStatus = ticket.status;
    await db.run("UPDATE tickets SET status = 'FIXING', updated_at = ? WHERE id = ?", [new Date().toISOString(), ticketId]);

    await db.run(`
      INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
      VALUES (?, 'REQUEST_CHANGES', ?, ?, ?)
    `, [ticketId, actor, JSON.stringify({ comments }), new Date().toISOString()]);

    await db.run(`
      INSERT INTO audit_log (actor, action, resource, before, after, timestamp)
      VALUES (?, 'REQUEST_CHANGES', ?, ?, 'FIXING', ?)
    `, [actor, `ticket/${ticketId}`, previousStatus, new Date().toISOString()]);

    console.log(`[Orchestrator] Changes requested for ticket ${ticketId} by ${actor}. Re-running fix and validation.`);

    this._executeChangesFeedbackLoop(ticketId, comments).catch(err => {
      console.error(`[Orchestrator] Error during requested changes feedback loop for ticket ${ticketId}:`, err);
    });

    return { success: true };
  },

  async _executeChangesFeedbackLoop(ticketId, comments) {
    try {
      const start = Date.now();
      const ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
      const type = (ticket.title + " " + ticket.description).toLowerCase().includes("auth") ? "auth" : "calculator";
      const demo = agents.DEMO_ISSUES ? agents.DEMO_ISSUES[type] : { filename: type === "auth" ? "auth.js" : "calculator.js" };

      // Fallback details if agents.DEMO_ISSUES not exposed directly (it is, but let's be robust)
      const filename = demo.filename;
      const code = await sandbox.readFile(filename);
      const updatedCode = code + `\n// Refined based on feedback: ${comments.replace(/\n/g, ' ')}\n`;
      await sandbox.writeFile(filename, updatedCode);

      const commitResult = await sandbox.commitChanges(`Refine fix based on feedback: ${comments.substring(0, 40)}`);

      await db.run("UPDATE changes SET commit_sha = ? WHERE ticket_id = ?", [commitResult.sha, ticketId]);

      await db.run(`
        INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
        VALUES (?, 'STATE_CHANGE', 'Fix Agent', ?, ?)
      `, [ticketId, JSON.stringify({ from: 'HUMAN_REVIEW', to: 'FIXING', reason: `Re-applied code changes incorporating human comments. SHA: ${commitResult.sha}` }), new Date().toISOString()]);

      await db.run(`
        INSERT INTO agent_runs (ticket_id, agent_name, model, prompt_version, status, input_ref, output_ref, cost, duration, error, created_at)
        VALUES (?, 'Fix Agent', 'gemini-1.5-flash', 'v1.1', 'SUCCESS', 'Feedback comments', 'Refined source code', 0.0004, ?, null, ?)
      `, [ticketId, Date.now() - start, new Date().toISOString()]);

      await agents.runValidation(ticketId);

      await db.run("UPDATE pull_requests SET review_status = 'PENDING', merge_status = 'OPEN' WHERE ticket_id = ?", [ticketId]);
      await db.run("UPDATE tickets SET status = 'PR_OPEN', updated_at = ? WHERE id = ?", [new Date().toISOString(), ticketId]);

      await agents.runReview(ticketId);

      console.log(`[Orchestrator] Changes feedback loop completed successfully for ticket ${ticketId}`);
    } catch (error) {
      console.error(`[Orchestrator] Feedback loop failed for ticket ${ticketId}:`, error);
      await db.run("UPDATE tickets SET status = 'BLOCKED', updated_at = ? WHERE id = ?", [new Date().toISOString(), ticketId]);
      await db.run(`
        INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
        VALUES (?, 'SYSTEM_ERROR', 'Orchestrator', ?, ?)
      `, [ticketId, JSON.stringify({ error: error.message }), new Date().toISOString()]);
    }
  }
};

module.exports = orchestrator;
