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

        db.all("SELECT COUNT(*) as count FROM korelate_events", (err, rows) => {
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

    function pruneOldEvents(statusData, onComplete) {
        setIsPruning(true);
        broadcast(JSON.stringify({ type: 'pruning-status', status: 'started' }));

        // Adaptive multiplier: If we are significantly over the limit, prune more aggressively
        let multiplier = 1;
        if (maxSizeMB && statusData.dbSizeMB > maxSizeMB) {
            const overLimitRatio = statusData.dbSizeMB / maxSizeMB;
            if (overLimitRatio > 2.0) multiplier = 20;      // 2x over limit -> delete 10,000 rows
            else if (overLimitRatio > 1.5) multiplier = 10; // 1.5x over limit -> delete 5,000 rows
            else if (overLimitRatio > 1.2) multiplier = 5;  // 1.2x over limit -> delete 2,500 rows
            else if (overLimitRatio > 1.1) multiplier = 2;  // 1.1x over limit -> delete 1,000 rows
        }

        const rowsToDelete = pruneChunkSize * multiplier;
        logger.info(`✅    -> Database size (${statusData.dbSizeMB.toFixed(2)} MB) exceeds limit of ${maxSizeMB} MB.`);
        logger.info(`✅    -> Pruning ${rowsToDelete} oldest events (Chunk: ${pruneChunkSize} x ${multiplier})...`);
        
        const query = `DELETE FROM korelate_events WHERE rowid IN (SELECT rowid FROM korelate_events ORDER BY timestamp ASC LIMIT ?);`;

        db.run(query, [rowsToDelete], (err) => {
            if (err) logger.error({ err }, "❌ Error during pruning:");
            logger.info("✅    -> Pruning complete. Reclaiming disk space...");
            
            // Reclaim space and merge WAL
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

        // Perform a regular checkpoint to keep WAL file size under control
        // and ensure on-disk size matches actual data volume.
        db.exec("CHECKPOINT;", (err) => {
            if (err) {
                logger.error({ err }, "❌ Error during maintenance CHECKPOINT:");
            }
            
            getDbStatus((statusData) => {
                broadcast(JSON.stringify(statusData));

                if (maxSizeMB && statusData.dbSizeMB > maxSizeMB) {
                    pruneOldEvents(statusData, () => {
                        broadcastDbStatus(); // Update UI with new size after prune
                    });
                }
            });
        });
    }

    return { getDbStatus, broadcastDbStatus, performMaintenance };
};