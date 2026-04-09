/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * SQL Poller Provider Plugin
 * Implements the BaseProvider interface for polling relational databases.
 * Supports PostgreSQL, MySQL, and MS SQL Server.
 */

const BaseProvider = require('../baseProvider');
const { v4: uuidv4 } = require('uuid');

class SqlPollerProvider extends BaseProvider {
    /**
     * @param {import('../baseProvider').ProviderConfig} config 
     * @param {import('../baseProvider').ProviderContext} context 
     */
    constructor(config, context) {
        super(config, context);
        this.options = config.options || {};
        this.driver = this.options.driver || 'postgres'; // postgres, mysql, mssql
        this.connection = this.options.connection;
        this.query = this.options.query;
        this.interval = this.options.interval || 60000; // default 1 minute
        this.cursorColumn = this.options.cursorColumn;
        this.topic = this.options.topic || `sql/${this.id}`;
        this.topicColumn = this.options.topicColumn; // Optional: use a column as sub-topic
        
        this.lastCursorValue = this.options.initialCursor || null;
        this.pool = null;
        this.timer = null;
        this.isPolling = false;
    }

    async connect() {
        this.logger.info(`Connecting to ${this.driver} database for ${this.id}`);
        try {
            if (this.driver === 'postgres') {
                const { Pool } = require('pg');
                this.pool = new Pool(this.connection);
            } else if (this.driver === 'mysql') {
                const mysql = require('mysql2/promise');
                this.pool = await mysql.createPool(this.connection);
            } else if (this.driver === 'mssql') {
                const mssql = require('mssql');
                this.pool = await mssql.connect(this.connection);
            } else {
                throw new Error(`Unsupported SQL driver: ${this.driver}`);
            }

            this.connected = true;
            this.updateStatus('connected');
            this.startPolling();
            return true;
        } catch (err) {
            this.logger.error({ err }, `Failed to connect to ${this.driver} database`);
            this.updateStatus('error', err.message);
            return false;
        }
    }

    startPolling() {
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => this.poll(), this.interval);
        // Immediate first poll
        setImmediate(() => this.poll());
    }

    async poll() {
        if (this.isPolling || !this.connected) return;
        this.isPolling = true;

        try {
            let results = [];
            let parameterizedQuery = this.query;
            let params = [];

            // Cursor logic: append WHERE clause if cursor is set
            if (this.cursorColumn && this.lastCursorValue) {
                const operator = this.query.toLowerCase().includes('where') ? 'AND' : 'WHERE';
                if (this.driver === 'postgres' || this.driver === 'mssql') {
                    parameterizedQuery += ` ${operator} ${this.cursorColumn} > $1`;
                    params.push(this.lastCursorValue);
                } else if (this.driver === 'mysql') {
                    parameterizedQuery += ` ${operator} ${this.cursorColumn} > ?`;
                    params.push(this.lastCursorValue);
                }
            }

            // Execute query based on driver
            if (this.driver === 'postgres') {
                const res = await this.pool.query(parameterizedQuery, params);
                results = res.rows;
            } else if (this.driver === 'mysql') {
                const [rows] = await this.pool.execute(parameterizedQuery, params);
                results = rows;
            } else if (this.driver === 'mssql') {
                const request = this.pool.request();
                if (this.cursorColumn && this.lastCursorValue) {
                    request.input('cursor', this.lastCursorValue);
                    parameterizedQuery = parameterizedQuery.replace('$1', '@cursor');
                }
                const res = await request.query(parameterizedQuery);
                results = res.recordset;
            }

            if (results.length > 0) {
                this.logger.debug(`Polled ${results.length} rows from ${this.id}`);
                
                results.forEach(row => {
                    const subTopic = this.topicColumn ? row[this.topicColumn] : null;
                    const finalTopic = subTopic ? `${this.topic}/${subTopic}` : this.topic;
                    
                    this.handleIncomingMessage(finalTopic, row);

                    // Update cursor to the maximum value found
                    if (this.cursorColumn && row[this.cursorColumn]) {
                        if (!this.lastCursorValue || row[this.cursorColumn] > this.lastCursorValue) {
                            this.lastCursorValue = row[this.cursorColumn];
                        }
                    }
                });
            }
        } catch (err) {
            this.logger.error({ err }, `Error during SQL poll for ${this.id}`);
        } finally {
            this.isPolling = false;
        }
    }

    async disconnect() {
        if (this.timer) clearInterval(this.timer);
        this.connected = false;
        if (this.pool) {
            if (this.driver === 'postgres' || this.driver === 'mssql') {
                await this.pool.end();
            } else if (this.driver === 'mysql') {
                await this.pool.end();
            }
        }
        this.updateStatus('disconnected');
    }

    publish(topic, payload, options, callback) {
        const err = new Error("SQL Poller Provider does not support outbound publishing yet.");
        this.logger.warn(err.message);
        if (callback) callback(err);
    }
}

module.exports = SqlPollerProvider;