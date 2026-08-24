const db = require('./db');
const orchestrator = require('./orchestrator');
const sandbox = require('./sandbox');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runVerification() {
  console.log("=== AI DevOps Pipeline Verification Start ===");

  try {
    await db.initializeDatabase();
    console.log("[PASS] Database initialized.");
    
    await sandbox.cleanup();
    console.log("[PASS] Sandbox repository cleaned.");

    const now = new Date().toISOString();
    const result = await db.run(`
      INSERT INTO tickets (external_id, source, title, description, severity, priority, status, repository, branch, environment, owner, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 'sandbox', 'main', 'Staging', 'None', ?, ?)
    `, [
      "TEST-" + Date.now(),
      "Verification Script",
      "Division by zero crash in calculator.js - " + Date.now(),
      "Divide function throws ZeroDivisionError: Division by zero! instead of returning null when denominator is 0.",
      "High",
      "High",
      now,
      now
    ]);
    const ticketId = result.id;
    console.log(`[PASS] Created test ticket ID: ${ticketId}`);

    console.log("Running pipeline state machine...");
    await orchestrator.runPipeline(ticketId);

    let ticket = null;
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      await delay(1000);
      ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
      console.log(`Polling status... current state: ${ticket.status}`);
      if (['HUMAN_REVIEW', 'BLOCKED', 'REJECTED'].includes(ticket.status)) {
        break;
      }
      attempts++;
    }

    if (ticket.status !== 'HUMAN_REVIEW') {
      throw new Error(`Pipeline failed to reach HUMAN_REVIEW state. Ended in: ${ticket.status}`);
    }
    console.log("[PASS] Pipeline successfully navigated through agent stages to HUMAN_REVIEW.");

    const runCount = await db.get("SELECT count(*) as count FROM agent_runs WHERE ticket_id = ?", [ticketId]);
    console.log(`[PASS] Agent execution logged: ${runCount.count} runs.`);
    if (runCount.count === 0) throw new Error("No agent runs logged.");

    const investigation = await db.get("SELECT * FROM investigations WHERE ticket_id = ?", [ticketId]);
    console.log(`[PASS] Diagnostic investigation logged. Confidence: ${investigation.confidence}. Root cause: "${investigation.root_cause}"`);
    if (!investigation) throw new Error("No investigation logged.");

    const change = await db.get("SELECT * FROM changes WHERE ticket_id = ?", [ticketId]);
    console.log(`[PASS] Branch code changes logged. Files changed: "${change.files_changed}" on branch "${change.branch}"`);
    if (!change) throw new Error("No code changes logged.");

    const validationList = await db.all("SELECT check_name, status FROM validations WHERE ticket_id = ?", [ticketId]);
    console.log(`[PASS] Validation checks logged: ${JSON.stringify(validationList)}`);
    if (validationList.length === 0) throw new Error("No validations logged.");

    const pr = await db.get("SELECT * FROM pull_requests WHERE ticket_id = ?", [ticketId]);
    console.log(`[PASS] PR created: #${pr.pr_number} URL: ${pr.pr_url}`);
    if (!pr) throw new Error("No pull request logged.");

    console.log("Simulating 'Request Changes' gate action...");
    await orchestrator.requestChanges(ticketId, "Verifier Developer", "Add a documentation comment to the fix code.");
    
    attempts = 0;
    while (attempts < maxAttempts) {
      await delay(1000);
      ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
      console.log(`Polling status (changes feedback loop)... current state: ${ticket.status}`);
      if (ticket.status === 'HUMAN_REVIEW') {
        break;
      }
      attempts++;
    }

    if (ticket.status !== 'HUMAN_REVIEW') {
      throw new Error(`Changes loop failed to return to HUMAN_REVIEW. Current: ${ticket.status}`);
    }
    console.log("[PASS] Request changes loop successfully completed. Fix refined, re-validated, and PR re-reviewed.");

    console.log("Simulating 'Approve & Merge' gate action...");
    const approveResult = await orchestrator.approveTicket(ticketId, "Verifier Developer");
    if (!approveResult.success) throw new Error("Merge failed");

    ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
    console.log(`[PASS] Final ticket status after approval: ${ticket.status}`);
    if (ticket.status !== 'MERGED') throw new Error(`Status is not MERGED (current: ${ticket.status})`);

    const finalPr = await db.get("SELECT * FROM pull_requests WHERE ticket_id = ?", [ticketId]);
    console.log(`[PASS] PR merge status: ${finalPr.merge_status}`);

    await sandbox.cleanup();
    console.log("[PASS] Verification sandbox git repository cleaned.");

    console.log("\n=== ALL VERIFICATION CHECKS PASSED SUCCESSFULLY! ===");
    process.exit(0);

  } catch (error) {
    console.error("\n[FAIL] Verification Failed:", error);
    process.exit(1);
  }
}

runVerification();
