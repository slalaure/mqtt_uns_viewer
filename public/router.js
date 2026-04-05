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
 * Router Module
 * Handles Single Page Application (SPA) navigation, URL history, and view transitions.
 */

import { state, subscribe } from './state.js';
import { trackEvent } from './utils.js';

/**
 * Initializes the routing system and binds navigation events.
 * @param {string} appBasePath - The base path of the application.
 * @param {Array<string>} routeNames - List of valid route names.
 * @param {Object} currentUser - The current authenticated user.
 * @param {Object} viewCallbacks - Lifecycle hooks for entering/leaving specific views.
 */
export function initRouter(appBasePath, routeNames, currentUser, viewCallbacks = {}) {
    // 1. Subscribe to state.activeView to handle generic DOM toggling & lifecycle
    subscribe('activeView', (newView, oldView) => {
        if (newView === oldView) return;

        // Reset DOM visually
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));

        const targetView = document.getElementById(`${newView}-view`);
        const targetBtn = document.getElementById(`btn-${newView}-view`);

        if (targetView) targetView.classList.add('active');
        if (targetBtn) targetBtn.classList.add('active');

        trackEvent(`view_switch_${newView}`);

        // Handle specific view lifecycle hooks (Show)
        if (viewCallbacks[newView]) {
            viewCallbacks[newView]();
        }

        // Cleanup hooks for leaving views (Hide)
        if (viewCallbacks[`${oldView}Hide`]) {
            viewCallbacks[`${oldView}Hide`]();
        }

        // Manage URL History API
        const base = appBasePath.endsWith('/') ? appBasePath : appBasePath + '/';
        const newUrl = `${base}${newView}/`;
        if (window.location.pathname !== newUrl && window.location.pathname !== newUrl.slice(0, -1)) {
            window.history.pushState({ view: newView }, '', newUrl);
        }
    });

    const ROLES = { 'viewer': 10, 'operator': 20, 'engineer': 30, 'admin': 100 };
    const hasRole = (minRole) => {
        const userRole = currentUser?.role || 'viewer';
        return (ROLES[userRole] || 10) >= (ROLES[minRole] || 0);
    };

    // 2. Bind all navigation buttons dynamically
    routeNames.forEach(route => {
        const btn = document.getElementById(`btn-${route}-view`);
        if (btn) {
            btn.addEventListener('click', () => {
                // Safety Checks
                if (route === 'admin' && !hasRole('admin')) {
                    console.warn("Unauthorized: Admin role required.");
                    state.activeView = 'tree';
                    return;
                }
                if (route === 'modeler' && (!window.viewModelerEnabled || !hasRole('engineer'))) {
                    console.warn("Unauthorized or disabled: Engineer role required.");
                    state.activeView = 'tree';
                    return;
                }
                if (route === 'mapper' && !hasRole('engineer')) {
                    console.warn("Unauthorized: Engineer role required.");
                    state.activeView = 'tree';
                    return;
                }
                if (route === 'publish' && !hasRole('operator')) {
                    console.warn("Unauthorized: Operator role required.");
                    state.activeView = 'tree';
                    return;
                }
                // Update Reactive State
                state.activeView = route;
            });
        }
    });

    // 3. Handle browser back/forward buttons
    window.addEventListener('popstate', (event) => {
        if (event.state && event.state.view) {
            state.activeView = event.state.view;
        } else {
            handleRoutingFromUrl(appBasePath, routeNames);
        }
    });
}

/**
 * Derives the initial active view based on the current URL.
 * @param {string} appBasePath - The base path of the application.
 * @param {Array<string>} routeNames - List of valid route names.
 */
export function handleRoutingFromUrl(appBasePath, routeNames) {
    const path = window.location.pathname;
    const normalizedBase = appBasePath.endsWith('/') ? appBasePath.slice(0, -1) : appBasePath;
    let relativePath = path;
    
    if (path.startsWith(normalizedBase)) {
        relativePath = path.substring(normalizedBase.length);
    }
    const cleanPath = relativePath.replace(/^\/|\/$/g, '');

    // Map URL aliases
    if (cleanPath === 'map' || cleanPath === 'svg') {
        state.activeView = 'hmi';
    } else if (routeNames.includes(cleanPath)) {
        state.activeView = cleanPath;
    } else {
        state.activeView = 'tree'; // Default fallback
    }
}