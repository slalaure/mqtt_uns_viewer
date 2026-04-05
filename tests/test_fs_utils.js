/**
 * Test for core/fsUtils.js readLastLines
 */
const fs = require('fs');
const path = require('path');
const { readLastLines } = require('../core/fsUtils');

async function runTest() {
    const testFile = path.join(__dirname, 'test_log.txt');
    
    // Create a dummy log file with 1000 lines
    let content = '';
    for (let i = 1; i <= 1000; i++) {
        content += `Line ${i}\n`;
    }
    fs.writeFileSync(testFile, content);

    console.log('--- Testing readLastLines ---');

    try {
        console.log('1. Reading last 5 lines:');
        const last5 = await readLastLines(testFile, 5);
        console.log(`[${last5}]`);
        const expected5 = 'Line 996\nLine 997\nLine 998\nLine 999\nLine 1000';
        if (last5.trim() === expected5) {
            console.log('✅ Success');
        } else {
            console.error('❌ Failed: unexpected content');
        }

        console.log('\n2. Reading last 1 line:');
        const last1 = await readLastLines(testFile, 1);
        console.log(`[${last1}]`);
        if (last1.trim() === 'Line 1000') {
            console.log('✅ Success');
        } else {
            console.error('❌ Failed');
        }

        console.log('\n3. Reading more lines than available (2000):');
        const last2000 = await readLastLines(testFile, 2000);
        const lineCount = last2000.trim().split('\n').length;
        console.log(`Line count: ${lineCount}`);
        if (lineCount === 1000) {
            console.log('✅ Success');
        } else {
            console.error('❌ Failed');
        }

        console.log('\n4. Reading from empty file:');
        fs.writeFileSync(testFile, '');
        const empty = await readLastLines(testFile, 10);
        if (empty === '') {
            console.log('✅ Success');
        } else {
            console.error('❌ Failed');
        }

    } catch (err) {
        console.error('❌ Error during test:', err);
    } finally {
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    }
}

runTest();
