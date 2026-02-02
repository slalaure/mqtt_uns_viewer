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
 * Admin View Module
 * Handles User Management Dashboard (List users, Delete users).
 */

let usersTableBody = null;

/**
 * Initializes the Admin View elements.
 */
export function initAdminView() {
    usersTableBody = document.getElementById('admin-users-table-body');
    const refreshBtn = document.getElementById('btn-admin-refresh');
    
    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadUsers);
    }
}

/**
 * Called when the Admin tab is activated.
 */
export function onAdminViewShow() {
    loadUsers();
}

/**
 * Fetches users from the API and renders them.
 */
async function loadUsers() {
    if (!usersTableBody) return;
    
    usersTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px;">Loading users...</td></tr>';
    
    try {
        const res = await fetch('api/admin/users');
        if (!res.ok) {
            if (res.status === 403) throw new Error("Access Denied: Admin privileges required.");
            throw new Error("Failed to fetch user list.");
        }
        const users = await res.json();
        renderUsers(users);
    } catch (e) {
        console.error("Admin Load Error:", e);
        usersTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--color-danger); padding: 20px;">Error: ${e.message}</td></tr>`;
    }
}

/**
 * Renders the user table rows.
 * @param {Array} users 
 */
function renderUsers(users) {
    usersTableBody.innerHTML = '';
    
    if (users.length === 0) {
        usersTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No users found.</td></tr>';
        return;
    }

    users.forEach(user => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--color-border)';
        
        const lastLogin = user.last_login ? new Date(user.last_login).toLocaleString() : 'Never';
        const roleBadge = user.role === 'admin' 
            ? '<span style="background:var(--color-danger); color:white; padding:2px 6px; border-radius:4px; font-size:0.8em; font-weight:bold;">ADMIN</span>' 
            : '<span style="background:var(--color-success); color:white; padding:2px 6px; border-radius:4px; font-size:0.8em;">USER</span>';

        const isSelf = window.currentUser && window.currentUser.id === user.id;
        const deleteDisabled = isSelf ? 'disabled title="You cannot delete yourself"' : '';
        const deleteStyle = isSelf ? 'opacity: 0.5; cursor: not-allowed;' : '';

        tr.innerHTML = `
            <td style="padding: 10px;">${user.username || '<span style="font-style:italic; color:gray;">(Google)</span>'}</td>
            <td style="padding: 10px;">${user.display_name || '-'}</td>
            <td style="padding: 10px;">${user.email || '-'}</td>
            <td style="padding: 10px;">${roleBadge}</td>
            <td style="padding: 10px; font-size: 0.9em;">${lastLogin}</td>
            <td style="padding: 10px; text-align: right;">
                <button class="danger-button btn-delete-user" data-id="${user.id}" data-username="${user.username || user.display_name}" ${deleteDisabled} style="${deleteStyle}">Delete</button>
            </td>
        `;
        
        usersTableBody.appendChild(tr);
    });

    // Attach event listeners
    document.querySelectorAll('.btn-delete-user').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.target.dataset.id;
            const name = e.target.dataset.username;
            deleteUser(id, name);
        });
    });
}

/**
 * Handles user deletion.
 */
async function deleteUser(id, username) {
    if (!confirm(`⚠️ WARNING: Are you sure you want to delete user "${username}"?\n\nThis will permanently delete their account AND all their saved data (charts, mapper configs, history).`)) return;
    
    try {
        const res = await fetch(`api/admin/users/${id}`, { method: 'DELETE' });
        const data = await res.json();
        
        if (data.success) {
            loadUsers(); // Refresh list
        } else {
            alert("Error: " + data.error);
        }
    } catch (e) {
        alert("Request failed: " + e.message);
    }
}