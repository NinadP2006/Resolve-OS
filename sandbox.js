const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const sandboxDir = path.resolve(__dirname, '../../sandbox');

const runCmd = (cmd) => {
  return new Promise((resolve) => {
    exec(cmd, { cwd: sandboxDir }, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code || 1) : 0,
        stdout: stdout || '',
        stderr: stderr || ''
      });
    });
  });
};

const sandbox = {
  async init() {
    await this.cleanup();
  },

  // Safe cleanup: reset tracked files and switch to main branch without running global cleans
  async cleanup() {
    await runCmd('git checkout main');
    await runCmd('git reset --hard HEAD');
  },

  async createBranch(ticketId) {
    const branchName = `ticket-${ticketId}-fix`;
    await this.cleanup();
    await runCmd(`git branch -D ${branchName}`);
    const result = await runCmd(`git checkout -b ${branchName}`);
    return { branchName, ...result };
  },

  async writeFile(filename, content) {
    const filePath = path.join(sandboxDir, filename);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, content, 'utf8');
  },

  async readFile(filename) {
    const filePath = path.join(sandboxDir, filename);
    return await fs.promises.readFile(filePath, 'utf8');
  },

  // Runs a specific test file if provided, otherwise runs the entire suite
  async runTests(testFile = '') {
    const cmd = testFile ? `node --test ${testFile}` : 'npm test';
    const result = await runCmd(cmd);
    return {
      success: result.code === 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  },

  async runLint() {
    const result = await runCmd('npm run lint');
    return {
      success: result.code === 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  },

  async getDiff() {
    const result = await runCmd('git diff main');
    return result.stdout;
  },

  async commitChanges(message) {
    await runCmd('git add .');
    const result = await runCmd(`git commit -m "${message.replace(/"/g, '\\"')}"`);
    const log = await runCmd('git log -1 --format=%H');
    return {
      success: result.code === 0,
      sha: log.stdout.trim()
    };
  },

  async mergeBranch(branchName) {
    await runCmd('git checkout main');
    const mergeResult = await runCmd(`git merge ${branchName} --no-edit`);
    return {
      success: mergeResult.code === 0,
      stdout: mergeResult.stdout,
      stderr: mergeResult.stderr
    };
  }
};

module.exports = sandbox;
