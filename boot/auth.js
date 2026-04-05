/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025-2026 Sebastien Lalaurette
 */

const authMiddleware = require('../interfaces/web/middlewares/auth');

/**
 * Configures authentication for the Express application.
 * @param {Object} app Express app.
 * @param {import('./config').AppConfig} config App configuration.
 * @param {Object} logger Logger.
 * @param {Object} userManager User manager.
 * @param {Object} paths File paths.
 */
function setupAuth(app, config, logger, userManager, paths) {
    authMiddleware.configureAuth(app, config, logger, userManager, paths.SESSIONS_PATH, config.BASE_PATH);
    
    // Apply global authentication middleware
    app.use(authMiddleware.authMiddleware);
}

module.exports = { setupAuth };
