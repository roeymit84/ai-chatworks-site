// ============================================
// AI CHATWORKS ADMIN DASHBOARD
// ============================================

(function () {
    'use strict';

    // ============================================
    // CONFIGURATION
    // ============================================

    const SUPABASE_CONFIG = {
        url: 'https://ldcapthzveqdbvthukiz.supabase.co',
        anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxkY2FwdGh6dmVxZGJ2dGh1a2l6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMwOTM0NDEsImV4cCI6MjA3ODY2OTQ0MX0.mPNwwP_VFWpVso8hSy2I-ECH8v80EscFfEHeu2eiREc'
    };

    const ADMIN_ROLE = 'admin';

    // ============================================
    // STATE
    // ============================================

    let supabase = null;
    let currentUser = null;
    let charts = {};
    let allMarketplaceData = []; // Store all data for filtering
    let activeFilters = {
        search: '',
        category: '',
        tier: '',
        status: ''
    };

    // ============================================
    // QUERY CONFIGURATIONS
    // ============================================

    const QUERY_CONFIGS = {
        recent_users: {
            name: 'Recent Users',
            function: 'admin_get_recent_users',
            params: [
                { name: 'limit_count', label: 'Limit', type: 'number', default: 50 }
            ]
        },
        find_user: {
            name: 'Find User by Email',
            function: 'admin_find_user_by_email',
            params: [
                { name: 'search_email', label: 'Email', type: 'text', default: '' }
            ]
        },
        heavy_users: {
            name: 'Heavy Users',
            function: 'admin_get_heavy_users',
            params: [
                { name: 'min_prompts', label: 'Min Prompts', type: 'number', default: 10 }
            ]
        },
        inactive_users: {
            name: 'Inactive Users',
            function: 'admin_get_inactive_users',
            params: [
                { name: 'days_inactive', label: 'Days Inactive', type: 'number', default: 30 }
            ]
        },
        user_prompts: {
            name: 'User Prompts (Support)',
            function: 'admin_get_user_prompts',
            params: [
                { name: 'target_user_id', label: 'User ID', type: 'text', default: '' }
            ]
        },
        user_folders: {
            name: 'User Folders (Support)',
            function: 'admin_get_user_folders',
            params: [
                { name: 'target_user_id', label: 'User ID', type: 'text', default: '' }
            ]
        },
        marketplace_prompts: {
            name: 'Marketplace Prompts',
            function: 'admin_get_marketplace_prompts',
            params: []
        },
        top_downloads: {
            name: 'Top Downloads',
            function: 'admin_get_top_downloads',
            params: [
                { name: 'limit_count', label: 'Limit', type: 'number', default: 10 }
            ]
        },
        db_stats: {
            name: 'Database Statistics',
            function: 'admin_get_db_stats',
            params: []
        },
        signup_stats: {
            name: 'Signup Trends',
            function: 'admin_get_signup_stats',
            params: []
        },
        activity_stats: {
            name: 'Activity Statistics',
            function: 'admin_get_activity_stats',
            params: []
        }
    };

    // ============================================
    // AUTHENTICATION
    // ============================================

    async function handleLogin(e) {
        e.preventDefault();

        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;
        const errorEl = document.getElementById('login-error');

        try {
            const { data, error } = await supabase.auth.signInWithPassword({
                email: email,
                password: password
            });

            if (error) throw error;

            // Check admin role
            const { data: profile } = await supabase
                .from('user_profiles')
                .select('role')
                .eq('id', data.user.id)
                .single();

            if (profile?.role !== ADMIN_ROLE) {
                await supabase.auth.signOut();
                throw new Error('Access denied: Admin role required');
            }

            currentUser = data.user;
            document.getElementById('admin-email').textContent = data.user.email;
            showDashboard();
            loadDashboardData();
        } catch (error) {
            console.error('Login error:', error);
            errorEl.textContent = error.message || 'Invalid credentials';
            setTimeout(() => {
                errorEl.textContent = '';
            }, 3000);
        }
    }

    async function handleLogout() {
        await supabase.auth.signOut();
        currentUser = null;
        showLogin();
    }

    async function checkAuth() {
        if (!initSupabase()) {
            showLogin();
            return;
        }

        // SECURITY: Always show login screen for admin dashboard
        // Do not auto-login even if session exists
        showLogin();
    }

    function showLogin() {
        document.getElementById('login-screen').style.opacity = '1';
        document.getElementById('login-screen').classList.remove('hidden');
        document.getElementById('app-shell').classList.add('hidden');
    }

    function showDashboard() {
        document.getElementById('login-screen').style.opacity = '0';
        setTimeout(() => {
            document.getElementById('login-screen').classList.add('hidden');
            document.getElementById('app-shell').classList.remove('hidden');
        }, 300);
    }

    // ============================================
    // SUPABASE INITIALIZATION
    // ============================================

    function initSupabase() {
        if (typeof window.supabase === 'undefined') {
            console.error('Supabase client not loaded');
            return false;
        }

        supabase = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
        return true;
    }

    // ============================================
    // NAVIGATION
    // ============================================

    window.switchView = function (viewName, element) {
        // Hide all views
        document.querySelectorAll('.view-container').forEach(el => el.classList.add('hidden'));
        // Show selected view
        document.getElementById('view-' + viewName).classList.remove('hidden');

        // Update active nav
        document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));
        if (element) {
            element.classList.add('active');
        }

        // Load view-specific data
        if (viewName === 'marketplace') {
            loadMarketplaceData();
        }
    };

    // ============================================
    // OVERVIEW DATA LOADING
    // ============================================

    async function loadDashboardData() {
        try {
            await Promise.all([
                loadTotalStats(),
                loadUserGrowthChart(),
                loadMonthlyEngagement(),
                loadMarketplaceStats()
            ]);
        } catch (error) {
            console.error('Error loading dashboard data:', error);
        }
    }

    async function loadTotalStats() {
        try {
            const { data: userData } = await supabase.rpc('get_total_users');
            document.getElementById('total-users').textContent = userData || 0;

            const { data: promptData } = await supabase.rpc('get_total_prompts');
            document.getElementById('total-prompts').textContent = promptData || 0;

            const { data: folderData } = await supabase.rpc('get_total_folders');
            document.getElementById('total-folders').textContent = folderData || 0;

            const { data: encryptedData } = await supabase.rpc('get_encrypted_items_count');
            document.getElementById('encrypted-items').textContent = encryptedData || 0;
        } catch (error) {
            console.error('Error loading total stats:', error);
        }
    }

    async function loadUserGrowthChart() {
        try {
            const { data, error } = await supabase.rpc('get_user_growth_data');
            if (error) throw error;

            const labels = data.map(row => new Date(row.signup_date).toLocaleDateString());
            const values = data.map(row => row.user_count);

            const ctx = document.getElementById('userGrowthChart').getContext('2d');

            if (charts.userGrowth) {
                charts.userGrowth.destroy();
            }

            const gradient = ctx.createLinearGradient(0, 0, 0, 400);
            gradient.addColorStop(0, 'rgba(139, 92, 246, 0.5)');
            gradient.addColorStop(1, 'rgba(139, 92, 246, 0.0)');

            charts.userGrowth = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'New Users',
                        data: values,
                        borderColor: '#8b5cf6',
                        backgroundColor: gradient,
                        borderWidth: 2,
                        tension: 0.4,
                        fill: true,
                        pointBackgroundColor: '#ffffff',
                        pointBorderColor: '#8b5cf6',
                        pointRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { beginAtZero: true, grid: { color: '#f3f4f6' } },
                        x: { grid: { display: false } }
                    }
                }
            });
        } catch (error) {
            console.error('Error loading user growth chart:', error);
        }
    }

    async function loadMonthlyEngagement() {
        try {
            // Get users active this month (created or updated prompts/folders)
            const monthStart = new Date();
            monthStart.setDate(1);
            monthStart.setHours(0, 0, 0, 0);

            const { data: totalUsers } = await supabase.rpc('get_total_users');

            // Get unique users who created/updated content this month
            const { data: activePrompts } = await supabase
                .from('prompts')
                .select('user_id')
                .gte('updated_at', monthStart.toISOString());

            const { data: activeFolders } = await supabase
                .from('folders')
                .select('user_id')
                .gte('updated_at', monthStart.toISOString());

            const activeUserIds = new Set([
                ...(activePrompts || []).map(p => p.user_id),
                ...(activeFolders || []).map(f => f.user_id)
            ]);

            const activeCount = activeUserIds.size;
            const percentage = totalUsers > 0 ? Math.round((activeCount / totalUsers) * 100) : 0;

            document.getElementById('monthly-active').textContent = activeCount.toLocaleString();
            document.getElementById('engagement-bar').style.width = percentage + '%';
            document.getElementById('engagement-percent').textContent = percentage + '% of Total Users';
        } catch (error) {
            console.error('Error loading monthly engagement:', error);
        }
    }

    async function loadMarketplaceStats() {
        try {
            // Get all marketplace prompts (removed is_active filter to show all prompts)
            const { data: allPrompts, error: allError } = await supabase
                .from('marketplace_prompts')
                .select('tier, downloads_count, title, category');

            if (allError) throw allError;

            const totalPrompts = allPrompts?.length || 0;
            const proPrompts = allPrompts?.filter(p => p.tier === 'pro').length || 0;
            const regularPrompts = allPrompts?.filter(p => p.tier === 'free').length || 0;

            document.getElementById('marketplace-total-prompts').textContent = totalPrompts;
            document.getElementById('marketplace-pro-prompts').textContent = proPrompts;
            document.getElementById('marketplace-regular-prompts').textContent = regularPrompts;

            // Get top 5 downloaded prompts
            const { data: topDownloads, error: topError } = await supabase
                .from('marketplace_prompts')
                .select('title, category, downloads_count, tier')
                .order('downloads_count', { ascending: false })
                .limit(5);

            if (topError) throw topError;

            const topDownloadsContainer = document.getElementById('marketplace-top-downloads');

            if (!topDownloads || topDownloads.length === 0) {
                topDownloadsContainer.innerHTML = '<p style="color: var(--text-tertiary); text-align: center;">No downloads yet</p>';
                return;
            }

            let html = '<div style="display: flex; flex-direction: column; gap: 12px;">';
            topDownloads.forEach((prompt, index) => {
                const tierBadgeClass = prompt.tier === 'pro' ? 'badge-pro-gold' : 'badge-free';
                html += `
                    <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px; background: var(--bg-secondary); border-radius: 8px;">
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <div style="font-size: 18px; font-weight: 700; color: var(--text-tertiary); min-width: 24px;">#${index + 1}</div>
                            <div>
                                <div style="font-weight: 600;">${prompt.title}</div>
                                <div style="font-size: 12px; color: var(--text-tertiary);">${prompt.category}</div>
                            </div>
                        </div>
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <span class="badge ${tierBadgeClass}" style="font-size: 11px;">${prompt.tier.toUpperCase()}</span>
                            <div style="font-weight: 600; color: #8b5cf6;">${prompt.downloads_count} downloads</div>
                        </div>
                    </div>
                `;
            });
            html += '</div>';

            topDownloadsContainer.innerHTML = html;
        } catch (error) {
            console.error('Error loading marketplace stats:', error);
            document.getElementById('marketplace-total-prompts').textContent = '0';
            document.getElementById('marketplace-pro-prompts').textContent = '0';
            document.getElementById('marketplace-regular-prompts').textContent = '0';
            document.getElementById('marketplace-top-downloads').innerHTML = '<p style="color: var(--danger); text-align: center;">Error loading data</p>';
        }
    }

    // ============================================
    // QUERY CONSOLE
    // ============================================

    window.updateQueryParams = function () {
        const selector = document.getElementById('query-selector');
        const queryKey = selector.value;
        const config = QUERY_CONFIGS[queryKey];
        const paramsContainer = document.getElementById('query-params');

        if (!config || config.params.length === 0) {
            paramsContainer.innerHTML = '';
            return;
        }

        let html = '';
        config.params.forEach(param => {
            html += `
                <div class="form-group">
                    <label>${param.label}</label>
                    <input type="${param.type}" 
                           id="param-${param.name}" 
                           value="${param.default}"
                           ${param.type === 'text' ? 'placeholder="' + param.label + '"' : ''}>
                </div>
            `;
        });

        paramsContainer.innerHTML = html;
    };

    window.runQuery = async function () {
        const selector = document.getElementById('query-selector');
        const queryKey = selector.value;
        const config = QUERY_CONFIGS[queryKey];
        const outputEl = document.getElementById('query-output');

        if (!config) return;

        // Show loading
        outputEl.innerHTML = '<div style="color: #38bdf8;">Running query...</div>';

        try {
            // Collect parameters
            const params = {};
            config.params.forEach(param => {
                const input = document.getElementById('param-' + param.name);
                if (input) {
                    params[param.name] = param.type === 'number' ? parseInt(input.value) : input.value;
                }
            });

            // Execute query
            const { data, error } = await supabase.rpc(config.function, params);

            if (error) throw error;

            // Format results
            if (!data || data.length === 0) {
                outputEl.innerHTML = '<div style="color: #f97316;">No results found</div>';
                return;
            }

            // Build table
            const keys = Object.keys(data[0]);
            let html = `
                <div style="margin-bottom: 12px; color: #10b981;">✓ Query executed successfully (${data.length} rows)</div>
                <table class="result-table">
                    <thead>
                        <tr>${keys.map(k => `<th>${k.toUpperCase()}</th>`).join('')}</tr>
                    </thead>
                    <tbody>
                        ${data.map(row => `
                            <tr>${keys.map(k => `<td>${formatValue(row[k])}</td>`).join('')}</tr>
                        `).join('')}
                    </tbody>
                </table>
            `;

            outputEl.innerHTML = html;
        } catch (error) {
            console.error('Query error:', error);
            outputEl.innerHTML = `<div style="color: #ef4444;">Error: ${error.message}</div>`;
        }
    };

    function formatValue(value) {
        if (value === null || value === undefined) return '-';
        if (typeof value === 'boolean') return value ? '✓' : '✗';
        if (typeof value === 'string' && value.length > 50) return value.substring(0, 50) + '...';
        if (typeof value === 'object') return JSON.stringify(value);
        return value;
    }

    // ============================================
    // MARKETPLACE
    // ============================================

    async function loadMarketplaceData() {
        const tbody = document.getElementById('marketplace-table-body');

        try {
            const { data, error } = await supabase.rpc('admin_get_marketplace_prompts');

            if (error) {
                console.error('Marketplace RPC error:', error);
                throw error;
            }

            if (!data || data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-[13px] text-slate-400">No marketplace prompts yet. Upload your first prompt!</td></tr>';
                allMarketplaceData = [];
                return;
            }

            // Store data globally for filtering
            allMarketplaceData = data;

            // Render the table
            renderMarketplaceTable(data);

            // Load categories for upload form and populate filter dropdown
            await loadCategories();
            await populateFilterDropdowns();

            // Initialize filters
            initializeMarketplaceFilters();
        } catch (error) {
            console.error('Error loading marketplace:', error);
            tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-8 text-center text-[13px] text-red-600">Error: ${error.message}</td></tr>`;
            allMarketplaceData = [];
        }
    }

    async function loadCategories() {
        try {
            // Get unique categories from existing prompts
            const { data, error } = await supabase
                .from('marketplace_prompts')
                .select('category');

            if (error) throw error;

            const categories = [...new Set(data.map(p => p.category))].sort();
            const categorySelect = document.getElementById('upload-category');

            if (categories.length > 0) {
                categorySelect.innerHTML = categories.map(cat =>
                    `<option value="${cat}">${cat}</option>`
                ).join('');

                // Add "Other" option
                categorySelect.innerHTML += '<option value="other">Other (specify below)</option>';
            } else {
                // Default categories if no prompts exist yet
                categorySelect.innerHTML = `
                    <option value="Marketing">Marketing</option>
                    <option value="Coding">Coding</option>
                    <option value="Business">Business</option>
                    <option value="Creative">Creative</option>
                    <option value="Writing">Writing</option>
                    <option value="Education">Education</option>
                    <option value="other">Other (specify below)</option>
                `;
            }
        } catch (error) {
            console.error('Error loading categories:', error);
        }
    }

    // Toggle custom category input
    window.toggleCustomCategory = function () {
        const categorySelect = document.getElementById('upload-category');
        const customGroup = document.getElementById('custom-category-group');
        const customInput = document.getElementById('custom-category-input');

        if (categorySelect.value === 'other') {
            customGroup.style.display = 'block';
            customInput.required = true;
        } else {
            customGroup.style.display = 'none';
            customInput.required = false;
            customInput.value = '';
        }
    };

    window.uploadPrompt = async function () {
        const title = document.getElementById('upload-name').value;
        let category = document.getElementById('upload-category').value;
        const description = document.getElementById('upload-description').value;
        const content = document.getElementById('upload-content').value;
        const tier = document.getElementById('upload-tier').value;

        // Use custom category if "other" is selected
        if (category === 'other') {
            const customCategory = document.getElementById('custom-category-input').value.trim();
            if (!customCategory) {
                showAlertModal('ai-chatworks.com says', 'Please enter a custom category name');
                return;
            }
            category = customCategory;
        }

        try {
            const { error } = await supabase
                .from('marketplace_prompts')
                .insert({
                    title: title,
                    category: category,
                    description: description,
                    content: content,
                    tier: tier,
                    user_id: currentUser.id
                });

            if (error) throw error;

            showAlertModal('ai-chatworks.com says', 'Prompt published successfully!');
            document.getElementById('marketplace-upload-form').reset();
            document.getElementById('custom-category-group').style.display = 'none';
            loadMarketplaceData();
        } catch (error) {
            console.error('Upload error:', error);
            showAlertModal('ai-chatworks.com says', 'Error uploading prompt: ' + error.message);
        }
    };

    // ============================================
    // INITIALIZATION
    // ============================================

    function init() {
        // Check authentication
        checkAuth();

        // Event listeners
        document.getElementById('login-form').addEventListener('submit', handleLogin);
        document.getElementById('logout-btn').addEventListener('click', handleLogout);

        // Initialize query params
        updateQueryParams();
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // ============================================
    // REFRESH FUNCTIONS
    // ============================================

    window.refreshOverview = async function () {
        console.log('Refreshing overview data...');
        await loadDashboardData();
        showAlertModal('ai-chatworks.com says', 'Overview data refreshed!');
    };

    window.refreshMarketplace = async function () {
        console.log('Refreshing marketplace data...');
        await loadMarketplaceData();
        showAlertModal('ai-chatworks.com says', 'Marketplace data refreshed!');
    };

    // ============================================
    // EDIT MARKETPLACE PROMPT
    // ============================================

    window.editMarketplacePrompt = async function (promptId) {
        try {
            // Fetch prompt details and categories
            const { data, error } = await supabase
                .from('marketplace_prompts')
                .select('*')
                .eq('id', promptId)
                .single();

            if (error) throw error;

            const categories = await getUniqueCategories();

            // Create modal with same styling as new prompt modal
            const modal = document.createElement('div');
            modal.id = 'editPromptModal';
            modal.className = 'fixed inset-0 z-40 flex items-center justify-center';
            modal.innerHTML = `
                <div class="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" onclick="this.parentElement.remove()"></div>
                
                <div class="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 transform transition-all overflow-hidden">
                    <div class="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                        <h3 class="text-[13px] font-semibold text-slate-800">Edit Prompt</h3>
                        <button onclick="this.closest('#editPromptModal').remove()" class="text-slate-400 hover:text-slate-600">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>

                    <div class="p-6 space-y-4">
                        <div class="grid grid-cols-2 gap-4">
                            <div>
                                <label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Prompt Name</label>
                                <input type="text" id="edit-title" value="${data.title.replace(/"/g, '&quot;')}" class="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-[13px]">
                            </div>
                            <div>
                                <label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Category</label>
                                <select id="edit-category" class="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-[13px] text-slate-700">
                                    ${categories.map(cat => `<option value="${cat}" ${data.category === cat ? 'selected' : ''}>${cat}</option>`).join('')}
                                </select>
                            </div>
                        </div>

                        <div class="grid grid-cols-2 gap-4">
                            <div>
                                <label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Created By</label>
                                <input type="email" value="${data.user_email || 'Unknown'}" class="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[13px] text-slate-500 cursor-not-allowed" readonly>
                            </div>
                            <div class="flex gap-4">
                                <div class="flex-1">
                                    <label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Tier</label>
                                    <div class="flex gap-3 mt-2">
                                        <label class="flex items-center gap-2 cursor-pointer">
                                            <input type="radio" name="edit-tier" value="free" ${data.tier === 'free' ? 'checked' : ''} class="text-blue-600 focus:ring-blue-500">
                                            <span class="text-[13px] text-slate-700">Free</span>
                                        </label>
                                        <label class="flex items-center gap-2 cursor-pointer">
                                            <input type="radio" name="edit-tier" value="pro" ${data.tier === 'pro' ? 'checked' : ''} class="text-blue-600 focus:ring-blue-500">
                                            <span class="text-[13px] text-slate-700">Pro</span>
                                        </label>
                                    </div>
                                </div>
                                <div class="flex-1">
                                    <label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Status</label>
                                    <label class="relative inline-flex items-center cursor-pointer mt-2">
                                        <input type="checkbox" id="edit-active" ${data.is_active ? 'checked' : ''} class="sr-only peer">
                                        <div class="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
                                        <span class="ml-2 text-[13px] font-medium text-gray-700">Active</span>
                                    </label>
                                </div>
                            </div>
                        </div>

                        <div>
                            <label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Description</label>
                            <textarea id="edit-description" rows="2" class="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-[13px] resize-none">${data.description || ''}</textarea>
                        </div>

                        <div>
                            <label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">System Prompt</label>
                            <textarea id="edit-content" rows="6" class="w-full px-3 py-2 bg-slate-50 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-[13px] font-mono text-slate-600 resize-none">${data.content || ''}</textarea>
                            <p class="text-xs text-slate-400 mt-1 text-right">Markdown supported</p>
                        </div>
                    </div>

                    <div class="px-6 py-4 bg-gray-50 flex justify-end gap-3 border-t border-gray-100">
                        <button onclick="document.getElementById('editPromptModal').remove()" class="px-4 py-2 text-[13px] font-medium text-slate-600 hover:text-slate-800 transition-colors">Cancel</button>
                        <button onclick="updateMarketplacePrompt('${promptId}')" class="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-[13px] font-medium rounded-lg shadow-lg shadow-purple-600/10 transition-all">Update Prompt</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        } catch (error) {
            console.error('Error loading prompt:', error);
            showAlertModal('ai-chatworks.com says', 'Error loading prompt: ' + error.message);
        }
    };

    window.updateMarketplacePrompt = async function (promptId) {
        const title = document.getElementById('edit-title').value;
        const category = document.getElementById('edit-category').value;
        const description = document.getElementById('edit-description').value;
        const content = document.getElementById('edit-content').value;
        const tier = document.querySelector('input[name="edit-tier"]:checked').value;
        const isActive = document.getElementById('edit-active').checked;

        try {
            const { error } = await supabase
                .from('marketplace_prompts')
                .update({
                    title,
                    category,
                    description,
                    content,
                    tier,
                    is_active: isActive,
                    updated_at: new Date().toISOString()
                })
                .eq('id', promptId);

            if (error) throw error;

            showAlertModal('ai-chatworks.com says', 'Prompt updated successfully!');
            document.getElementById('editPromptModal').remove();
            await loadMarketplaceData();
        } catch (error) {
            console.error('Error updating prompt:', error);
            showAlertModal('ai-chatworks.com says', 'Error updating prompt: ' + error.message);
        }
    };

    // ============================================
    // CREATE PROMPT MODAL
    // ============================================

    window.openCreatePromptModal = async function () {
        // Load categories first
        const categories = await getUniqueCategories();

        const modal = document.createElement('div');
        modal.id = 'promptModal';
        modal.className = 'fixed inset-0 z-40 flex items-center justify-center';
        modal.innerHTML = `
            <div class="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" onclick="this.parentElement.remove()"></div>
            
            <div class="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 transform transition-all overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                    <h3 class="text-[13px] font-semibold text-slate-800">New Prompt</h3>
                    <button onclick="this.closest('#promptModal').remove()" class="text-slate-400 hover:text-slate-600">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                </div>

                <div class="p-6 space-y-4">
                    <div class="grid grid-cols-2 gap-4">
                        <div>
                            <label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Prompt Name</label>
                            <input type="text" id="modal-upload-name" placeholder="e.g. SEO Writer" class="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-[13px]">
                        </div>
                        <div>
                            <div class="flex justify-between items-center mb-1">
                                <label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Category</label>
                                <button onclick="openCategoryModal()" class="text-[10px] text-blue-600 hover:text-blue-800 font-medium hover:underline">Manage</button>
                            </div>
                            <select id="modal-upload-category" class="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-[13px] text-slate-700">
                                ${categories.map(cat => `<option value="${cat}">${cat}</option>`).join('')}
                            </select>
                        </div>
                    </div>

                    <div class="grid grid-cols-2 gap-4">
                        <div>
                            <label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Created By</label>
                            <input type="email" id="modal-upload-email" value="${currentUser?.email || 'admin@example.com'}" class="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[13px] text-slate-500 cursor-not-allowed" readonly>
                        </div>
                        <div class="flex gap-4">
                            <div class="flex-1">
                                <label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Tier</label>
                                <div class="flex gap-3 mt-2">
                                    <label class="flex items-center gap-2 cursor-pointer">
                                        <input type="radio" name="modal-tier" value="free" checked class="text-blue-600 focus:ring-blue-500">
                                        <span class="text-[13px] text-slate-700">Free</span>
                                    </label>
                                    <label class="flex items-center gap-2 cursor-pointer">
                                        <input type="radio" name="modal-tier" value="pro" class="text-blue-600 focus:ring-blue-500">
                                        <span class="text-[13px] text-slate-700">Pro</span>
                                    </label>
                                </div>
                            </div>
                            <div class="flex-1">
                                <label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Status</label>
                                <label class="relative inline-flex items-center cursor-pointer mt-2">
                                    <input type="checkbox" id="modal-status" checked class="sr-only peer">
                                    <div class="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
                                    <span class="ml-2 text-[13px] font-medium text-gray-700">Active</span>
                                </label>
                            </div>
                        </div>
                    </div>

                    <div>
                        <label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Description</label>
                        <textarea id="modal-upload-description" rows="2" class="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-[13px] resize-none" placeholder="Short description..."></textarea>
                    </div>

                    <div>
                        <label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">System Prompt</label>
                        <textarea id="modal-upload-content" rows="6" class="w-full px-3 py-2 bg-slate-50 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-[13px] font-mono text-slate-600 resize-none" placeholder="You are a helpful assistant..."></textarea>
                        <p class="text-xs text-slate-400 mt-1 text-right">Markdown supported</p>
                    </div>
                </div>

                <div class="px-6 py-4 bg-gray-50 flex justify-end gap-3 border-t border-gray-100">
                    <button onclick="document.getElementById('promptModal').remove()" class="px-4 py-2 text-[13px] font-medium text-slate-600 hover:text-slate-800 transition-colors">Cancel</button>
                    <button onclick="uploadPromptFromModal()" class="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-[13px] font-medium rounded-lg shadow-lg shadow-purple-600/10 transition-all">Save Changes</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    };

    window.toggleModalCustomCategory = function () {
        const categorySelect = document.getElementById('modal-upload-category');
        const customGroup = document.getElementById('modal-custom-category-group');
        const customInput = document.getElementById('modal-custom-category-input');

        if (categorySelect.value === 'other') {
            customGroup.style.display = 'block';
            customInput.required = true;
        } else {
            customGroup.style.display = 'none';
            customInput.required = false;
            customInput.value = '';
        }
    };

    window.uploadPromptFromModal = async function () {
        const title = document.getElementById('modal-upload-name').value;
        let category = document.getElementById('modal-upload-category').value;
        const description = document.getElementById('modal-upload-description').value;
        const content = document.getElementById('modal-upload-content').value;
        const tier = document.querySelector('input[name="modal-tier"]:checked').value;
        const isActive = document.getElementById('modal-status').checked;

        // Use custom category if "other" is selected
        if (category === 'other') {
            const customCategory = document.getElementById('modal-custom-category-input').value.trim();
            if (!customCategory) {
                showAlertModal('ai-chatworks.com says', 'Please enter a custom category name');
                return;
            }
            category = customCategory;
        }

        try {
            const { error } = await supabase
                .from('marketplace_prompts')
                .insert({
                    title: title,
                    category: category,
                    description: description,
                    content: content,
                    tier: tier,
                    is_active: isActive,
                    user_id: currentUser.id
                });

            if (error) throw error;

            showAlertModal('ai-chatworks.com says', 'Prompt published successfully!');
            document.getElementById('promptModal').remove();
            loadMarketplaceData();
        } catch (error) {
            console.error('Upload error:', error);
            showAlertModal('ai-chatworks.com says', 'Error uploading prompt: ' + error.message);
        }
    };

    // ============================================
    // CUSTOM CONFIRMATION MODAL
    // ============================================

    window.showConfirmModal = function (title, message, warning, onConfirm) {
        const modal = document.createElement('div');
        modal.id = 'confirmModal';
        modal.className = 'fixed inset-0 z-[9999] flex items-center justify-center p-4';
        modal.innerHTML = `
            <div class="absolute inset-0 bg-black/20" onclick="document.getElementById('confirmModal').remove()"></div>
            
            <div class="relative bg-white rounded-2xl shadow-2xl w-full max-w-md transform transition-all">
                <div class="px-6 py-5">
                    <h3 class="text-[15px] font-semibold text-slate-900 mb-3">${title}</h3>
                    <p class="text-[13px] text-slate-700 leading-relaxed">${message}</p>
                    ${warning ? `<p class="text-[13px] text-slate-500 mt-3 leading-relaxed">${warning}</p>` : ''}
                </div>

                <div class="px-6 py-4 bg-gray-50 flex justify-end gap-3 border-t border-gray-100">
                    <button onclick="document.getElementById('confirmModal').remove()" 
                        class="px-6 py-2.5 text-[13px] font-medium text-slate-700 bg-gray-200 hover:bg-gray-300 rounded-full transition-colors">
                        Cancel
                    </button>
                    <button id="confirmModalOkBtn"
                        class="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-medium rounded-full transition-colors">
                        OK
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Add event listener to OK button
        document.getElementById('confirmModalOkBtn').addEventListener('click', () => {
            document.getElementById('confirmModal').remove();
            onConfirm();
        });
    };

    // ============================================
    // CUSTOM ALERT MODAL
    // ============================================

    window.showAlertModal = function (title, message) {
        const modal = document.createElement('div');
        modal.id = 'alertModal';
        modal.className = 'fixed inset-0 z-[9999] flex items-center justify-center p-4';
        modal.innerHTML = `
            <div class="absolute inset-0 bg-black/20" onclick="document.getElementById('alertModal').remove()"></div>
            
            <div class="relative bg-white rounded-2xl shadow-2xl w-full max-w-md transform transition-all">
                <div class="px-6 py-5">
                    <h3 class="text-[15px] font-semibold text-slate-900 mb-3">${title}</h3>
                    <p class="text-[13px] text-slate-700 leading-relaxed">${message}</p>
                </div>

                <div class="px-6 py-4 bg-gray-50 flex justify-end border-t border-gray-100">
                    <button onclick="document.getElementById('alertModal').remove()" 
                        class="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-medium rounded-full transition-colors">
                        OK
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    };

    // ============================================
    // DELETE MARKETPLACE PROMPT
    // ============================================

    window.deleteMarketplacePrompt = async function (promptId, promptName) {
        showConfirmModal(
            'ai-chatworks.com says',
            `Are you sure you want to delete "${promptName}"?`,
            'This action cannot be undone.',
            async () => {
                try {
                    const { error } = await supabase
                        .from('marketplace_prompts')
                        .delete()
                        .eq('id', promptId);

                    if (error) throw error;

                    showAlertModal('ai-chatworks.com says', 'Prompt deleted successfully!');
                    await loadMarketplaceData();
                } catch (error) {
                    console.error('Error deleting prompt:', error);
                    showAlertModal('ai-chatworks.com says', 'Error deleting prompt: ' + error.message);
                }
            }
        );
    };

    // ============================================
    // BULK DELETE PROMPTS
    // ============================================

    window.toggleAllPrompts = function (checked) {
        const checkboxes = document.querySelectorAll('.prompt-checkbox');
        checkboxes.forEach(cb => {
            cb.checked = checked;
        });
        updateBulkDeleteButton();
    };

    window.togglePromptSelection = function () {
        updateBulkDeleteButton();

        // Update "select all" checkbox state
        const checkboxes = document.querySelectorAll('.prompt-checkbox');
        const selectAllCheckbox = document.getElementById('select-all-prompts');
        const allChecked = Array.from(checkboxes).every(cb => cb.checked);
        const someChecked = Array.from(checkboxes).some(cb => cb.checked);

        if (selectAllCheckbox) {
            selectAllCheckbox.checked = allChecked;
            selectAllCheckbox.indeterminate = someChecked && !allChecked;
        }
    };

    function updateBulkDeleteButton() {
        const checkboxes = document.querySelectorAll('.prompt-checkbox:checked');
        const bulkDeleteContainer = document.getElementById('bulk-delete-container');
        const selectedCount = document.getElementById('selected-count');

        if (checkboxes.length > 0) {
            bulkDeleteContainer.classList.remove('hidden');
            selectedCount.textContent = checkboxes.length;
        } else {
            bulkDeleteContainer.classList.add('hidden');
        }
    }

    window.bulkDeletePrompts = async function () {
        const checkboxes = document.querySelectorAll('.prompt-checkbox:checked');
        const promptIds = Array.from(checkboxes).map(cb => cb.dataset.promptId);
        const count = promptIds.length;

        if (count === 0) return;

        showConfirmModal(
            'ai-chatworks.com says',
            `Are you sure you want to delete ${count} prompt(s)?`,
            'This action cannot be undone.',
            async () => {
                try {
                    const { error } = await supabase
                        .from('marketplace_prompts')
                        .delete()
                        .in('id', promptIds);

                    if (error) throw error;

                    showAlertModal('ai-chatworks.com says', `${count} prompt(s) deleted successfully!`);
                    await loadMarketplaceData();

                    // Reset select all checkbox
                    const selectAllCheckbox = document.getElementById('select-all-prompts');
                    if (selectAllCheckbox) selectAllCheckbox.checked = false;
                } catch (error) {
                    console.error('Error deleting prompts:', error);
                    showAlertModal('ai-chatworks.com says', 'Error deleting prompts: ' + error.message);
                }
            }
        );
    };

    // ============================================
    // BULK UPLOAD
    // ============================================

    window.openBulkUpload = function () {
        const modal = document.createElement('div');
        modal.id = 'bulkUploadModal';
        modal.className = 'fixed inset-0 z-40 flex items-center justify-center';
        modal.innerHTML = `
            <div class="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" onclick="document.getElementById('bulkUploadModal').remove()"></div>
            
            <div class="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 transform transition-all overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                    <h3 class="text-[13px] font-semibold text-slate-800">Bulk Upload Prompts</h3>
                    <button onclick="document.getElementById('bulkUploadModal').remove()" class="text-slate-400 hover:text-slate-600">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                </div>

                <div class="p-6 space-y-4">
                    <p class="text-[13px] text-slate-500">Upload a JSON file with multiple prompts. Expected format:</p>
                    <pre class="bg-slate-50 border border-gray-200 rounded-lg p-3 text-[11px] font-mono text-slate-600 overflow-x-auto">[
  {
    "title": "Prompt Name",
    "category": "Marketing",
    "description": "Short description",
    "content": "Act as an expert...",
    "tier": "free",
    "tags": ["tag1", "tag2"]
  }
]</pre>
                    
                    <div>
                        <label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-2">Select JSON File</label>
                        <input type="file" id="bulk-upload-file" accept=".json" class="block w-full text-[13px] text-slate-700 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-[13px] file:font-medium file:bg-purple-600 file:text-white hover:file:bg-slate-800 file:cursor-pointer cursor-pointer border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20">
                    </div>
                    
                    <div id="bulk-upload-status" class="text-[13px]"></div>
                </div>

                <div class="px-6 py-4 bg-gray-50 flex justify-end gap-3 border-t border-gray-100">
                    <button onclick="document.getElementById('bulkUploadModal').remove()" class="px-4 py-2 text-[13px] font-medium text-slate-600 hover:text-slate-800 transition-colors text-center">Cancel</button>
                    <button onclick="processBulkUpload()" class="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-[13px] font-medium rounded-lg shadow-lg shadow-purple-600/10 transition-all text-center">Upload Prompts</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    };

    window.processBulkUpload = async function () {
        const fileInput = document.getElementById('bulk-upload-file');
        const statusDiv = document.getElementById('bulk-upload-status');

        if (!fileInput.files || !fileInput.files[0]) {
            showAlertModal('ai-chatworks.com says', 'Please select a JSON file');
            return;
        }

        try {
            const file = fileInput.files[0];
            const text = await file.text();
            const prompts = JSON.parse(text);

            if (!Array.isArray(prompts)) {
                throw new Error('JSON file must contain an array of prompts');
            }

            statusDiv.innerHTML = '<p style="color: var(--accent-primary);">Uploading prompts...</p>';

            let successCount = 0;
            let errorCount = 0;
            const errors = [];

            for (let i = 0; i < prompts.length; i++) {
                const prompt = prompts[i];

                try {
                    // Validate required fields
                    if (!prompt.title || !prompt.content) {
                        throw new Error('Missing required fields: title and content');
                    }

                    // Normalize tier value to lowercase
                    let tier = (prompt.tier || 'free').toString().toLowerCase();
                    if (tier !== 'free' && tier !== 'pro') {
                        tier = 'free'; // Default to free if invalid
                    }

                    const { error } = await supabase
                        .from('marketplace_prompts')
                        .insert({
                            title: prompt.title,
                            category: prompt.category || 'Uncategorized',
                            description: prompt.description || '',
                            content: prompt.content,
                            tier: tier,
                            tags: prompt.tags || [],
                            user_id: currentUser.id
                        });

                    if (error) throw error;
                    successCount++;
                } catch (error) {
                    errorCount++;
                    errors.push(`Prompt ${i + 1} (${prompt.title || 'unnamed'}): ${error.message}`);
                }

                // Update progress
                statusDiv.innerHTML = `<p style="color: var(--accent-primary);">Progress: ${i + 1}/${prompts.length}</p>`;
            }

            // Show results
            let resultHTML = `
                <div style="margin-top: 16px;">
                    <p style="color: var(--success); font-weight: 600;">✓ ${successCount} prompts uploaded successfully</p>
            `;

            if (errorCount > 0) {
                resultHTML += `
                    <p style="color: var(--danger); font-weight: 600;">✗ ${errorCount} prompts failed</p>
                    <details style="margin-top: 8px;">
                        <summary style="cursor: pointer; color: var(--text-tertiary);">View errors</summary>
                        <ul style="margin-top: 8px; font-size: 12px; color: var(--danger);">
                            ${errors.map(err => `<li>${err}</li>`).join('')}
                        </ul>
                    </details>
                `;
            }

            resultHTML += '</div>';
            statusDiv.innerHTML = resultHTML;

            // Reload marketplace data
            await loadMarketplaceData();

        } catch (error) {
            console.error('Bulk upload error:', error);
            statusDiv.innerHTML = `<p style="color: var(--danger);">Error: ${error.message}</p>`;
        }
    };

    // ============================================
    // CATEGORY MANAGEMENT
    // ============================================

    async function getUniqueCategories() {
        try {
            const { data, error } = await supabase
                .from('marketplace_prompts')
                .select('category');

            if (error) throw error;

            const categories = [...new Set(data.map(p => p.category))].filter(Boolean).sort();

            // Add default categories if none exist
            if (categories.length === 0) {
                return ['Marketing', 'Coding', 'Business', 'Creative', 'Writing', 'Education'];
            }

            return categories;
        } catch (error) {
            console.error('Error loading categories:', error);
            return ['Marketing', 'Coding', 'Business', 'Creative', 'Writing', 'Education'];
        }
    }

    window.openCategoryModal = async function () {
        const categories = await getUniqueCategories();

        const modal = document.createElement('div');
        modal.id = 'categoryModal';
        modal.className = 'fixed inset-0 z-50 flex items-center justify-center';
        modal.innerHTML = `
            <div class="absolute inset-0 bg-black/20" onclick="document.getElementById('categoryModal').remove()"></div>
            
            <div class="relative bg-white rounded-xl shadow-2xl w-full max-w-sm mx-4 transform transition-all overflow-hidden">
                <div class="px-5 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                    <h3 class="text-[13px] font-semibold text-slate-800">Manage Categories</h3>
                    <button onclick="document.getElementById('categoryModal').remove()" class="text-slate-400 hover:text-slate-600">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                </div>

                <div class="p-5">
                    <div class="flex gap-2 mb-4">
                        <input type="text" id="newCategoryInput" placeholder="New category name" class="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-[13px]">
                        <button onclick="addCategoryToList()" class="bg-blue-500 hover:bg-blue-600 text-white px-3 py-2 rounded-lg text-xs font-medium transition-colors">Add</button>
                    </div>

                    <div class="space-y-2 max-h-48 overflow-y-auto pr-2" id="categoryList">
                        ${categories.map(cat => `
                            <div class="flex justify-between items-center p-2 hover:bg-gray-50 rounded border border-transparent hover:border-gray-100 group" data-category="${cat}">
                                <span class="text-[13px] text-slate-700 category-name">${cat}</span>
                                <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button onclick="editCategoryName('${cat.replace(/'/g, "\\'")}')\" class="text-slate-400 hover:text-blue-500 p-1" title="Rename">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
                                    </button>
                                    <button onclick="deleteCategoryFromList('${cat.replace(/'/g, "\\'")}')\" class="text-slate-400 hover:text-red-500 p-1" title="Delete">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"></path></svg>
                                    </button>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                
                <div class="px-5 py-3 bg-gray-50 text-right border-t border-gray-100">
                    <button onclick="closeCategoryModalAndRefresh()" class="text-xs font-medium text-slate-600 hover:text-slate-900">Done</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    };

    window.addCategoryToList = async function () {
        const input = document.getElementById('newCategoryInput');
        const newCategory = input.value.trim();

        if (!newCategory) {
            showAlertModal('ai-chatworks.com says', 'Please enter a category name');
            return;
        }

        const categories = await getUniqueCategories();
        if (categories.includes(newCategory)) {
            showAlertModal('ai-chatworks.com says', 'Category already exists');
            return;
        }

        try {
            // Use RPC function to bypass RLS
            const { data, error } = await supabase.rpc('admin_create_category_placeholder', {
                category_name: newCategory
            });

            if (error) {
                console.error('RPC error:', error);
                throw new Error(`Failed to create category: ${error.message}`);
            }

            input.value = '';

            // Refresh the category list
            const modal = document.getElementById('categoryModal');
            modal.remove();
            await openCategoryModal();

            alert(`Category "${newCategory}" added successfully!`);
        } catch (error) {
            console.error('Error adding category:', error);
            showAlertModal('ai-chatworks.com says', 'Error adding category: ' + error.message + '\n\nPlease ask your administrator to create the RPC function: admin_create_category_placeholder');
        }
    };

    window.deleteCategoryFromList = async function (categoryName) {
        showConfirmModal(
            'ai-chatworks.com says',
            `Delete category "${categoryName}"?`,
            'Note: This will not delete prompts using this category.',
            () => {
                // Note: We can't actually delete a category without affecting prompts
                // This is a limitation of not having a separate categories table
                showAlertModal('ai-chatworks.com says', 'To remove a category, you must first change all prompts using it to a different category.');
            }
        );
    };

    window.editCategoryName = async function (oldName) {
        const newName = prompt(`Rename category "${oldName}" to:`, oldName);

        if (!newName || newName.trim() === '') {
            return;
        }

        if (newName.trim() === oldName) {
            return; // No change
        }

        try {
            // Use RPC function to rename category
            const { data, error } = await supabase.rpc('admin_rename_category', {
                old_category: oldName,
                new_category: newName.trim()
            });

            if (error) {
                console.error('RPC error:', error);
                throw new Error(`Failed to rename category: ${error.message}`);
            }

            // Refresh the category list
            const modal = document.getElementById('categoryModal');
            modal.remove();
            await openCategoryModal();

            // Reload marketplace data to reflect changes
            await loadMarketplaceData();

            alert(`Category renamed from "${oldName}" to "${newName.trim()}" successfully!`);
        } catch (error) {
            console.error('Error renaming category:', error);
            showAlertModal('ai-chatworks.com says', 'Error renaming category: ' + error.message + '\n\nPlease ask your administrator to create the RPC function: admin_rename_category');
        }
    };

    window.closeCategoryModalAndRefresh = async function () {
        document.getElementById('categoryModal').remove();

        // Refresh the category dropdown in the prompt modal if it exists
        const categorySelect = document.getElementById('modal-upload-category');
        if (categorySelect) {
            const categories = await getUniqueCategories();
            categorySelect.innerHTML = categories.map(cat => `<option value="${cat}">${cat}</option>`).join('');
        }
    };

    // ============================================
    // SEARCH AND FILTER
    // ============================================

    async function populateFilterDropdowns() {
        const categoryDropdown = document.getElementById('category-dropdown');
        const categoryButton = document.getElementById('category-filter-button');

        if (categoryDropdown && allMarketplaceData.length > 0) {
            const categories = [...new Set(allMarketplaceData.map(p => p.category))].filter(Boolean).sort();

            // Build dropdown HTML
            let dropdownHTML = `
                <div class="py-1">
                    <button type="button" class="category-option w-full text-left px-3 py-2 text-[13px] hover:bg-purple-50 transition-colors ${activeFilters.category === '' ? 'bg-purple-100 text-purple-700' : 'text-slate-700'}" data-value="">
                        All Categories
                    </button>
            `;

            categories.forEach(cat => {
                const isSelected = activeFilters.category === cat;
                dropdownHTML += `
                    <button type="button" class="category-option w-full text-left px-3 py-2 text-[13px] hover:bg-purple-50 transition-colors ${isSelected ? 'bg-purple-100 text-purple-700' : 'text-slate-700'}" data-value="${cat}">
                        ${cat}
                    </button>
                `;
            });

            dropdownHTML += '</div>';
            categoryDropdown.innerHTML = dropdownHTML;

            // Add click handlers to options
            const options = categoryDropdown.querySelectorAll('.category-option');
            options.forEach(option => {
                option.addEventListener('click', function () {
                    const value = this.getAttribute('data-value');
                    const text = this.textContent.trim();

                    // Update button text
                    document.getElementById('category-filter-text').textContent = text;

                    // Update active filter
                    activeFilters.category = value;
                    applyMarketplaceFilters();

                    // Close dropdown
                    categoryDropdown.classList.add('hidden');
                    document.getElementById('category-filter-icon').style.transform = '';
                });
            });
        }
    }

    window.initializeMarketplaceFilters = function () {
        const searchInput = document.getElementById('marketplace-search');
        const categoryButton = document.getElementById('category-filter-button');
        const categoryDropdown = document.getElementById('category-dropdown');

        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                activeFilters.search = e.target.value.toLowerCase();
                applyMarketplaceFilters();
            });
        }

        if (categoryButton && categoryDropdown) {
            // Toggle dropdown on button click
            categoryButton.addEventListener('click', (e) => {
                e.stopPropagation();
                const isHidden = categoryDropdown.classList.contains('hidden');
                const icon = document.getElementById('category-filter-icon');

                if (isHidden) {
                    categoryDropdown.classList.remove('hidden');
                    icon.style.transform = 'rotate(180deg)';
                } else {
                    categoryDropdown.classList.add('hidden');
                    icon.style.transform = '';
                }
            });

            // Close dropdown when clicking outside
            document.addEventListener('click', (e) => {
                if (!categoryButton.contains(e.target) && !categoryDropdown.contains(e.target)) {
                    categoryDropdown.classList.add('hidden');
                    document.getElementById('category-filter-icon').style.transform = '';
                }
            });
        }
    };

    function applyMarketplaceFilters() {
        let filteredData = [...allMarketplaceData];

        // Apply search filter
        if (activeFilters.search) {
            filteredData = filteredData.filter(prompt =>
                prompt.prompt_name.toLowerCase().includes(activeFilters.search)
            );
        }

        // Apply category filter
        if (activeFilters.category) {
            filteredData = filteredData.filter(prompt =>
                prompt.category === activeFilters.category
            );
        }

        // Apply tier filter
        if (activeFilters.tier) {
            filteredData = filteredData.filter(prompt =>
                prompt.tier === activeFilters.tier
            );
        }

        // Apply status filter
        if (activeFilters.status) {
            const isActive = activeFilters.status === 'active';
            filteredData = filteredData.filter(prompt =>
                prompt.is_active === isActive
            );
        }

        // Render filtered data
        renderMarketplaceTable(filteredData);
    }

    function renderMarketplaceTable(data) {
        const tbody = document.getElementById('marketplace-table-body');

        if (!data || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-[13px] text-slate-400">No prompts match your filters</td></tr>';
            return;
        }

        let html = '';
        data.forEach(prompt => {
            // Tier badge styling
            const tierBadge = prompt.tier === 'pro'
                ? '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200/50 tracking-wide">PRO</span>'
                : '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500 border border-slate-200 tracking-wide">FREE</span>';

            // Status indicator with animation
            const statusIndicator = prompt.is_active
                ? `<div class="flex items-center h-full gap-2">
                     <span class="relative flex h-2 w-2">
                       <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                       <span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                     </span>
                     <span class="text-[11px] font-medium text-slate-600">Active</span>
                   </div>`
                : `<div class="flex items-center h-full gap-2">
                     <span class="relative inline-flex rounded-full h-2 w-2 bg-slate-300"></span>
                     <span class="text-[11px] font-medium text-slate-400">Inactive</span>
                   </div>`;

            // Category badge
            const categoryBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600 border border-slate-200">${prompt.category}</span>`;

            html += `
                <tr class="group hover:bg-blue-50/30 transition-colors duration-200">
                    <td class="px-4 py-3 align-middle">
                        <input type="checkbox" class="prompt-checkbox w-4 h-4 text-purple-600 border-gray-300 rounded focus:ring-purple-500 cursor-pointer" 
                            data-prompt-id="${prompt.prompt_id}" 
                            onchange="togglePromptSelection()">
                    </td>
                    <td class="px-4 py-3 align-middle">
                        <div class="flex items-center h-full text-xs font-medium text-slate-700">${prompt.prompt_name}</div>
                    </td>
                    <td class="px-4 py-3 align-middle">
                        <div class="flex items-center h-full">${categoryBadge}</div>
                    </td>
                    <td class="px-4 py-3 align-middle">
                        <div class="flex items-center h-full text-xs text-slate-500">${prompt.uploader_email || 'Unknown'}</div>
                    </td>
                    <td class="px-4 py-3 align-middle">
                        <div class="flex items-center justify-center h-full text-xs font-medium text-slate-600">${prompt.downloads_count || 0}</div>
                    </td>
                    <td class="px-4 py-3 align-middle">
                        <div class="flex items-center justify-center h-full">${tierBadge}</div>
                    </td>
                    <td class="px-4 py-3 align-middle">
                        ${statusIndicator}
                    </td>
                    <td class="px-4 py-3 align-middle text-right">
                        <div class="action-buttons opacity-0 group-hover:opacity-100 transition-all duration-200 flex justify-end gap-2">
                            <button onclick="editMarketplacePrompt('${prompt.prompt_id}')" class="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
                            </button>
                            <button onclick="deleteMarketplacePrompt('${prompt.prompt_id}', '${prompt.prompt_name.replace(/'/g, "\\'")}')" class="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        });

        tbody.innerHTML = html;
    }

    window.clearMarketplaceFilters = function () {
        activeFilters = {
            search: '',
            category: '',
            tier: '',
            status: ''
        };

        const searchInput = document.getElementById('marketplace-search');
        const categoryFilterText = document.getElementById('category-filter-text');

        if (searchInput) searchInput.value = '';
        if (categoryFilterText) categoryFilterText.textContent = 'All Categories';

        renderMarketplaceTable(allMarketplaceData);
    };

})();
