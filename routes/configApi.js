/**
 * @license MIT
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = (envPath, envExamplePath, dataPath, logger) => {
    const router = express.Router();

    // GET: Reads and parses the .env file
    router.get('/', (req, res) => {
        try {
            const envFileContent = fs.readFileSync(envPath, { encoding: 'utf8' });
            const config = {};
            envFileContent.split('\n').forEach(line => {
                if (line && !line.startsWith('#')) {
                    const firstEqual = line.indexOf('=');
                    if (firstEqual !== -1) {
                        const key = line.substring(0, firstEqual);
                        const value = line.substring(firstEqual + 1);
                        config[key] = value;
                    }
                }
            });
            res.json(config);
        } catch (err) {
            res.status(500).json({ error: 'Could not read .env file.' });
        }
    });

    // POST: Saves the new configuration
    router.post('/', (req, res) => {
        const newConfig = req.body;
        const tempPath = path.join(dataPath, '.env.tmp');
        let envFileContent = "";

        try {
            // Rebuild the file from the example to preserve comments and order
            const exampleContent = fs.readFileSync(envExamplePath, { encoding: 'utf8' });
            exampleContent.split('\n').forEach(line => {
                if (line.startsWith('#') || !line.trim()) {
                    envFileContent += line + '\n';
                } else {
                    const firstEqual = line.indexOf('=');
                    if (firstEqual !== -1) {
                        const key = line.substring(0, firstEqual);
                        if (newConfig.hasOwnProperty(key)) {
                            envFileContent += `${key}=${newConfig[key]}\n`;
                        } else {
                            envFileContent += line + '\n'; // Keep original if not in new config
                        }
                    }
                }
            });
            
            // Atomically write by renaming
            fs.writeFileSync(tempPath, envFileContent);
            fs.renameSync(tempPath, envPath);

            res.json({ message: 'Configuration saved successfully.' });
        } catch (err) {
            logger.error({ err }, "Error writing to .env file:");
            res.status(500).json({ error: 'Could not write to .env file. Check server logs for details.' });
        }
    });

    // POST: Restarts the server
    router.post('/restart', (req, res) => {
        res.json({ message: 'Server is restarting...' });
        logger.info("Restart requested via API. Shutting down...");
        // Exits the process. Docker (with restart:always) will restart it.
        process.exit(0);
    });

    return router;
};