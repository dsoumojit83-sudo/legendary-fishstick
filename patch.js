const fs = require('fs');
let html = fs.readFileSync('admin/index.html', 'utf8');

// 1. Add nav button
const navBtnTarget = `                    <span class="font-medium text-sm">Store Manager</span>
                </button>`;
const navBtnReplacement = `                    <span class="font-medium text-sm">Store Manager</span>
                </button>
                <button onclick="switchView('admins-view', this); fetchAdminsData();"
                    class="nav-btn w-full flex items-center gap-3 px-4 py-3 rounded-lg text-gray-400 hover:bg-white/5 hover:text-white transition-all border border-transparent">
                    <i data-lucide="shield-alert" class="w-5 h-5"></i>
                    <span class="font-medium text-sm">Access Control</span>
                </button>`;
html = html.replace(navBtnTarget, navBtnReplacement);

// 2. Add admins-view
const viewTarget = `                </div>

            </div>
        </main>`;
const viewReplacement = `                </div>

                <!-- ========== ADMINS ACCESS VIEW ========== -->
                <div id="admins-view" class="view-section space-y-8">
                    <div class="glass-panel rounded-2xl border border-white/5 overflow-hidden">
                        <div class="p-5 border-b border-white/5 flex justify-between items-center bg-black/20">
                            <div>
                                <h3 class="text-lg font-bold text-white">Administrators</h3>
                                <p class="text-xs text-gray-400 mt-1">Manage command center access</p>
                            </div>
                            <button onclick="openAddAdminModal()" class="flex items-center gap-2 px-4 py-2 bg-[#ff1a1a] text-black text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-white transition-all shrink-0">
                                <i data-lucide="user-plus" class="w-4 h-4"></i> Add Admin
                            </button>
                        </div>
                        <div class="overflow-x-auto">
                            <table class="w-full text-left min-w-[600px]">
                                <thead class="border-b border-white/5 bg-black/20">
                                    <tr class="text-[10px] uppercase tracking-widest text-gray-500">
                                        <th class="p-4">Email Address</th>
                                        <th class="p-4">Added On</th>
                                        <th class="p-4 text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody id="admins-tbody" class="text-sm divide-y divide-white/5">
                                    <tr><td colspan="3" class="p-6 text-center text-gray-500 text-xs">Loading admins...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

            </div>
        </main>`;
html = html.replace(viewTarget, viewReplacement);

// 3. Add Modal
const modalTarget = `    <div id="toast-notification"`;
const modalReplacement = `    <!-- Add Admin Modal -->
    <div id="add-admin-modal" class="fixed inset-0 bg-black/80 backdrop-blur-sm z-[200] hidden flex items-center justify-center opacity-0 transition-opacity p-4">
        <div class="bg-[#050505] border border-white/10 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden transform scale-95 transition-transform duration-300" id="add-admin-modal-content">
            <div class="p-6 border-b border-white/10 flex justify-between items-center bg-white/5">
                <h3 class="text-lg font-bold text-white">Add / Update Administrator</h3>
                <button onclick="closeAddAdminModal()" class="text-gray-400 hover:text-white transition-colors"><i data-lucide="x" class="w-5 h-5"></i></button>
            </div>
            <div class="p-6">
                <p class="text-xs text-gray-400 mb-6">Create a new admin account or reset password for an existing admin.</p>
                
                <div class="space-y-4">
                    <div>
                        <label class="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Admin Email</label>
                        <input type="email" id="admin-email" class="w-full bg-black border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#ff1a1a]" placeholder="admin@zyroeditz.xyz">
                    </div>
                    <div>
                        <label class="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Secure Password</label>
                        <input type="password" id="admin-password" class="w-full bg-black border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#ff1a1a]" placeholder="Min 6 characters">
                    </div>
                </div>

                <div class="mt-8 flex justify-end gap-3">
                    <button onclick="closeAddAdminModal()" class="px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-white text-sm transition-colors">Cancel</button>
                    <button onclick="submitAddAdmin()" class="px-5 py-2 rounded-lg bg-[#ff1a1a] hover:bg-white text-black text-sm font-bold transition-colors">Save Admin</button>
                </div>
            </div>
        </div>
    </div>

    <div id="toast-notification"`;
html = html.replace(modalTarget, modalReplacement);

// 4. Add JS functions
const jsTarget = `        function showToast(msg, isError = false) {`;
const jsReplacement = `        // ── ADMINS MANAGEMENT ──────────────────────────────────────────
        async function fetchAdminsData() {
            if (!authToken) return;
            const tbody = document.getElementById('admins-tbody');
            tbody.innerHTML = '<tr><td colspan="3" class="p-6 text-center text-gray-500 text-xs">Loading admins...</td></tr>';
            try {
                const res = await fetch('/api/admin-data?action=getAdmins', {
                    headers: { 'Authorization': 'Bearer ' + authToken }
                });
                if (!res.ok) throw new Error('Failed to fetch admins');
                const { admins } = await res.json();
                
                if (!admins || admins.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="3" class="p-6 text-center text-gray-500 text-xs">No extra admins found. Only zyroeditz.official@gmail.com has access.</td></tr>';
                    return;
                }
                
                tbody.innerHTML = admins.map(a => \`
                    <tr class="hover:bg-white/5 transition-colors group">
                        <td class="p-4 text-white font-medium">\${a.email}</td>
                        <td class="p-4 text-gray-400 text-xs">\${new Date(a.created_at).toLocaleDateString()}</td>
                        <td class="p-4 text-right">
                            <button onclick="deleteAdmin('\${a.email}')" class="p-2 bg-red-500/10 text-red-500 rounded-lg hover:bg-red-500 hover:text-white transition-colors opacity-0 group-hover:opacity-100" title="Remove Admin Access">
                                <i data-lucide="trash-2" class="w-4 h-4"></i>
                            </button>
                        </td>
                    </tr>
                \`).join('');
                if(window.lucide) lucide.createIcons();
            } catch(e) {
                console.error(e);
                tbody.innerHTML = '<tr><td colspan="3" class="p-6 text-center text-red-400 text-xs">Error loading admins. Did you create the admins table?</td></tr>';
            }
        }

        function openAddAdminModal() {
            document.getElementById('admin-email').value = '';
            document.getElementById('admin-password').value = '';
            const m = document.getElementById('add-admin-modal');
            const c = document.getElementById('add-admin-modal-content');
            m.classList.remove('hidden');
            requestAnimationFrame(() => {
                m.classList.remove('opacity-0');
                c.classList.remove('scale-95');
            });
        }

        function closeAddAdminModal() {
            const m = document.getElementById('add-admin-modal');
            const c = document.getElementById('add-admin-modal-content');
            m.classList.add('opacity-0');
            c.classList.add('scale-95');
            setTimeout(() => m.classList.add('hidden'), 300);
        }

        async function submitAddAdmin() {
            const email = document.getElementById('admin-email').value;
            const password = document.getElementById('admin-password').value;
            if (!email || !password) return showToast('Email and password required', true);
            
            try {
                const res = await fetch('/api/admin-data', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
                    body: JSON.stringify({ action: 'addAdmin', email, password })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to add admin');
                showToast('Admin added/updated successfully!');
                closeAddAdminModal();
                fetchAdminsData();
            } catch(e) {
                showToast(e.message, true);
            }
        }

        async function deleteAdmin(email) {
            if (!confirm(\`Revoke admin access for \${email}?\`)) return;
            try {
                const res = await fetch('/api/admin-data', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
                    body: JSON.stringify({ action: 'deleteAdmin', email })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to remove admin');
                showToast('Admin removed.');
                fetchAdminsData();
            } catch(e) {
                showToast(e.message, true);
            }
        }

        function showToast(msg, isError = false) {`;
html = html.replace(jsTarget, jsReplacement);

fs.writeFileSync('admin/index.html', html);
console.log('admin/index.html successfully updated!');
