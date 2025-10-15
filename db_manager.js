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