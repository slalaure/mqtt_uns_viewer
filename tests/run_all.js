#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// Configuration
const REPORT_DIR = path.join(__dirname, '..', 'test-results');
const REPORT_PATH = path.join(REPORT_DIR, 'global_test_report.md');
const UNIT_TIMEOUT_MS = 30000;  // 30 seconds for unit tests
const E2E_TIMEOUT_MS = 180000;  // 3 minutes for Playwright E2E tests

async function checkServices() {
    console.log('🔍 Checking underlying services...');
    try {
        // Check if Docker is responding
        execSync('docker info', { stdio: 'ignore' });
        
        try {
            // Attempt to list the project's docker-compose services
            const composeCmd = fs.existsSync(path.join(__dirname, '..', 'docker-compose.yml')) 
                ? 'docker compose ps --services --filter "status=running"' 
                : 'docker ps --format "{{.Names}}"';
                
            const running = execSync(composeCmd, { encoding: 'utf-8' }).trim();
            if (running) {
                console.log(`✅ Docker services running:\n${running.split('\n').map(s => `   - ${s}`).join('\n')}`);
            } else {
                console.log('⚠️ No Docker services running. Some integration tests requiring external databases or brokers might fail.');
            }
        } catch (e) {
            console.log('⚠️ Unable to list docker-compose services. Proceeding with tests...');
        }
    } catch (e) {
        console.log('⚠️ Docker does not seem to be active on this machine. Proceeding with tests...');
    }
}

function runCommand(command, args, timeoutMs, envOverrides = {}, cwd = process.cwd()) {
    return new Promise((resolve) => {
        const start = Date.now();
        const child = spawn(command, args, {
            shell: true,
            cwd: cwd,
            env: { ...process.env, ...envOverrides }
        });

        let output = '';
        child.stdout.on('data', data => output += data.toString());
        child.stderr.on('data', data => output += data.toString());

        let isTimeout = false;
        const timer = setTimeout(() => {
            isTimeout = true;
            child.kill('SIGKILL'); // Force kill the process if it exceeds the timeout
        }, timeoutMs);

        child.on('close', (code) => {
            clearTimeout(timer);
            const duration = ((Date.now() - start) / 1000).toFixed(2);
            
            let status = 'FAIL';
            if (isTimeout) status = 'TIMEOUT';
            else if (code === 0) status = 'PASS';

            resolve({ status, output, duration });
        });
    });
}

async function main() {
    console.log("================================================");
    console.log("  🚀 KORELATE - GLOBAL TEST RUNNER & REPORTER");
    console.log("================================================\n");

    await checkServices();

    const results = [];
    const testsDir = __dirname;
    const e2eDir = path.join(testsDir, 'e2e');

    // Dynamic discovery of test files
    const unitTests = fs.readdirSync(testsDir)
        .filter(f => f.endsWith('.test.js') || f.endsWith('.test.mjs'))
        .map(f => ({ name: f, path: `tests/${f}`, type: 'Unit (Jest)' }));

    const e2eTests = fs.existsSync(e2eDir) ? fs.readdirSync(e2eDir)
        .filter(f => f.endsWith('.spec.js'))
        .map(f => ({ name: f, path: `tests/e2e/${f}`, type: 'E2E (Playwright)' })) : [];

    const allTests = [...unitTests]; // We will handle E2E separately or at the end

    console.log(`\n▶️ Starting unit test suite (${unitTests.length} files found)...\n`);

    const rootDir = path.join(__dirname, '..');

    for (let i = 0; i < unitTests.length; i++) {
        const test = unitTests[i];
        process.stdout.write(`[${i + 1}/${unitTests.length}] ⏳ Executing ${test.name} ... `);
        
        const cmd = 'npx';
        const args = ['jest', test.path, '--passWithNoTests', '--detectOpenHandles', '--forceExit'];
        const timeout = UNIT_TIMEOUT_MS;
        const env = { NODE_OPTIONS: '--experimental-vm-modules' };

        const result = await runCommand(cmd, args, timeout, env, rootDir);
        result.test = test;
        results.push(result);

        if (result.status === 'PASS') console.log(`✅ PASS (${result.duration}s)`);
        else if (result.status === 'TIMEOUT') console.log(`⏱️ TIMEOUT - Skipped (${result.duration}s)`);
        else console.log(`❌ FAIL (${result.duration}s)`);
    }

    if (e2eTests.length > 0) {
        console.log(`\n▶️ Starting E2E test suite (${e2eTests.length} files found in one batch)...\n`);
        process.stdout.write(`⏳ Executing all Playwright tests ... `);
        
        const cmd = 'npx';
        const args = ['playwright', 'test', '--config=playwright.config.js'];
        const timeout = E2E_TIMEOUT_MS * 2; // Give more time for the whole batch
        const env = { CI: 'true' };

        const result = await runCommand(cmd, args, timeout, env, rootDir);
        
        // We need to parse which ones failed from the output if possible, 
        // but for now let's just mark them all based on the global result or generic entry
        if (result.status === 'PASS') {
            console.log(`✅ PASS (${result.duration}s)`);
            for (const test of e2eTests) {
                results.push({ test, status: 'PASS', duration: (result.duration / e2eTests.length).toFixed(2), output: result.output });
            }
        } else {
            console.log(`❌ FAIL (${result.duration}s)`);
            // Try to be smart: if it failed, we might want to check which ones.
            // But for the report, we'll mark them as failed and the user can see the log.
            for (const test of e2eTests) {
                results.push({ test, status: 'FAIL', duration: (result.duration / e2eTests.length).toFixed(2), output: result.output });
            }
        }
    }

    // --- Markdown Report Generation ---
    console.log(`\n📝 Generating report at test-results/global_test_report.md...`);
    
    if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    const timeouts = results.filter(r => r.status === 'TIMEOUT').length;

    let reportContent = `# Global Test Report - Korelate\n\n`;
    reportContent += `**Execution Date:** ${new Date().toLocaleString('en-US')}\n\n`;
    
    reportContent += `## 📊 Summary\n`;
    reportContent += `- **Total:** ${results.length}\n`;
    reportContent += `- **Passed:** ${passed} ✅\n`;
    reportContent += `- **Failed:** ${failed} ❌\n`;
    reportContent += `- **Timeouts:** ${timeouts} ⏱️\n\n`;

    reportContent += `## 📋 Details by File\n\n`;
    reportContent += `| Status | Type | Test File | Duration (s) |\n`;
    reportContent += `|:---:|---|---|---:|\n`;
    
    for (const r of results) {
        const icon = r.status === 'PASS' ? '✅' : (r.status === 'TIMEOUT' ? '⏱️' : '❌');
        reportContent += `| ${icon} ${r.status} | ${r.test.type} | \`${r.test.name}\` | ${r.duration} |\n`;
    }

    const failures = results.filter(r => r.status !== 'PASS');
    if (failures.length > 0) {
        reportContent += `\n## ⚠️ Error Logs\n\n`;
        for (const r of failures) {
            reportContent += `### ❌ ${r.test.name} (${r.status})\n`;
            reportContent += `<details><summary>Click to view console output</summary>\n\n\`\`\`text\n${r.output.substring(0, 5000)}${r.output.length > 5000 ? '\n... [Truncated]' : ''}\n\`\`\`\n\n</details>\n\n`;
        }
    } else {
        reportContent += `\n## 🎉 All tests passed successfully!\n`;
    }

    fs.writeFileSync(REPORT_PATH, reportContent);
    console.log('✅ Done! Report available at: ' + REPORT_PATH);
}

main().catch(err => {
    console.error("❌ Critical script error:", err);
    process.exit(1);
});
