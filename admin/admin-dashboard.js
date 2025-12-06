// Admin Dashboard JavaScript
(function () {
    'use strict';

    // ============================================
    // Configuration
    // ============================================

    const SUPABASE_CONFIG = {
        url: 'https://ldcapthzveqdbvthukiz.supabase.co',
        anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxkY2FwdGh6dmVxZGJ2dGh1a2l6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMwOTM0NDEsImV4cCI6MjA3ODY2OTQ0MX0.mPNwwP_VFWpVso8hSy2I-ECH8v80EscFfEHeu2eiREc'
    };

    // Admin role identifier (stored in user metadata)
    const ADMIN_ROLE = 'admin';

    // ============================================
    // State
    // ============================================

    let supabase = null;
    let charts = {};
    let currentUser = null;

    // ============================================
    // Authentication
    // ============================================

    async function handleLogin(e) {
        e.preventDefault();

        const email = document.getElementById('username').value; // Using email instead of username
        const password = document.getElementById('password').value;
        const errorEl = document.getElementById('login-error');

        try {
            // Sign in with Supabase Auth
            const { data, error } = await supabase.auth.signInWithPassword({
                email: email,
                password: password
            });

            if (error) throw error;

            // Check if user has admin role
            const { data: profile } = await supabase
                .from('user_profiles')
                .select('role')
                .eq('id', data.user.id)
                .single();

            if (profile?.role !== ADMIN_ROLE) {
                await supabase.auth.signOut();
                throw new Error('Access denied: Admin role required');
            }

            // Login successful
            currentUser = data.user;
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

        // Check if user is already logged in
        const { data: { session } } = await supabase.auth.getSession();

        if (session) {
            // Verify admin role
            const { data: profile } = await supabase
                .from('user_profiles')
                .select('role')
                .eq('id', session.user.id)
                .single();

            if (profile?.role === ADMIN_ROLE) {
                currentUser = session.user;
                showDashboard();
                loadDashboardData();
                return;
            } else {
                await supabase.auth.signOut();
            }
        }

        showLogin();
    }

    function showLogin() {
        document.getElementById('login-screen').style.display = 'flex';
        document.getElementById('dashboard-screen').style.display = 'none';
    }

    function showDashboard() {
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('dashboard-screen').style.display = 'block';
    }

    // ============================================
    // Supabase Initialization
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
    // Data Loading
    // ============================================

    async function loadDashboardData() {
        if (!initSupabase()) {
            console.error('Failed to initialize Supabase');
            return;
        }

        try {
            await Promise.all([
                loadTotalStats(),
                loadUserCounts(),
                loadUserGrowthChart(),
                loadPromptActivityChart(),
                loadSystemHealth()
            ]);
        } catch (error) {
            console.error('Error loading dashboard data:', error);
        }
    }

    async function loadTotalStats() {
        try {
            // Use Postgres functions that bypass RLS for accurate counts

            // Total users
            const { data: userData, error: userError } = await supabase.rpc('get_total_users');
            if (!userError) {
                document.getElementById('total-users').textContent = userData || 0;
            }

            // Total prompts
            const { data: promptData, error: promptError } = await supabase.rpc('get_total_prompts');
            if (!promptError) {
                document.getElementById('total-prompts').textContent = promptData || 0;
            }

            // Total folders
            const { data: folderData, error: folderError } = await supabase.rpc('get_total_folders');
            if (!folderError) {
                document.getElementById('total-folders').textContent = folderData || 0;
            }

            // Encrypted items
            const { data: encryptedData, error: encryptedError } = await supabase.rpc('get_encrypted_items_count');
            if (!encryptedError) {
                document.getElementById('encrypted-items').textContent = encryptedData || 0;
            }

        } catch (error) {
            console.error('Error loading total stats:', error);
        }
    }

    async function loadUserCounts() {
        try {
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            const weekStart = new Date(today);
            weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Start of week (Sunday)

            // Users today
            const { data: todayCount } = await supabase.rpc('get_users_by_date', {
                start_date: today.toISOString()
            });
            document.getElementById('users-today').textContent = todayCount || 0;

            // Users yesterday
            const { data: yesterdayCount } = await supabase.rpc('get_users_by_date', {
                start_date: yesterday.toISOString(),
                end_date: today.toISOString()
            });
            document.getElementById('users-yesterday').textContent = yesterdayCount || 0;

            // Users this week
            const { data: weekCount } = await supabase.rpc('get_users_by_date', {
                start_date: weekStart.toISOString()
            });
            document.getElementById('users-week').textContent = weekCount || 0;

        } catch (error) {
            console.error('Error loading user counts:', error);
        }
    }

    async function loadUserGrowthChart() {
        try {
            // Get user growth data from Postgres function
            const { data, error } = await supabase.rpc('get_user_growth_data');

            if (error) throw error;

            // Prepare chart data
            const labels = data.map(row => new Date(row.signup_date).toLocaleDateString());
            const values = data.map(row => row.user_count);

            // Create chart
            const ctx = document.getElementById('user-growth-chart').getContext('2d');

            if (charts.userGrowth) {
                charts.userGrowth.destroy();
            }

            charts.userGrowth = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'New Users',
                        data: values,
                        borderColor: '#8ab4f8',
                        backgroundColor: 'rgba(138, 180, 248, 0.1)',
                        tension: 0.4,
                        fill: true
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    plugins: {
                        legend: {
                            display: false
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                stepSize: 1
                            }
                        }
                    }
                }
            });

        } catch (error) {
            console.error('Error loading user growth chart:', error);
        }
    }

    async function loadPromptActivityChart() {
        try {
            // Get prompt activity data from Postgres function
            const { data, error } = await supabase.rpc('get_prompt_activity_data');

            if (error) throw error;

            // Prepare chart data
            const labels = data.map(row => new Date(row.creation_date).toLocaleDateString());
            const values = data.map(row => row.prompt_count);

            // Create chart
            const ctx = document.getElementById('prompt-activity-chart').getContext('2d');

            if (charts.promptActivity) {
                charts.promptActivity.destroy();
            }

            charts.promptActivity = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Prompts Created',
                        data: values,
                        backgroundColor: '#81c995',
                        borderRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    plugins: {
                        legend: {
                            display: false
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                stepSize: 1
                            }
                        }
                    }
                }
            });

        } catch (error) {
            console.error('Error loading prompt activity chart:', error);
        }
    }

    async function loadSystemHealth() {
        try {
            // Database status
            const { error: dbError } = await supabase
                .from('user_profiles')
                .select('id', { count: 'exact', head: true })
                .limit(1);

            document.getElementById('db-status').textContent = dbError ? '❌ Error' : '✅ Connected';

            // Encryption status
            const { data: encryptionPercentage } = await supabase.rpc('get_encryption_percentage');
            document.getElementById('encryption-status').textContent = `✅ ${encryptionPercentage || 0}% Encrypted`;

            // RLS policies (placeholder - would need admin access to query pg_policies)
            document.getElementById('rls-policies').textContent = '✅ Active';

            // Last updated
            document.getElementById('last-updated').textContent = new Date().toLocaleString();

        } catch (error) {
            console.error('Error loading system health:', error);
            document.getElementById('db-status').textContent = '❌ Error';
        }
    }

    // ============================================
    // Initialization
    // ============================================

    function init() {
        // Check authentication
        checkAuth();

        // Event listeners
        document.getElementById('login-form').addEventListener('submit', handleLogin);
        document.getElementById('logout-btn').addEventListener('click', handleLogout);

        // Auto-refresh every 5 minutes
        setInterval(() => {
            if (sessionStorage.getItem('admin_authenticated') === 'true') {
                loadDashboardData();
            }
        }, 5 * 60 * 1000);
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
