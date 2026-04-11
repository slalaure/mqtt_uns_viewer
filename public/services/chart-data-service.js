/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025-2026 Sebastien Lalaurette
 *
 * Service for fetching and processing chart data.
 */

/**
 * Fetches aggregated data from the backend.
 * @param {Map} chartedVariables Map of variables to fetch.
 * @param {number} startTs Start timestamp.
 * @param {number} endTs End timestamp.
 * @param {string} aggregation Aggregation method (AUTO, MIN, MAX, MEAN, MEDIAN).
 * @param {number} maxPoints Maximum points per series.
 */
export async function fetchAggregatedData(chartedVariables, startTs, endTs, aggregation, maxPoints) {
    // Group variables by topic/broker
    const topicsMap = new Map();
    chartedVariables.forEach((varInfo, varId) => {
        const key = `${varInfo.sourceId}|${varInfo.topic}`;
        if (!topicsMap.has(key)) {
            topicsMap.set(key, {
                sourceId: varInfo.sourceId,
                topic: varInfo.topic,
                variables: [],
            });
        }

        // Convert JS path to valid JSONPath
        let jsonPath = varInfo.path;
        if (jsonPath !== "(value)") {
            jsonPath = jsonPath.startsWith("[") ? "$" + jsonPath : "$." + jsonPath;
        }
        topicsMap.get(key).variables.push({
            id: varId,
            path: jsonPath,
            originalPath: varInfo.path,
        });
    });

    const topicsArray = Array.from(topicsMap.values());

    const response = await fetch("api/context/aggregate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            topics: topicsArray,
            startDate: new Date(startTs).toISOString(),
            endDate: new Date(endTs).toISOString(),
            aggregation: aggregation,
            maxPoints: maxPoints,
        }),
    });

    if (!response.ok) throw new Error("Aggregation API failed");
    const results = await response.json();

    // Transform results back to rawPointsMap format for drawing
    const rawPointsMap = new Map();
    chartedVariables.forEach((v, id) => rawPointsMap.set(id, []));

    results.forEach((topicResult) => {
        if (topicResult.error) {
            console.error("Aggregation error for topic:", topicResult.topic, topicResult.error);
            return;
        }
        if (topicResult.data) {
            topicResult.data.forEach((row) => {
                const ts = row.ts_ms;
                Object.keys(row).forEach((col) => {
                    if (col !== "ts_ms" && row[col] !== null) {
                        const points = rawPointsMap.get(col);
                        if (points) points.push({ x: ts, y: row[col] });
                    }
                });
            });
        }
    });

    return rawPointsMap;
}
