const duckdb = require('duckdb');
const llmEngine = require('../core/engine/llmEngine');

describe('AI Learning Studio Integration', () => {
    let db;

    beforeAll((done) => {
        // Use an in-memory database to avoid file lock issues during testing
        db = new duckdb.Database(':memory:', done);
    });

    afterAll((done) => {
        db.close(done);
    });

    test('DuckDB Profiling SQL calculates correct statistics and LLM generates prompt', (done) => {
        const TEST_TOPIC = "test/learning/studio";
        const TEST_SOURCE = "test_source";
        
        // 1. Prepare Predictable Test Data
        const now = new Date();
        const dataPoints = [];
        
        // Generate 100 points, 10 seconds apart. Base value is 50.
        for (let i = 0; i < 100; i++) {
            const ts = new Date(now.getTime() - (100 - i) * 10000); 
            dataPoints.push({
                timestamp: ts.toISOString(),
                topic: TEST_TOPIC,
                source_id: TEST_SOURCE,
                payload: JSON.stringify({ temperature: 50 }), 
                connector_type: 'mqtt'
            });
        }
        
        // Add specific variations to test Min, Max, and Chatter (crossings)
        dataPoints[50].payload = JSON.stringify({ temperature: 60 }); // Max
        dataPoints[51].payload = JSON.stringify({ temperature: 40 }); // Min
        // These two variations create mean crossings.

        db.serialize(() => {
            db.run("CREATE TABLE IF NOT EXISTS korelate_events (timestamp TIMESTAMPTZ, topic VARCHAR, payload JSON, source_id VARCHAR, correlation_id VARCHAR, connector_type VARCHAR)");
            
            const stmt = db.prepare("INSERT INTO korelate_events (timestamp, topic, payload, source_id, connector_type) VALUES (CAST(? AS TIMESTAMPTZ), ?, ?, ?, ?)");
            for (const p of dataPoints) {
                stmt.run(p.timestamp, p.topic, p.payload, p.source_id, p.connector_type);
            }
            stmt.finalize();

            // 2. Execute the AI Learning Studio Profiling Query
            const startDate = new Date(now.getTime() - 1000 * 10000).toISOString();
            const endDate = now.toISOString();
            const valExpr = `TRY_CAST(json_extract_string(payload, '$.temperature') AS DOUBLE)`;

            const profileQuery = `
                WITH raw_data AS (
                    SELECT timestamp, ${valExpr} as val
                    FROM korelate_events
                    WHERE topic = '${TEST_TOPIC}' 
                      AND source_id = '${TEST_SOURCE}'
                      AND timestamp >= CAST('${startDate}' AS TIMESTAMPTZ)
                      AND timestamp <= CAST('${endDate}' AS TIMESTAMPTZ)
                ),
                stats AS (
                    SELECT 
                        MIN(val) as min_val, MAX(val) as max_val, AVG(val) as mean_val, STDDEV(val) as stddev_val,
                        CAST(COUNT(*) FILTER (WHERE val IS NULL) AS INTEGER) as null_count,
                        CAST(COUNT(*) AS INTEGER) as total_count
                    FROM raw_data
                ),
                frequency AS (
                    SELECT AVG(diff) as avg_freq
                    FROM (SELECT extract('epoch' from timestamp - lag(timestamp) OVER (ORDER BY timestamp)) as diff FROM raw_data)
                ),
                chatter AS (
                    SELECT CAST(COUNT(*) AS INTEGER) as crossings
                    FROM (
                        SELECT val, lag(val) OVER (ORDER BY timestamp) as prev_val, (SELECT mean_val FROM stats) as m
                        FROM raw_data WHERE val IS NOT NULL
                    )
                    WHERE (val > m AND prev_val <= m) OR (val < m AND prev_val >= m)
                )
                SELECT * FROM stats, frequency, chatter
            `;

            db.all(profileQuery, (err, rows) => {
                expect(err).toBeNull();
                expect(rows).toBeDefined();
                expect(rows.length).toBe(1);
                
                const stats = rows[0];
                
                // Assertions for Statistical correctness
                expect(stats.total_count).toBe(100);
                expect(stats.min_val).toBe(40);
                expect(stats.max_val).toBe(60);
                expect(Math.round(stats.avg_freq)).toBe(10); // 10 seconds frequency
                expect(stats.crossings).toBeGreaterThan(0); // Should have detected the chatter
                
                // 3. Test LLM Prompt Generation with these statistics
                const dummyProfileData = [{
                    sourceId: TEST_SOURCE,
                    topic: TEST_TOPIC,
                    variables: [{ id: "var1", path: "$.temperature", stats }]
                }];

                const currentModel = JSON.stringify({ objects: [] });
                const prompt = llmEngine.generateDataProfilePrompt(dummyProfileData, currentModel);
                
                // Assertions for LLM Engine
                expect(prompt).toContain("Senior IIoT Data Scientist");
                expect(prompt).toContain(TEST_TOPIC);
                expect(prompt).toContain("create_object");
                
                done();
            });
        });
    });
});
