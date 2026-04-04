/**
 * @file test_duckdb_chart.js
 * @description Benchmark script for DuckDB time-series downsampling strategies.
 */
const duckdb = require('duckdb');
const path = require('path');
const { performance } = require('perf_hooks');

// [UPDATED] Added '..' to point to the root data folder from the tests folder
const DB_PATH = path.join(__dirname, '..', 'data', 'korelate_events.duckdb');
const TOPIC = 'ALAT/Sassenage/Cavendish/BMS/HVAC/Ambience/Telemetry';
const MAX_POINTS = 500;

const db = new duckdb.Database(DB_PATH);

// Helper to run queries as Promises
function runQuery(query) {
    return new Promise((resolve, reject) => {
        db.all(query, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function runBenchmark() {
    console.log(`\n--- Starting DuckDB Chart Strategy Benchmark ---`);
    console.log(`Topic: ${TOPIC}`);
    console.log(`Target Resolution: Max ${MAX_POINTS} points per series\n`);

    // 1. Find absolute Time Bounds in the DB for this topic
    const boundsQuery = `
        SELECT 
            MIN(epoch_ms(timestamp)) as min_ts, 
            MAX(epoch_ms(timestamp)) as max_ts,
            COUNT(*) as total_rows
        FROM korelate_events 
        WHERE topic = '${TOPIC}'
    `;
    
    const bounds = await runQuery(boundsQuery);
    if (!bounds || bounds.length === 0 || !bounds[0].max_ts) {
        console.error("No data found for this topic. Run the ALAT simulator first.");
        db.close();
        return;
    }

    const globalMaxMs = Number(bounds[0].max_ts);
    const globalMinMs = Number(bounds[0].min_ts);
    const totalAvailableRows = Number(bounds[0].total_rows);

    console.log(`Total rows available for this topic: ${totalAvailableRows}`);
    console.log(`Data spans from ${new Date(globalMinMs).toISOString()} to ${new Date(globalMaxMs).toISOString()}\n`);

    // Define time ranges to test (in hours)
    const ranges = [
        { label: '1h', hours: 1 },
        { label: '6h', hours: 6 },
        { label: '12h', hours: 12 },
        { label: '1d', hours: 24 },
        { label: '3d', hours: 72 },
        { label: '7d', hours: 168 },
        { label: 'MAX', hours: null }
    ];

    for (const range of ranges) {
        console.log(`\n=========================================`);
        console.log(` Testing Range: ${range.label}`);
        console.log(`=========================================`);

        let startMs = globalMinMs;
        if (range.hours !== null) {
            startMs = globalMaxMs - (range.hours * 60 * 60 * 1000);
            if (startMs < globalMinMs) startMs = globalMinMs; // Clamp to available data
        }
        
        const startIso = new Date(startMs).toISOString();
        const endIso = new Date(globalMaxMs).toISOString();

        // ---------------------------------------------------------
        // STRATEGY 1: RAW DATA (Baseline)
        // ---------------------------------------------------------
        const queryRaw = `
            SELECT 
                extract('epoch' FROM timestamp) * 1000 AS ts_ms,
                CAST(payload->>'temperature_c' AS DOUBLE) as temp,
                CAST(payload->>'co2_ppm' AS DOUBLE) as co2,
                CAST(payload->>'occupancy_count' AS DOUBLE) as occ
            FROM korelate_events
            WHERE topic = '${TOPIC}'
              AND timestamp >= CAST('${startIso}' AS TIMESTAMPTZ)
              AND timestamp <= CAST('${endIso}' AS TIMESTAMPTZ)
            ORDER BY timestamp ASC
        `;

        let startTimer = performance.now();
        const resRaw = await runQuery(queryRaw);
        let timeRaw = performance.now() - startTimer;
        
        console.log(`[1] RAW (Baseline)`);
        console.log(`    Time  : ${timeRaw.toFixed(2)} ms`);
        console.log(`    Rows  : ${resRaw.length}`);
        
        // Calculate parameters for downsampling
        const rowCount = resRaw.length;
        if (rowCount === 0) {
            console.log(`    -> No data in this range. Skipping downsampling tests.`);
            continue;
        }

        // Calculate dynamic bucket interval (Target: 500 points)
        const timeSpanMs = globalMaxMs - startMs;
        const bucketMs = Math.max(1000, Math.floor(timeSpanMs / MAX_POINTS)); 

        // Calculate Nth row decimation factor
        const nthRow = Math.max(1, Math.ceil(rowCount / MAX_POINTS));

        // ---------------------------------------------------------
        // STRATEGY 2: TIME BUCKET (Averaging)
        // ---------------------------------------------------------
        const queryBucket = `
            SELECT 
                extract('epoch' FROM time_bucket(INTERVAL '${bucketMs} MILLISECONDS', timestamp)) * 1000 AS ts_ms,
                AVG(CAST(payload->>'temperature_c' AS DOUBLE)) as temp,
                AVG(CAST(payload->>'co2_ppm' AS DOUBLE)) as co2,
                AVG(CAST(payload->>'occupancy_count' AS DOUBLE)) as occ
            FROM korelate_events
            WHERE topic = '${TOPIC}'
              AND timestamp >= CAST('${startIso}' AS TIMESTAMPTZ)
              AND timestamp <= CAST('${endIso}' AS TIMESTAMPTZ)
            GROUP BY 1
            ORDER BY ts_ms ASC
        `;

        startTimer = performance.now();
        const resBucket = await runQuery(queryBucket);
        let timeBucket = performance.now() - startTimer;

        console.log(`[2] TIME BUCKET (AVG per ${bucketMs}ms)`);
        console.log(`    Time  : ${timeBucket.toFixed(2)} ms`);
        console.log(`    Rows  : ${resBucket.length}`);

        // ---------------------------------------------------------
        // STRATEGY 3: NTH ROW DECIMATION
        // ---------------------------------------------------------
        const queryNthRow = `
            WITH CTE AS (
                SELECT 
                    extract('epoch' FROM timestamp) * 1000 AS ts_ms,
                    CAST(payload->>'temperature_c' AS DOUBLE) as temp,
                    CAST(payload->>'co2_ppm' AS DOUBLE) as co2,
                    CAST(payload->>'occupancy_count' AS DOUBLE) as occ,
                    ROW_NUMBER() OVER (ORDER BY timestamp ASC) as rn
                FROM korelate_events
                WHERE topic = '${TOPIC}'
                  AND timestamp >= CAST('${startIso}' AS TIMESTAMPTZ)
                  AND timestamp <= CAST('${endIso}' AS TIMESTAMPTZ)
            )
            SELECT ts_ms, temp, co2, occ
            FROM CTE
            WHERE rn % ${nthRow} = 0 OR rn = 1
            ORDER BY ts_ms ASC
        `;

        startTimer = performance.now();
        const resNthRow = await runQuery(queryNthRow);
        let timeNthRow = performance.now() - startTimer;

        console.log(`[3] DECIMATION (Every ${nthRow}th row)`);
        console.log(`    Time  : ${timeNthRow.toFixed(2)} ms`);
        console.log(`    Rows  : ${resNthRow.length}`);
    }

    console.log(`\n--- Benchmark Complete ---`);
    db.close();
}

runBenchmark().catch(err => {
    console.error("Benchmark failed:", err);
    db.close();
});