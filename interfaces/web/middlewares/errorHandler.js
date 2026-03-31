/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * 
 * Global Error Handling Middleware
 */

module.exports = (logger) => {
    return (err, req, res, next) => {
        // Default to 500 if no status code is provided
        const statusCode = err.status || err.statusCode || 500;
        
        // Extract correlation ID from headers or request object (if set by a previous middleware)
        const traceId = req.headers['x-correlation-id'] || req.correlationId || 'N/A';

        // Log the error using Pino with request context
        logger.error({
            err: {
                message: err.message,
                stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
                code: err.code
            },
            request: {
                method: req.method,
                url: req.url,
                ip: req.ip
            },
            traceId
        }, `[API Error] ${err.message}`);

        // Return a strict JSON structure to the client
        res.status(statusCode).json({
            error: {
                message: err.message || "Internal Server Error",
                code: err.code || "INTERNAL_ERROR",
                traceId: traceId
            }
        });
    };
};
