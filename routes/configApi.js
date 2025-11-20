/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
  
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv'); //  Import dotenv library

module.exports = (envPath, envExamplePath, dataPath, logger) => {
    const router = express.Router();

    // GET: Reads and parses the .env file
    router.get('/', (req, res) => {
        try {
            const envFileContent = fs.readFileSync(envPath, { encoding: 'utf8' });
            
            //  Use dotenv.parse instead of manual splitting.
            // This correctly handles multi-line values wrapped in quotes.
            const config = dotenv.parse(envFileContent);
            
            res.json(config);
        } catch (err) {
            logger.error({ err }, "Error parsing .env file");
            res.status(500).json({ error: 'Could not read or parse .env file.' });
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
            
            // Note: We stick to manual line processing here to preserve the structure/comments 
            // of the .env.example file. Since the frontend sends minified (single-line) JSON,
            // writing it back this way is safe.
            exampleContent.split('\n').forEach(line => {
                if (line.startsWith('#') || !line.trim()) {
                    envFileContent += line + '\n';
                } else {
                    const firstEqual = line.indexOf('=');
                    if (firstEqual !== -1) {
                        const key = line.substring(0, firstEqual);
                        if (newConfig.hasOwnProperty(key)) {
                            // Quote the value if it contains spaces or special chars, but avoid double quoting
                            let val = newConfig[key];
                            
                            // If it's the JSON brokers list, wrap in single quotes to be safe
                            if (key === 'MQTT_BROKERS') {
                                envFileContent += `${key}='${val}'\n`;
                            } else {
                                envFileContent += `${key}=${val}\n`;
                            }
                        } else {
                            envFileContent += line + '\n'; // Keep original from example if not in new config
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