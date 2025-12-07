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
                loadMonthlyEngagement()
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
        const container = document.getElementById('marketplace-table-container');

        try {
            const { data, error } = await supabase.rpc('admin_get_marketplace_prompts');

            if (error) {
                console.error('Marketplace RPC error:', error);
                throw error;
            }

            if (!data || data.length === 0) {
                container.innerHTML = '<p style="padding: 20px; text-align: center; color: var(--text-tertiary);">No marketplace prompts yet. Upload your first prompt!</p>';
                return;
            }

            let html = `
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Prompt Name</th>
                            <th>Category</th>
                            <th>Downloads</th>
                            <th>Tier</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
            `;

            data.forEach(prompt => {
                const tierBadgeClass = prompt.tier === 'pro' ? 'badge-pro-gold' : 'badge-free';
                const statusBadge = prompt.is_active ?
                    '<span class="badge" style="background: rgba(16, 185, 129, 0.1); color: #10b981;">ACTIVE</span>' :
                    '<span class="badge" style="background: rgba(107, 114, 128, 0.1); color: #6b7280;">INACTIVE</span>';

                html += `
                    <tr>
                        <td>
                            <strong>${prompt.prompt_name}</strong><br>
                            <span style="color:var(--text-tertiary); font-size:12px;">by ${prompt.uploader_email || 'Unknown'}</span>
                        </td>
                        <td>${prompt.category}</td>
                        <td>${prompt.downloads}</td>
                        <td><span class="badge ${tierBadgeClass}">${prompt.tier.toUpperCase()}</span></td>
                        <td>${statusBadge}</td>
                    </tr>
                `;
            });

            html += '</tbody></table>';
            container.innerHTML = html;

            // Load categories for upload form
            await loadCategories();
        } catch (error) {
            console.error('Error loading marketplace:', error);
            container.innerHTML = `<p style="padding: 20px; text-align: center; color: var(--danger);">Error: ${error.message}</p>`;
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
                alert('Please enter a custom category name');
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

            alert('Prompt published successfully!');
            document.getElementById('marketplace-upload-form').reset();
            document.getElementById('custom-category-group').style.display = 'none';
            loadMarketplaceData();
        } catch (error) {
            console.error('Upload error:', error);
            alert('Error uploading prompt: ' + error.message);
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
        await loadOverviewData();
        alert('Overview data refreshed!');
    };

    window.refreshMarketplace = async function () {
        console.log('Refreshing marketplace data...');
        await loadMarketplaceData();
        alert('Marketplace data refreshed!');
    };

})();
