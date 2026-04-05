/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * 
 * Chart Logic Utility
 * Pure JS functions for data processing, downsampling, and dataset construction.
 * Decoupled from DOM and Chart.js instances for unit testing.
 */

export const PALETTE_HUES = [210, 120, 30, 270, 180, 60, 300, 0];

/**
 * Largest Triangle Three Buckets (LTTB) Downsampling algorithm.
 * reduces the number of points while preserving the visual shape of the data.
 */
export function downsampleLTTB(data, threshold) {
    const dataLength = data.length;
    if (threshold >= dataLength || threshold === 0) return data;

    const sampled = [];
    let sampledIndex = 0;

    // Bucket size. Leave room for start and end data points
    const bucketSize = (dataLength - 2) / (threshold - 2);

    let a = 0; // Initially a is the first point in the triangle
    let maxAreaPoint, maxArea, area, nextA;

    sampled[sampledIndex++] = data[a]; // Always add the first point

    for (let i = 0; i < threshold - 2; i++) {
        // Calculate point average for next bucket (containing c)
        let avgX = 0, avgY = 0, avgRangeStart = Math.floor((i + 1) * bucketSize) + 1,
            avgRangeEnd = Math.floor((i + 2) * bucketSize) + 1;
        avgRangeEnd = avgRangeEnd < dataLength ? avgRangeEnd : dataLength;

        const avgRangeLength = avgRangeEnd - avgRangeStart;

        for (; avgRangeStart < avgRangeEnd; avgRangeStart++) {
            avgX += data[avgRangeStart].x;
            avgY += data[avgRangeStart].y;
        }
        avgX /= avgRangeLength;
        avgY /= avgRangeLength;

        // Get the range for this bucket
        let rangeOffs = Math.floor((i + 0) * bucketSize) + 1,
            rangeTo = Math.floor((i + 1) * bucketSize) + 1;

        // Point a
        const pointAX = data[a].x, pointAY = data[a].y;

        maxArea = area = -1;

        for (; rangeOffs < rangeTo; rangeOffs++) {
            // Calculate triangle area over three buckets
            area = Math.abs((pointAX - avgX) * (data[rangeOffs].y - pointAY) -
                            (pointAX - data[rangeOffs].x) * (avgY - pointAY)
                           ) * 0.5;
            if (area > maxArea) {
                maxArea = area;
                maxAreaPoint = data[rangeOffs];
                nextA = rangeOffs; // Next a is this b
            }
        }

        sampled[sampledIndex++] = maxAreaPoint; // Pick this point from the bucket
        a = nextA; // This a is the next a (the selected point)
    }

    sampled[sampledIndex++] = data[dataLength - 1]; // Always add last

    return sampled;
}

/**
 * Checks if a dataset is composed strictly of 0 and 1 values.
 */
export function isBooleanLike(dataPoints) {
    if (!dataPoints || dataPoints.length === 0) return false;
    for (const p of dataPoints) {
        if (p.y !== 0 && p.y !== 1) return false;
    }
    return true;
}

/**
 * Guesses a grouping key for a topic and path to stack similar variables on same axis.
 */
export function guessGroupKey(topic, path) {
    const fullString = (topic + "/" + path).toLowerCase();
    const keywords = [
        "temperature", "humidity", "pressure", "bar", "psi", "pascal",
        "power", "current", "voltage", "energy",
        "speed", "vibration", "level", "percent", "battery", "soc",
        "heater", "status", "fire", "load",
        "flow", "rate", "debit", "throughput",
        "concentration", "ppm", "ppb", "mg", "µg", "aqi", "co2", "pm25"
    ];
    for (const kw of keywords) {
        if (fullString.includes(kw)) return kw;
    }
    const topicParts = topic.split("/");
    const lastPart = topicParts[topicParts.length - 1];
    if (path === "(value)" || path.toLowerCase() === "value") {
        return lastPart.toLowerCase();
    }
    return (lastPart + "_" + path).replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
}

/**
 * Determines a hue value based on semantic naming or palette rotation.
 */
export function getAxisHue(axisKey, axisIndex, enableSemantic = true) {
    const key = axisKey.toLowerCase();

    if (enableSemantic) {
        if (key.includes("heater") || key.includes("fire")) return 0; // Red
        if (key.includes("temperature")) return 15; // Red-Orange
        if (key.includes("humidity") || key.includes("water")) return 210; // Blue
        if (key.includes("pressure") || key.includes("bar") || key.includes("psi")) return 180; // Teal/Cyan
        if (key.includes("flow") || key.includes("rate") || key.includes("debit")) return 240; // Indigo
        if (key.includes("power") || key.includes("energy") || key.includes("voltage")) return 45; // Yellow/Gold
        if (key.includes("concentration") || key.includes("ppm") || key.includes("aqi") || key.includes("co2")) return 300; // Magenta
        if (key.includes("percent") || key.includes("level") || key.includes("battery")) return 120; // Green
        if (key.includes("status")) return 270; // Purple
    }

    return PALETTE_HUES[axisIndex % PALETTE_HUES.length];
}

/**
 * Helper to convert HSL to HEX so color pickers can consume it.
 */
export function hslToHex(h, s, l) {
    l /= 100;
    const a = s * Math.min(l, 1 - l) / 100;
    const f = n => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Transforms raw points from different topics into Chart.js ready datasets.
 */
export function buildChartDatasets(rawPointsMap, chartedVariables, options = {}) {
    const { useSmartAxis = true, connectNulls = false, distinctAxes = [] } = options;
    const datasets = [];
    const axisMap = new Map();
    const axisCounters = new Map(); // Track how many variables on each axis for color variation
    const dynamicScales = {};

    for (const [varId, varInfo] of chartedVariables.entries()) {
        const { topic, path } = varInfo;
        const rawPoints = rawPointsMap.get(varId) || [];
        const topicParts = topic.split("/");
        const cleanPath = path.replace(/\[|\]/g, "");
        const label = `${topicParts.slice(-2).join("/")} | ${cleanPath}`;

        // Sort by time
        rawPoints.sort((a, b) => a.x - b.x);

        // Determine Axis
        const axisKey = useSmartAxis ? guessGroupKey(topic, cleanPath) : varId;
        if (!axisMap.has(axisKey)) {
            axisMap.set(axisKey, `y${axisMap.size}`);
            axisCounters.set(axisKey, 0);
        }
        const yAxisId = axisMap.get(axisKey);
        const varIndexOnAxis = axisCounters.get(axisKey);
        axisCounters.set(axisKey, varIndexOnAxis + 1);

        // Determine Color
        const axisIndex = distinctAxes.indexOf(axisKey);
        const hue = getAxisHue(axisKey, axisIndex >= 0 ? axisIndex : axisMap.size - 1, useSmartAxis);
        
        // Add variations (lightness/saturation) if multiple variables on same axis
        const saturation = 85 - (varIndexOnAxis * 10);
        const lightness = 60 + (varIndexOnAxis * 5);
        const autoHex = hslToHex(hue, Math.max(30, saturation), Math.min(85, lightness));
        const color = varInfo.color || autoHex;

        datasets.push({
            varId: varId,
            label: label,
            data: rawPoints,
            borderColor: color,
            backgroundColor: color,
            fill: false,
            spanGaps: connectNulls,
            tension: 0.1,
            yAxisID: yAxisId,
            pointRadius: rawPoints.length > 200 ? 0 : 3,
        });

        // Config Scale (Metadata for UI to apply)
        if (!dynamicScales[yAxisId]) {
            dynamicScales[yAxisId] = {
                id: yAxisId,
                axisKey,
                label,
                hue,
                isBoolean: isBooleanLike(rawPoints)
            };
        }
    }

    return { datasets, scalesMeta: dynamicScales };
}
