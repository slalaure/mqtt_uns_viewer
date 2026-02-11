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
 * Login View Module
 * Handles the authentication UI (Local & Google) via dynamic HTML loading.
 * [UPDATED] Removed embedded HTML/CSS strings.
 */

export function initLoginStyles() {
    // Deprecated: Styles are now loaded with the HTML fragment
}

/**
 * Renders the login overlay and handles interaction.
 */
export async function showLoginOverlay() {
    const existing = document.getElementById('login-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'login-overlay';
    overlay.className = 'login-overlay';

    try {
        const response = await fetch('html/view.login.html');
        if (!response.ok) throw new Error(`Failed to load login template: ${response.statusText}`);
        overlay.innerHTML = await response.text();
    } catch (e) {
        console.error("Error loading login view:", e);
        overlay.innerHTML = `<div style="background:#fff;padding:20px;border-radius:8px;color:red;">Error loading login form.<br>Check console.</div>`;
    }

    document.body.appendChild(overlay);

    // --- Attach Event Listeners (after injection) ---
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const title = document.getElementById('form-title');
    const toggleLink = document.getElementById('toggle-auth-mode');
    const errorDiv = document.getElementById('login-error');
    const googleBtn = document.getElementById('btn-google-login');

    if (!loginForm) return; // Stop if load failed

    // Toggle Logic
    toggleLink.addEventListener('click', () => {
        const isLogin = loginForm.style.display !== 'none';
        errorDiv.style.display = 'none';
        
        if (isLogin) {
            // Switch to Register
            loginForm.style.display = 'none';
            registerForm.style.display = 'block';
            title.textContent = 'Create Account';
            toggleLink.textContent = 'Already have an account? Sign In';
        } else {
            // Switch to Login
            registerForm.style.display = 'none';
            loginForm.style.display = 'block';
            title.textContent = 'MQTT UNS Viewer';
            toggleLink.textContent = 'Need an account? Register';
        }
    });

    // Login Handler
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;
        const btn = loginForm.querySelector('button');
        handleAuth('auth/login', { username, password }, btn, 'Sign In');
    });

    // Register Handler
    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('reg-username').value;
        const password = document.getElementById('reg-password').value;
        const confirm = document.getElementById('reg-confirm').value;
        const btn = registerForm.querySelector('button');

        if (password !== confirm) {
            errorDiv.textContent = "Passwords do not match";
            errorDiv.style.display = 'block';
            return;
        }
        handleAuth('auth/register', { username, password }, btn, 'Create Account');
    });

    // Google Login
    if (googleBtn) {
        googleBtn.addEventListener('click', () => {
            const base = document.querySelector('base')?.getAttribute('href') || '/';
            const cleanBase = base.endsWith('/') ? base : base + '/';
            window.location.href = `${cleanBase}auth/google`;
        });
    }

    // Shared Auth Logic
    async function handleAuth(url, body, btn, defaultText) {
        btn.disabled = true;
        btn.textContent = 'Processing...';
        errorDiv.style.display = 'none';

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();

            if (data.success) {
                window.location.reload();
            } else {
                throw new Error(data.error || 'Operation failed');
            }
        } catch (err) {
            errorDiv.textContent = err.message;
            errorDiv.style.display = 'block';
            btn.disabled = false;
            btn.textContent = defaultText;
        }
    }
}