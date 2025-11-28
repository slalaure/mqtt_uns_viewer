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
const dotenv = require('dotenv');
const multer = require('multer');

module.exports = (envPath, envExamplePath, dataPath, logger) => {
    const router = express.Router();
    const certsPath = path.join(dataPath, 'certs');

    // Ensure certs directory exists
    if (!fs.existsSync(certsPath)) {
        try {
            fs.mkdirSync(certsPath, { recursive: true });
        } catch (e) {
            logger.error({ err: e }, "Failed to create certs directory");
        }
    }

    // Configure Multer for file uploads
    const storage = multer.diskStorage({
        destination: function (req, file, cb) {
            cb(null, certsPath);
        },
        filename: function (req, file, cb) {
            // Sanitize filename to just the basename to prevent directory traversal
            cb(null, path.basename(file.originalname));
        }
    });
    
    // Filter to allow common certificate extensions
    const fileFilter = (req, file, cb) => {
        if (file.originalname.match(/\.(pem|crt|key|ca|cer|pfx|p12)$/)) {
            cb(null, true);
        } else {
            cb(new Error('Only certificate files are allowed!'), false);
        }
    };

    const upload = multer({ storage: storage, fileFilter: fileFilter });

    // GET /api/env/certs: List available certificates
    router.get('/certs', (req, res) => {
        try {
            if (!fs.existsSync(certsPath)) {
                return res.json([]);
            }
            const files = fs.readdirSync(certsPath);
            res.json(files);
        } catch (err) {
            logger.error({ err }, "Error listing certificates");
            res.status(500).json({ error: 'Could not list certificate files.' });
        }
    });

    // POST /api/env/certs: Upload a certificate
    router.post('/certs', upload.single('certificate'), (req, res) => {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded or invalid file type.' });
        }
        logger.info(`✅ Certificate uploaded: ${req.file.filename}`);
        res.json({ message: 'Certificate uploaded successfully', filename: req.file.filename });
    });

    // GET: Reads and parses the .env file
    router.get('/', (req, res) => {
        try {
            const envFileContent = fs.readFileSync(envPath, { encoding: 'utf8' });
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
            const exampleContent = fs.readFileSync(envExamplePath, { encoding: 'utf8' });
            
            exampleContent.split('\n').forEach(line => {
                if (line.startsWith('#') || !line.trim()) {
                    envFileContent += line + '\n';
                } else {
                    const firstEqual = line.indexOf('=');
                    if (firstEqual !== -1) {
                        const key = line.substring(0, firstEqual);
                        if (newConfig.hasOwnProperty(key)) {
                            let val = newConfig[key];
                            if (key === 'MQTT_BROKERS') {
                                envFileContent += `${key}='${val}'\n`;
                            } else {
                                envFileContent += `${key}=${val}\n`;
                            }
                        } else {
                            envFileContent += line + '\n';
                        }
                    }
                }
            });
            
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
        process.exit(0);
    });

    return router;
};