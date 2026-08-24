const sandbox = require('./sandbox');
const db = require('./db');

const apiKey = process.env.GEMINI_API_KEY;

async function askGemini(prompt, systemInstruction, jsonMode = false) {
  if (!apiKey) return null;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {}
    };
    if (systemInstruction) {
      payload.systemInstruction = { parts: [{ text: systemInstruction }] };
    }
    if (jsonMode) {
      payload.generationConfig.responseMimeType = "application/json";
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Gemini API Error details:", errText);
      return null;
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return text || null;
  } catch (error) {
    console.error("Failed to fetch from Gemini:", error);
    return null;
  }
}

const DEMO_ISSUES = {
  calculator: {
    filename: 'calculator.js',
    testFilename: 'test/calculator.test.js',
    hypothesis: 'The divide function throws a ZeroDivisionError instead of returning null when b is 0. This is verified by calculator.test.js:18.',
    rootCause: 'calculator.js:18 checks if (b === 0) and throws an error, failing the strictEqual comparison in the test suite.',
    fixContent: `function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}

function multiply(a, b) {
  return a * b;
}

function divide(a, b) {
  // FIXED: Handles division by zero gracefully by returning null and printing warning
  if (b === 0) {
    console.warn("Warning: division by zero encountered. Returning null.");
    return null;
  }
  return a / b;
}

module.exports = { add, subtract, multiply, divide };`,
    riskSummary: 'Low risk. Only affects division functionality. Safe fallback value returned.',
    filesChanged: 'calculator.js',
    testChanges: 'None. Existing test verifies this fix.'
  },
  auth: {
    filename: 'auth.js',
    testFilename: 'test/auth.test.js',
    hypothesis: 'The login function crashes with TypeError: Cannot read properties of null (reading "role") when user profile is null.',
    rootCause: 'auth.js:16 accesses user.profile.role directly without checking if user.profile is null.',
    fixContent: `function login(username, password) {
  if (!username || !password) {
    return { success: false, error: "Credentials required" };
  }
  
  // Simulated database lookup
  if (username === "admin" && password === "secret") {
    const user = {
      id: 1,
      username: "admin",
      profile: null // profile is null
    };
    
    // FIXED: Safely access role with a fallback if profile is missing
    return {
      success: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.profile ? user.profile.role : "user"
      }
    };
  }
  
  return { success: false, error: "Invalid credentials" };
}

module.exports = { login };`,
    riskSummary: 'Medium risk. Affects authentication response. Validated with regression tests.',
    filesChanged: 'auth.js',
    testChanges: 'None. Existing regression test covers default role assertion.'
  }
};

function getIssueType(ticket) {
  const text = (ticket.title + " " + ticket.description).toLowerCase();
  if (text.includes("calculator") || text.includes("zero") || text.includes("divide")) {
    return "calculator";
  }
  if (text.includes("auth") || text.includes("login") || text.includes("profile") || text.includes("role")) {
    return "auth";
  }
  return "calculator";
}

const agents = {
  async runIntake(ticketId) {
    const start = Date.now();
    const ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);

    let normalized = {
      title: ticket.title,
      description: ticket.description,
      severity: ticket.severity || "Medium",
      priority: "Medium"
    };

    if (apiKey) {
      const prompt = `Normalize this engineering ticket raw data. Output as JSON with keys "title" (cleaned title), "description" (concise, clear details), "severity" (Low, Medium, High, Critical), "priority" (Low, Medium, High).
      Raw Title: ${ticket.title}
      Raw Description: ${ticket.description}`;
      const response = await askGemini(prompt, "You are a ticket cleaning/ingestion bot. Output clean JSON only.", true);
      if (response) {
        try {
          normalized = JSON.parse(response);
        } catch (e) {
          console.warn("Failed parsing Intake JSON. Using defaults.");
        }
      }
    }

    await db.run(
      "UPDATE tickets SET title = ?, description = ?, severity = ?, priority = ?, status = 'TRIAGED', updated_at = ? WHERE id = ?",
      [normalized.title, normalized.description, normalized.severity, normalized.priority, new Date().toISOString(), ticketId]
    );

    await db.run(`
      INSERT INTO agent_runs (ticket_id, agent_name, model, prompt_version, status, input_ref, output_ref, cost, duration, error, created_at)
      VALUES (?, 'Intake Agent', ?, 'v1.0', 'SUCCESS', 'Raw inputs', 'Normalized ticket structure', 0.0001, ?, null, ?)
    `, [ticketId, apiKey ? "gemini-1.5-flash" : "Mock-RuleEngine", Date.now() - start, new Date().toISOString()]);

    await db.run(`
      INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
      VALUES (?, 'STATE_CHANGE', 'Intake Agent', ?, ?)
    `, [ticketId, JSON.stringify({ from: "INTAKE", to: "TRIAGED", reason: "Normalized raw user issue input and updated ticket fields" }), new Date().toISOString()]);
  },

  async runTriage(ticketId) {
    const start = Date.now();
    const ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
    
    const otherTickets = await db.all("SELECT id, title FROM tickets WHERE id != ? AND status != 'REJECTED'", [ticketId]);
    let duplicateOf = null;
    
    for (const other of otherTickets) {
      if (other.title.toLowerCase() === ticket.title.toLowerCase()) {
        duplicateOf = other.id;
        break;
      }
    }

    let triageResult = {
      category: "bug",
      priority: ticket.priority || "Medium",
      isDuplicate: duplicateOf !== null,
      duplicateId: duplicateOf
    };

    if (apiKey) {
      const prompt = `Classify this ticket: Category (bug, feature, question), Priority (Low, Medium, High). Also list duplicate candidates.
      Ticket: ${ticket.title} - ${ticket.description}
      Existing tickets: ${JSON.stringify(otherTickets)}`;
      const response = await askGemini(prompt, "You are a triage routing bot. Output JSON with fields category, priority, isDuplicate (boolean), duplicateId (integer or null).", true);
      if (response) {
        try {
          triageResult = JSON.parse(response);
        } catch (e) {
          console.warn("Failed parsing Triage JSON.");
        }
      }
    }

    if (triageResult.isDuplicate) {
      await db.run("UPDATE tickets SET status = 'REJECTED', updated_at = ? WHERE id = ?", [new Date().toISOString(), ticketId]);
      await db.run(`
        INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
        VALUES (?, 'STATE_CHANGE', 'Triage Agent', ?, ?)
      `, [ticketId, JSON.stringify({ from: "TRIAGED", to: "REJECTED", reason: `Rejected: Duplicate of ticket #${triageResult.duplicateId}` }), new Date().toISOString()]);
    } else {
      await db.run("UPDATE tickets SET priority = ?, owner = 'Debug Agent', status = 'INVESTIGATING', updated_at = ? WHERE id = ?", [triageResult.priority, new Date().toISOString(), ticketId]);
      await db.run(`
        INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
        VALUES (?, 'STATE_CHANGE', 'Triage Agent', ?, ?)
      `, [ticketId, JSON.stringify({ from: "TRIAGED", to: "INVESTIGATING", reason: "Triage completed, routing to context retrieval and root cause debugging" }), new Date().toISOString()]);
    }

    await db.run(`
      INSERT INTO agent_runs (ticket_id, agent_name, model, prompt_version, status, input_ref, output_ref, cost, duration, error, created_at)
      VALUES (?, 'Triage Agent', ?, 'v1.0', 'SUCCESS', 'Ticket database', 'Triage route settings', 0.0001, ?, null, ?)
    `, [ticketId, apiKey ? "gemini-1.5-flash" : "Mock-RuleEngine", Date.now() - start, new Date().toISOString()]);
  },

  async runContext(ticketId) {
    const start = Date.now();
    const ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
    const type = getIssueType(ticket);
    const demo = DEMO_ISSUES[type];

    const code = await sandbox.readFile(demo.filename);
    const tests = await sandbox.readFile(demo.testFilename);

    const contextPayload = {
      retrieved_files: [demo.filename, demo.testFilename],
      dependencies: { node: "v22.20.0" },
      git_branch: "main",
      code_snippet: code.substring(0, 500) + '...',
      test_snippet: tests.substring(0, 500) + '...'
    };

    await db.run(`
      INSERT INTO agent_runs (ticket_id, agent_name, model, prompt_version, status, input_ref, output_ref, cost, duration, error, created_at)
      VALUES (?, 'Context Agent', ?, 'v1.0', 'SUCCESS', 'Sandbox workspace filesystem', ?, 0.0002, ?, null, ?)
    `, [ticketId, apiKey ? "gemini-1.5-flash" : "Mock-RuleEngine", JSON.stringify(contextPayload), Date.now() - start, new Date().toISOString()]);

    await db.run(`
      INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
      VALUES (?, 'CONTEXT_GATHERED', 'Context Agent', ?, ?)
    `, [ticketId, JSON.stringify({ files: [demo.filename, demo.testFilename], repo: "sandbox" }), new Date().toISOString()]);
  },

  async runDebug(ticketId) {
    const start = Date.now();
    const ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
    const type = getIssueType(ticket);
    const demo = DEMO_ISSUES[type];

    await sandbox.cleanup();
    // Run the specific test file that is failing initially
    const testRun = await sandbox.runTests(demo.testFilename);

    let investigation = {
      hypotheses: demo.hypothesis,
      evidence: testRun.stdout || testRun.stderr || "Reproduction test failure output.",
      reproduction_command: `node --test ${demo.testFilename}`,
      root_cause: demo.rootCause,
      confidence: 0.95
    };

    if (apiKey) {
      const code = await sandbox.readFile(demo.filename);
      const prompt = `We ran the tests and they failed with this output:
      ${investigation.evidence}
      
      Here is the code in ${demo.filename}:
      ${code}
      
      Formulate a hypothesis, find the root cause, and return JSON keys "hypotheses", "evidence", "reproduction_command", "root_cause", "confidence" (0.0 to 1.0).`;
      const response = await askGemini(prompt, "You are a debugging/investigation agent. Return JSON.", true);
      if (response) {
        try {
          investigation = JSON.parse(response);
          investigation.evidence = testRun.stdout || testRun.stderr;
        } catch (e) {
          console.warn("Failed parsing Debug JSON.");
        }
      }
    }

    await db.run(`
      INSERT INTO investigations (ticket_id, hypotheses, evidence, reproduction_command, root_cause, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [ticketId, investigation.hypotheses, investigation.evidence, investigation.reproduction_command, investigation.root_cause, investigation.confidence]);

    await db.run("UPDATE tickets SET status = 'REPRODUCED', updated_at = ? WHERE id = ?", [new Date().toISOString(), ticketId]);

    await db.run(`
      INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
      VALUES (?, 'STATE_CHANGE', 'Debug Agent', ?, ?)
    `, [ticketId, JSON.stringify({ from: "INVESTIGATING", to: "REPRODUCED", reason: `Successfully reproduced error using command: ${investigation.reproduction_command}` }), new Date().toISOString()]);

    await db.run(`
      INSERT INTO agent_runs (ticket_id, agent_name, model, prompt_version, status, input_ref, output_ref, cost, duration, error, created_at)
      VALUES (?, 'Debug Agent', ?, 'v1.0', 'SUCCESS', 'Sandbox logs', 'Root cause diagnostic details', 0.0005, ?, null, ?)
    `, [ticketId, apiKey ? "gemini-1.5-flash" : "Mock-RuleEngine", Date.now() - start, new Date().toISOString()]);
  },

  async runFix(ticketId) {
    const start = Date.now();
    const ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
    const type = getIssueType(ticket);
    const demo = DEMO_ISSUES[type];

    const { branchName } = await sandbox.createBranch(ticketId);

    let fixCode = demo.fixContent;

    if (apiKey) {
      const code = await sandbox.readFile(demo.filename);
      const investigation = await db.get("SELECT * FROM investigations WHERE ticket_id = ?", [ticketId]);
      const prompt = `Fix the code in ${demo.filename} according to this investigation.
      Root Cause: ${investigation.root_cause}
      Original Code:
      ${code}
      
      Output ONLY the absolute replacement content of the file. No explanation, no markdown backticks code fences. Just write the code lines.`;
      const response = await askGemini(prompt, "You are a code patching agent. Write full file content directly.");
      if (response && response.trim().length > 0) {
        fixCode = response.replace(/^```javascript\n|```$/g, '').trim();
      }
    }

    await sandbox.writeFile(demo.filename, fixCode);

    const commitResult = await sandbox.commitChanges(`Fix for ticket #${ticketId} - resolved bug in ${demo.filename}`);

    await db.run(`
      INSERT INTO changes (ticket_id, branch, commit_sha, files_changed, test_changes, risk_summary)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [ticketId, branchName, commitResult.sha, demo.filesChanged, demo.testChanges, demo.riskSummary]);

    await db.run("UPDATE tickets SET branch = ?, status = 'FIXING', updated_at = ? WHERE id = ?", [branchName, new Date().toISOString(), ticketId]);

    await db.run(`
      INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
      VALUES (?, 'STATE_CHANGE', 'Fix Agent', ?, ?)
    `, [ticketId, JSON.stringify({ from: "REPRODUCED", to: "FIXING", reason: `Applied code changes to branch ${branchName} and created commit: ${commitResult.sha}` }), new Date().toISOString()]);

    await db.run(`
      INSERT INTO agent_runs (ticket_id, agent_name, model, prompt_version, status, input_ref, output_ref, cost, duration, error, created_at)
      VALUES (?, 'Fix Agent', ?, 'v1.0', 'SUCCESS', 'Bug hypothesis', 'Modified source code files', 0.0006, ?, null, ?)
    `, [ticketId, apiKey ? "gemini-1.5-flash" : "Mock-RuleEngine", Date.now() - start, new Date().toISOString()]);
  },

  async runValidation(ticketId) {
    const start = Date.now();
    const ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
    const type = getIssueType(ticket);
    const demo = DEMO_ISSUES[type];
    
    const lintResult = await sandbox.runLint();
    await db.run(`
      INSERT INTO validations (ticket_id, check_name, command, status, logs_ref, duration)
      VALUES (?, 'Linter Check', 'npm run lint', ?, ?, ?)
    `, [ticketId, lintResult.success ? 'SUCCESS' : 'FAILURE', lintResult.stdout || lintResult.stderr, Date.now() - start]);

    const testStart = Date.now();
    // Validate only using the specific test file that relates to this ticket!
    const testResult = await sandbox.runTests(demo.testFilename);
    await db.run(`
      INSERT INTO validations (ticket_id, check_name, command, status, logs_ref, duration)
      VALUES (?, 'Unit Tests', 'npm test', ?, ?, ?)
    `, [ticketId, testResult.success ? 'SUCCESS' : 'FAILURE', testResult.stdout || testResult.stderr, Date.now() - testStart]);

    const finalStatus = (lintResult.success && testResult.success) ? 'SUCCESS' : 'FAILURE';

    await db.run("UPDATE tickets SET status = 'VALIDATING', updated_at = ? WHERE id = ?", [new Date().toISOString(), ticketId]);

    await db.run(`
      INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
      VALUES (?, 'STATE_CHANGE', 'Validation Agent', ?, ?)
    `, [ticketId, JSON.stringify({ from: "FIXING", to: "VALIDATING", reason: `Validation complete. Status: ${finalStatus}. Tests: ${testResult.success ? 'PASSED' : 'FAILED'}, Lint: ${lintResult.success ? 'PASSED' : 'FAILED'}` }), new Date().toISOString()]);

    await db.run(`
      INSERT INTO agent_runs (ticket_id, agent_name, model, prompt_version, status, input_ref, output_ref, cost, duration, error, created_at)
      VALUES (?, 'Validation Agent', ?, 'v1.0', 'SUCCESS', 'Branch source code', 'CI verification report log', 0.0002, ?, null, ?)
    `, [ticketId, apiKey ? "gemini-1.5-flash" : "Mock-RuleEngine", Date.now() - start, new Date().toISOString()]);

    if (finalStatus === 'FAILURE') {
      throw new Error("Validation Checks Failed! Agent will retry or escalate.");
    }
  },

  async runPR(ticketId) {
    const start = Date.now();
    const ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
    const change = await db.get("SELECT * FROM changes WHERE ticket_id = ?", [ticketId]);

    const prNumber = Math.floor(Math.random() * 1000) + 100;
    const prUrl = `https://github.com/org/sandbox/pull/${prNumber}`;

    await db.run(`
      INSERT INTO pull_requests (ticket_id, pr_url, pr_number, review_status, merge_status)
      VALUES (?, ?, ?, 'PENDING', 'OPEN')
    `, [ticketId, prUrl, prNumber]);

    await db.run("UPDATE tickets SET status = 'PR_OPEN', updated_at = ? WHERE id = ?", [new Date().toISOString(), ticketId]);

    await db.run(`
      INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
      VALUES (?, 'STATE_CHANGE', 'PR Agent', ?, ?)
    `, [ticketId, JSON.stringify({ from: "VALIDATING", to: "PR_OPEN", reason: `Created simulated Pull Request #${prNumber} at url: ${prUrl}` }), new Date().toISOString()]);

    await db.run(`
      INSERT INTO agent_runs (ticket_id, agent_name, model, prompt_version, status, input_ref, output_ref, cost, duration, error, created_at)
      VALUES (?, 'PR Agent', ?, 'v1.0', 'SUCCESS', 'Validation results', 'PR branch details', 0.0001, ?, null, ?)
    `, [ticketId, apiKey ? "gemini-1.5-flash" : "Mock-RuleEngine", Date.now() - start, new Date().toISOString()]);
  },

  async runReview(ticketId) {
    const start = Date.now();
    const ticket = await db.get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
    const change = await db.get("SELECT * FROM changes WHERE ticket_id = ?", [ticketId]);
    
    const diff = await sandbox.getDiff();

    let reviewReport = {
      approved: true,
      comments: "The code change is clean, solves the specified bug, handles exceptions correctly, and has regression test coverage. Merge is recommended.",
      securityScan: "PASS - No secrets found, no unsafe package additions."
    };

    if (apiKey) {
      const prompt = `Review this PR diff:
      Diff:
      ${diff}
      
      Compare it to the issue description:
      ${ticket.description}
      
      Determine if it is correct. Output as JSON with keys "approved" (boolean), "comments" (review text), "securityScan" (PASS/FAIL description).`;
      const response = await askGemini(prompt, "You are a code review assistant. Output JSON.", true);
      if (response) {
        try {
          reviewReport = JSON.parse(response);
        } catch (e) {
          console.warn("Failed parsing Review JSON.");
        }
      }
    }

    await db.run("UPDATE tickets SET status = 'AI_REVIEW', updated_at = ? WHERE id = ?", [new Date().toISOString(), ticketId]);

    await db.run(`
      INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
      VALUES (?, 'STATE_CHANGE', 'Review Agent', ?, ?)
    `, [ticketId, JSON.stringify({ from: "PR_OPEN", to: "AI_REVIEW", reason: `Automated AI Code Review completed. Decision: ${reviewReport.approved ? 'APPROVE' : 'REQUEST_CHANGES'}. Comments: ${reviewReport.comments}` }), new Date().toISOString()]);

    await db.run("UPDATE tickets SET status = 'HUMAN_REVIEW', updated_at = ? WHERE id = ?", [new Date().toISOString(), ticketId]);
    
    await db.run(`
      INSERT INTO ticket_events (ticket_id, event_type, actor, payload, timestamp)
      VALUES (?, 'STATE_CHANGE', 'Orchestrator', ?, ?)
    `, [ticketId, JSON.stringify({ from: "AI_REVIEW", to: "HUMAN_REVIEW", reason: "AI pipeline complete. Awaiting human gate review and merge authorization." }), new Date().toISOString()]);

    await db.run(`
      INSERT INTO agent_runs (ticket_id, agent_name, model, prompt_version, status, input_ref, output_ref, cost, duration, error, created_at)
      VALUES (?, 'Review Agent', ?, 'v1.0', 'SUCCESS', 'Pull request diff', 'Review report comment', 0.0003, ?, null, ?)
    `, [ticketId, apiKey ? "gemini-1.5-flash" : "Mock-RuleEngine", Date.now() - start, new Date().toISOString()]);
  }
};

module.exports = agents;
