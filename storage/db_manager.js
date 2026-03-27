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
const fs = require('fs');

module.exports = (db, dbFile, dbWalFile, broadcast, logger, maxSizeMB, pruneChunkSize, getIsPruning, setIsPruning) => {

    function getDbStatus(callback) {
        let totalSize = 0;
        try { totalSize += fs.statSync(dbFile).size; } catch (e) { /* file might not exist yet */ }
        try { totalSize += fs.statSync(dbWalFile).size; } catch (e) { /* wal file might not exist */ }
        const fileSizeInMB = totalSize / (1024 * 1024);

        db.all("SELECT COUNT(*) as count FROM mqtt_events", (err, rows) => {
            const totalMessages = (!err && rows && rows[0]) ? Number(rows[0].count) : 0;
            callback({
                type: 'db-status-update',
                totalMessages,
                dbSizeMB: fileSizeInMB,
                dbLimitMB: maxSizeMB || 0
            });
        });
    }

    function broadcastDbStatus() {
        getDbStatus((statusData) => {
            broadcast(JSON.stringify(statusData));
        });
    }

    function pruneOldEvents(onComplete) {
        setIsPruning(true);
        broadcast(JSON.stringify({ type: 'pruning-status', status: 'started' }));
        logger.info(`✅    -> Pruning ${pruneChunkSize} oldest events...`);
        const query = `DELETE FROM mqtt_events WHERE rowid IN (SELECT rowid FROM mqtt_events ORDER BY timestamp ASC LIMIT ?);`;

        db.run(query, [pruneChunkSize], (err) => {
            if (err) logger.error({ err }, "❌ Error during pruning:");
            logger.info("✅    -> Pruning complete. Reclaiming disk space...");
            
            db.exec("VACUUM; CHECKPOINT;", (err) => {
                if (err) logger.error({ err }, "❌ Error during VACUUM/CHECKPOINT:");
                else logger.info("✅    -> Space reclaimed.");
                
                setIsPruning(false);
                broadcast(JSON.stringify({ type: 'pruning-status', status: 'finished' }));
                onComplete();
            });
        });
    }

    function performMaintenance() {
        if (getIsPruning()) {
            logger.warn("Maintenance skipped: pruning is already in progress.");
            return;
        }

        db.exec("CHECKPOINT;", (err) => {
            if (err) {
                logger.error({ err }, "❌ Error during maintenance CHECKPOINT:");
            }
            
            getDbStatus((statusData) => {
                broadcast(JSON.stringify(statusData));

                if (maxSizeMB && statusData.dbSizeMB > maxSizeMB) {
                    logger.warn(`Database size (${statusData.dbSizeMB.toFixed(2)} MB) exceeds limit of ${maxSizeMB} MB.`);
                    pruneOldEvents(() => {
                        broadcastDbStatus(); // Update UI with new size after prune
                    });
                }
            });
        });
    }

    return { getDbStatus, broadcastDbStatus, performMaintenance };
};