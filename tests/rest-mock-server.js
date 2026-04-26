/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 *
 * REST API Mock Server
 * Provides a local test dataset for Korelate's REST/HTTP Connector.
 */

const express = require("express");
const app = express();
const port = 3001;

app.use(express.json());

app.get("/api/data", (req, res) => {
    res.json({
        factory: {
            line1: {
                temperature: 20 + Math.random() * 5,
                pressure: 1.2 + Math.random() * 0.2,
                status: "running"
            }
        },
        timestamp: new Date().toISOString()
    });
});

app.get("/pets", (req, res) => {
    res.json([
        { id: 1, name: "Dog", status: "available" },
        { id: 2, name: "Cat", status: "pending" }
    ]);
});

app.post("/api/publish", (req, res) => {
    console.log("REST: Received Publish", req.body);
    res.status(201).json({ success: true });
});

app.listen(port, () => {
    console.log(`✅ REST Mock Server listening at http://localhost:${port}`);
});
