/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * Global State Manager (Vanilla JS Proxy-based Pub/Sub)
 * Provides a lightweight reactive store for the frontend without external frameworks.
 */

const listeners = new Map();

// Initial source of truth for the frontend
const internalState = {
    currentTopic: null,
    currentSourceId: null,
    isDarkMode: localStorage.getItem('theme') === 'dark',
    isLivePayload: true,
    unsavedChanges: false,
    activeView: 'tree'
};

/**
 * The reactive state object. 
 * Modifying properties here (e.g., state.isDarkMode = true) will automatically 
 * trigger all subscribed callbacks.
 */
export const state = new Proxy(internalState, {
    set(target, property, value) {
        // Only trigger updates if the value actually changed
        if (target[property] !== value) {
            const oldValue = target[property];
            target[property] = value;
            
            // Notify all subscribers of this specific property
            if (listeners.has(property)) {
                listeners.get(property).forEach(callback => callback(value, oldValue));
            }
        }
        return true;
    }
});

/**
 * Subscribe to a specific state property change.
 * @param {string} property - The state key to watch (e.g., 'currentTopic').
 * @param {function} callback - Function to call when the value changes: (newValue, oldValue) => {}
 * @param {boolean} runImmediately - If true, fires the callback immediately with the current state.
 */
export function subscribe(property, callback, runImmediately = false) {
    if (!listeners.has(property)) {
        listeners.set(property, new Set());
    }
    listeners.get(property).add(callback);
    
    if (runImmediately) {
        callback(state[property], state[property]);
    }
}

/**
 * Unsubscribe a callback from a state property to prevent memory leaks.
 * @param {string} property - The state key.
 * @param {function} callback - The original callback function to remove.
 */
export function unsubscribe(property, callback) {
    if (listeners.has(property)) {
        listeners.get(property).delete(callback);
    }
}