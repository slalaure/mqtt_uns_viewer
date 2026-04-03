const basicAuth = require('basic-auth');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;

// --- Module-level State ---
let config = null;
let logger = null;

/**
 * Configures Passport and Session management.
 * @param {express.Application} app - The Express application instance.
 * @param {object} appConfig - Application configuration.
 * @param {pino.Logger} appLogger - Application logger.
 * @param {object} userManager - The user manager instance.
 * @param {string} sessionsPath - Path to the sessions directory.
 * @param {string} basePath - Base path for the application.
 */
function configureAuth(app, appConfig, appLogger, userManager, sessionsPath, basePath) {
    config = appConfig;
    logger = appLogger;

    // 1. Session Middleware using embedded DuckDB Store
    const sessionStore = userManager.createSessionStore(session);

    app.use(session({
        store: sessionStore, 
        secret: config.SESSION_SECRET,
        resave: false,
        rolling: true,
        saveUninitialized: false,
        cookie: { 
            secure: 'auto',
            maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days expiration (in milliseconds)
            sameSite: 'lax' 
        }
    }));

    // 2. Passport Middleware
    app.use(passport.initialize());
    app.use(passport.session());

    // 3. Passport Serialization
    passport.serializeUser((user, done) => {
        done(null, user.id);
    });

    passport.deserializeUser(async (id, done) => {
        try {
            const user = await userManager.findById(id);
            done(null, user);
        } catch (err) {
            done(err);
        }
    });

    // 4. Local Strategy
    passport.use(new LocalStrategy(async (username, password, done) => {
        try {
            const user = await userManager.findByUsername(username);
            if (!user) { return done(null, false, { message: 'Incorrect username.' }); }
            const isValid = await userManager.verifyPassword(password, user.password_hash);
            if (!isValid) { return done(null, false, { message: 'Incorrect password.' }); }
            return done(null, user);
        } catch (err) { return done(err); }
    }));

    // 5. Google Strategy
    if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
        logger.info("✅ Google OAuth Strategy Enabled.");
        passport.use(new GoogleStrategy({
            clientID: config.GOOGLE_CLIENT_ID,
            clientSecret: config.GOOGLE_CLIENT_SECRET,
            callbackURL: `${config.PUBLIC_URL}${basePath === '/' ? '' : basePath}/auth/google/callback`
        },
        async (accessToken, refreshToken, profile, done) => {
            try {
                const user = await userManager.findOrCreateGoogleUser(profile);
                return done(null, user);
            } catch (err) { return done(err); }
        }));
    }
}

/**
 * Middleware to check if user is authenticated.
 * Includes fallback to legacy Basic Auth and allows public assets.
 */
function authMiddleware(req, res, next) {
    if (req.isAuthenticated()) return next();
    
    // 1. Allow public assets
    const ext = path.extname(req.path).toLowerCase();
    const allowedExts = ['.css', '.js', '.svg', '.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.gltf', '.glb', '.bin'];
    if (allowedExts.includes(ext)) return next();

    // 2. Fallback to Legacy Basic Auth
    if (config && config.HTTP_USER && config.HTTP_PASSWORD) {
        const credentials = basicAuth(req);
        if (credentials && credentials.name === config.HTTP_USER && credentials.pass === config.HTTP_PASSWORD) {
            return next();
        }
        res.setHeader('WWW-Authenticate', 'Basic realm="Korelate"');
        return res.status(401).send('Authentication required.');
    }

    // 3. Allow login/auth routes
    if (req.path.startsWith('/auth') || req.path === '/login') {
        return next();
    }

    // 4. Force Authentication
    // If it's an API/XHR request, return 401 JSON.
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json')) || req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized. Please log in.' });
    }

    // If it's a browser request (HTML), redirect to the login page.
    const loginUrl = (config && config.BASE_PATH && config.BASE_PATH !== '/') ? `${config.BASE_PATH}/login` : '/login';
    return res.redirect(loginUrl);
}

/**
 * Middleware to check if user is an admin.
 * Includes fallback to legacy Basic Auth.
 */
function requireAdmin(req, res, next) {
    if (req.isAuthenticated() && req.user.role === 'admin') {
        return next();
    }

    // Fallback to Legacy Basic Auth
    if (config.HTTP_USER && config.HTTP_PASSWORD) {
        const credentials = basicAuth(req);
        if (credentials && credentials.name === config.HTTP_USER && credentials.pass === config.HTTP_PASSWORD) {
            return next();
        }
    }

    logger.warn(`[Security] Admin access denied for ${req.user ? req.user.username : req.ip} on ${req.originalUrl}`);
    return res.status(403).send("Forbidden: Admin privileges required.");
}

module.exports = {
    configureAuth,
    authMiddleware,
    requireAdmin
};