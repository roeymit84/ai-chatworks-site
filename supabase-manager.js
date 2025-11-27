// supabase-manager.js - Local-First Cloud Sync Manager
// ============================================================================
// This manager handles cloud backup and synchronization with Supabase
// Key Principle: LOCAL FIRST - all operations save locally first, then sync
// ============================================================================
(function () {
    'use strict';

    class SupabaseManager {
        constructor() {
            this.supabase = null;
            this.currentUser = null;
            this.isOnline = navigator.onLine;
            this.autoSyncInterval = null;
            this.lastSyncTime = null;

            // Auto-sync every 8 hours for settings/avatar backup (prompts/folders sync live)
            this.AUTO_SYNC_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours

            // Track sync status
            this.isSyncing = false;
            this.syncQueue = {
                folders: new Set(),
                prompts: new Set()
            };

            // Retry queue for failed syncs (max 100 items to prevent memory issues)
            this.retryQueue = [];
            this.MAX_RETRY_QUEUE_SIZE = 100;
            this.MAX_RETRIES_PER_ITEM = 3;

            // Leader election for multi-tab sync coordination
            // Only the leader tab performs cloud syncs to prevent sync storms
            this.tabId = `tab_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            this.isLeader = false;
            this.leaderCheckInterval = null;
            this.leaderReady = false; // Track if leader election completed
            this.LEADER_HEARTBEAT_INTERVAL = 5000; // Check every 5 seconds
            this.LEADER_TIMEOUT = 15000; // Consider leader dead after 15 seconds

            // Track pending settings sync for offline support
            this.pendingSettingsSync = false;

            // PERFORMANCE FIX: Debounce realtime UI updates to prevent update storm
            // When multiple realtime events arrive rapidly (batch upload), only refresh UI once
            this.realtimeRefreshTimer = null;
            this.REALTIME_REFRESH_DEBOUNCE_MS = 300; // Wait 300ms after last update before refreshing

            // Listen for online/offline events
            window.addEventListener('online', () => {
                console.log('AI ChatWorks: Back online, resuming sync');
                this.isOnline = true;
                if (this.isLeader) {
                    this.performAutoSync();
                }
                // Sync pending settings changes made while offline
                if (this.pendingSettingsSync && this.currentUser) {
                    console.log('AI ChatWorks: Syncing pending settings changes...');
                    this.syncPendingSettings();
                }
            });

            window.addEventListener('offline', () => {
                console.log('AI ChatWorks: Offline, will sync when reconnected');
                this.isOnline = false;
            });

            // Release leadership when tab closes
            window.addEventListener('beforeunload', () => {
                try {
                    this.releaseLeadership();
                } catch (error) {
                    // Silently ignore - extension context may be invalidated during unload
                    // This is expected behavior and not an error
                }
            });

            // Close WebSocket connections when browser/computer sleeps
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    // Browser tab hidden or computer sleeping
                    console.log('AI ChatWorks: Browser hidden, closing realtime connections');
                    this.unsubscribeFromRealtimeChanges();
                } else {
                    // Browser tab visible again
                    console.log('AI ChatWorks: Browser visible, reconnecting realtime');
                    if (this.currentUser) {
                        this.subscribeToRealtimeChanges();
                    }
                }
            });
        }

        /**
         * Initialize Supabase connection
         * @returns {Object} Initialization result with mode and user info
         */
        async init() {
            try {
                const config = window.AI_ChatWorks_SupabaseConfig;

                // Check if cloud sync is enabled
                if (!config || !config.enableCloudSync) {
                    console.log('AI ChatWorks: Cloud sync disabled, running in local-only mode');
                    return { mode: 'local-only', user: null };
                }

                // Validate configuration
                if (!config.url || !config.anonKey) {
                    console.warn('AI ChatWorks: Supabase credentials missing, running in local-only mode');
                    return { mode: 'local-only', user: null };
                }

                // Initialize Supabase client
                if (typeof window.supabase === 'undefined') {
                    console.error('AI ChatWorks: Supabase SDK not loaded');
                    return { mode: 'local-only', user: null };
                }

                // Initialize Supabase client with optimized Realtime settings
                this.supabase = window.supabase.createClient(config.url, config.anonKey, {
                    realtime: {
                        params: {
                            eventsPerSecond: 10  // Limit events to prevent spam
                        },
                        // Heartbeat interval (default is 30s, we increase to 60s to reduce traffic)
                        heartbeatIntervalMs: 60000,
                        // Timeout for connection (default is 10s)
                        timeout: 10000
                    },
                    auth: {
                        persistSession: true,
                        autoRefreshToken: true,
                        detectSessionInUrl: false
                    }
                });

                // CRITICAL: Perform leader election BEFORE checking session
                // This ensures leader is elected before any sync operations
                await this.initLeaderElection();

                // Check for existing session
                const { data: { session }, error } = await this.supabase.auth.getSession();

                if (error) {
                    console.warn('AI ChatWorks: Session check failed:', error.message);

                    // Handle invalid refresh token error - clear the bad session
                    if (error.message && error.message.includes('Invalid Refresh Token')) {
                        console.log('AI ChatWorks: Clearing invalid refresh token from storage');
                        try {
                            await this.supabase.auth.signOut({ scope: 'local' });
                        } catch (signOutError) {
                            console.warn('AI ChatWorks: Failed to clear invalid session:', signOutError);
                        }
                    }

                    return { mode: 'cloud', user: null };
                }

                if (session) {
                    this.currentUser = session.user;
                    console.log('AI ChatWorks: User session restored:', session.user.email);

                    // Subscribe to realtime changes
                    this.subscribeToRealtimeChanges();

                    // PERFORMANCE FIX: Skip initial sync on additional tabs
                    // Check if local data exists - if yes, skip downloading from cloud
                    // Rationale: chrome.storage.local is shared across tabs, so additional tabs
                    // already have the data. Realtime subscriptions keep everything synchronized.
                    // This prevents 19 REST calls when opening additional tabs.
                    const dbManager = window.AI_ChatWorks_IndexedDBManager;
                    let shouldSync = true;

                    if (dbManager) {
                        const localPrompts = await dbManager.getAll('prompts');
                        const localFolders = await dbManager.getAll('folders');
                        const hasLocalData = localPrompts.length > 0 || localFolders.length > 0;

                        if (hasLocalData) {
                            console.log('AI ChatWorks: Local data exists, skipping initial sync (additional tab optimization)');
                            shouldSync = false;
                        }
                    }

                    if (shouldSync) {
                        console.log('AI ChatWorks: Performing initial sync for restored session...');
                        try {
                            const result = await this.performInitialSync();
                            if (result.success) {
                                const downloaded = (result.downloadedFolders || 0) + (result.downloadedPrompts || 0);
                                if (downloaded > 0) {
                                    console.log(`AI ChatWorks: Downloaded ${result.downloadedFolders} folders and ${result.downloadedPrompts} prompts from cloud`);
                                }
                            }
                        } catch (err) {
                            console.warn('AI ChatWorks: Initial sync failed for restored session:', err);
                        }
                    }

                    // Always load settings (lightweight operation)
                    try {
                        await this.loadAndApplyCloudSettings();
                        console.log('AI ChatWorks: Settings loaded');
                    } catch (err) {
                        console.warn('AI ChatWorks: Failed to load settings:', err);
                    }

                    return { mode: 'cloud', user: session.user };
                }

                console.log('AI ChatWorks: Supabase ready (not authenticated)');
                return { mode: 'cloud', user: null };

            } catch (error) {
                console.error('AI ChatWorks: Supabase initialization failed:', error);
                return { mode: 'local-only', user: null, error: error.message };
            }
        }

        // ============================================================================
        // SYNC METADATA MANAGEMENT
        // Tracks sync state to handle edge cases: multiple devices, sign-out/sign-in,
        // partial uploads, and prevents data loss
        // ============================================================================

        /**
         * Get sync metadata from local storage
         * @returns {Promise<Object>} Sync metadata
         */
        async getSyncMetadata() {
            const CONSTANTS = window.AI_ChatWorks_Constants;
            if (!CONSTANTS) return null;

            const result = await chrome.storage.local.get([
                CONSTANTS.STORAGE_KEYS.LAST_SYNC_ACTION,
                CONSTANTS.STORAGE_KEYS.LAST_SYNC_TIMESTAMP,
                CONSTANTS.STORAGE_KEYS.OFFLINE_WORK_PENDING
            ]);

            return {
                lastAction: result[CONSTANTS.STORAGE_KEYS.LAST_SYNC_ACTION] || 'never',
                lastTimestamp: result[CONSTANTS.STORAGE_KEYS.LAST_SYNC_TIMESTAMP] || null,
                offlineWorkPending: result[CONSTANTS.STORAGE_KEYS.OFFLINE_WORK_PENDING] || false
            };
        }

        /**
         * Set sync metadata in local storage
         * @param {Object} metadata - Sync metadata to save
         */
        async setSyncMetadata(metadata) {
            const CONSTANTS = window.AI_ChatWorks_Constants;
            if (!CONSTANTS) return;

            const toSave = {};
            if (metadata.lastAction) {
                toSave[CONSTANTS.STORAGE_KEYS.LAST_SYNC_ACTION] = metadata.lastAction;
            }
            if (metadata.lastTimestamp) {
                toSave[CONSTANTS.STORAGE_KEYS.LAST_SYNC_TIMESTAMP] = metadata.lastTimestamp;
            }
            if (metadata.offlineWorkPending !== undefined) {
                toSave[CONSTANTS.STORAGE_KEYS.OFFLINE_WORK_PENDING] = metadata.offlineWorkPending;
            }

            await chrome.storage.local.set(toSave);
            console.log('AI ChatWorks: Sync metadata updated:', metadata);
        }

        /**
         * Mark that user has offline work that needs to be uploaded
         * Called when user creates/edits data while offline or after sign-out
         */
        async markOfflineWorkPending() {
            await this.setSyncMetadata({
                offlineWorkPending: true,
                lastTimestamp: new Date().toISOString()
            });
        }

        /**
         * Clear offline work pending flag after successful upload
         */
        async clearOfflineWorkPending() {
            await this.setSyncMetadata({ offlineWorkPending: false });
        }

        /**
         * Check if user has local data that might conflict with cloud
         * @returns {Promise<Object>} Conflict detection result
         */
        async detectPotentialConflicts() {
            const dbManager = window.AI_ChatWorks_IndexedDBManager;
            if (!dbManager) return { hasConflicts: false };

            const metadata = await this.getSyncMetadata();

            // Get counts of local data
            const localFolders = await dbManager.getAll('folders');
            const localPrompts = await dbManager.getAll('prompts');
            const userPrompts = localPrompts.filter(p => !p.id?.startsWith('default-'));

            const hasLocalData = localFolders.length > 0 || userPrompts.length > 0;

            // Conflict scenarios:
            // 1. User signed out and created data offline
            // 2. Offline work pending flag is set
            // 3. Never synced but has data (multiple device scenario)
            const hasConflicts = hasLocalData && (
                metadata.lastAction === 'sign-out' ||
                metadata.offlineWorkPending ||
                metadata.lastAction === 'never'
            );

            return {
                hasConflicts,
                localFolderCount: localFolders.length,
                localPromptCount: userPrompts.length,
                metadata
            };
        }

        /**
         * Smart merge: Compare local and cloud data, upload missing local items,
         * download missing cloud items, and resolve conflicts by timestamp
         * @param {string} strategy - Merge strategy: 'auto' (newer wins), 'keep-local', 'keep-cloud'
         * @returns {Promise<Object>} Merge result with counts
         */
        async performSmartMerge(strategy = 'auto') {
            try {
                console.log(`AI ChatWorks: Starting smart merge (strategy: ${strategy})...`);

                const dbManager = window.AI_ChatWorks_IndexedDBManager;
                if (!dbManager) {
                    throw new Error('IndexedDB not available');
                }

                let foldersUploaded = 0;
                let foldersDownloaded = 0;
                let promptsUploaded = 0;
                let promptsDownloaded = 0;
                let conflictsResolved = 0;

                // STEP 1: Merge Folders
                const localFolders = await dbManager.getAll('folders');
                const { data: cloudFolders } = await this.supabase
                    .from('folders')
                    .select('*')
                    .order('updated_at', { ascending: false });

                // Create maps by ID for quick lookup
                const localFolderMap = new Map(localFolders.map(f => [f.id, f]));
                const cloudFolderMap = new Map((cloudFolders || []).map(f => [f.id, f]));

                // OPTIMIZATION: Collect folders to upload in batches instead of individual calls
                const foldersToUpload = [];

                // Upload folders that exist locally but not in cloud
                for (const [id, localFolder] of localFolderMap) {
                    if (!cloudFolderMap.has(id)) {
                        foldersToUpload.push(this.localToCloudFolder(localFolder));
                        foldersUploaded++;
                    } else if (strategy === 'auto') {
                        // Conflict: exists in both - compare timestamps
                        const cloudFolder = cloudFolderMap.get(id);
                        const localTime = new Date(localFolder.updated_at || localFolder.created_at).getTime();
                        const cloudTime = new Date(cloudFolder.updated_at || cloudFolder.created_at).getTime();

                        if (localTime > cloudTime) {
                            // Local is newer - upload
                            foldersToUpload.push(this.localToCloudFolder(localFolder));
                            conflictsResolved++;
                        }
                        // If cloud is newer, we'll download it in the next step
                    }
                }

                // BATCH UPLOAD: Upload all folders in one request (N calls → 1 call)
                if (foldersToUpload.length > 0) {
                    console.log(`AI ChatWorks: Batch uploading ${foldersToUpload.length} folders...`);
                    await this.batchUpsertFolders(foldersToUpload);
                }

                // Download folders that exist in cloud but not locally
                for (const [id, cloudFolder] of cloudFolderMap) {
                    if (!localFolderMap.has(id)) {
                        await dbManager.put('folders', this.cloudToLocalFolder(cloudFolder), { fromRealtime: true });
                        foldersDownloaded++;
                    } else if (strategy === 'auto') {
                        // Conflict: check if cloud is newer
                        const localFolder = localFolderMap.get(id);
                        const localTime = new Date(localFolder.updated_at || localFolder.created_at).getTime();
                        const cloudTime = new Date(cloudFolder.updated_at || cloudFolder.created_at).getTime();

                        if (cloudTime > localTime) {
                            // Cloud is newer - download
                            await dbManager.put('folders', this.cloudToLocalFolder(cloudFolder), { fromRealtime: true });
                            conflictsResolved++;
                        }
                    }
                }

                // STEP 2: Merge Prompts
                const localPrompts = await dbManager.getAll('prompts');
                const userPrompts = localPrompts.filter(p => !p.id?.startsWith('default-'));

                const { data: cloudPrompts } = await this.supabase
                    .from('prompts')
                    .select('*')
                    .order('updated_at', { ascending: false });

                const localPromptMap = new Map(userPrompts.map(p => [p.id, p]));
                const cloudPromptMap = new Map((cloudPrompts || []).map(p => [p.id, p]));

                // OPTIMIZATION: Collect prompts to upload in batches instead of individual calls
                const promptsToUpload = [];

                // Upload prompts that exist locally but not in cloud
                for (const [id, localPrompt] of localPromptMap) {
                    if (!cloudPromptMap.has(id)) {
                        promptsToUpload.push(this.localToCloudPrompt(localPrompt));
                        promptsUploaded++;
                    } else if (strategy === 'auto') {
                        // Conflict: exists in both - compare timestamps
                        const cloudPrompt = cloudPromptMap.get(id);
                        const localTime = new Date(localPrompt.updated_at || localPrompt.created_at).getTime();
                        const cloudTime = new Date(cloudPrompt.updated_at || cloudPrompt.created_at).getTime();

                        if (localTime > cloudTime) {
                            // Local is newer - upload
                            promptsToUpload.push(this.localToCloudPrompt(localPrompt));
                            conflictsResolved++;
                        }
                    }
                }

                // BATCH UPLOAD: Upload all prompts in one request (N calls → 1 call)
                if (promptsToUpload.length > 0) {
                    console.log(`AI ChatWorks: Batch uploading ${promptsToUpload.length} prompts...`);
                    await this.batchUpsertPrompts(promptsToUpload);
                }

                // Download prompts that exist in cloud but not locally
                for (const [id, cloudPrompt] of cloudPromptMap) {
                    if (!localPromptMap.has(id)) {
                        await dbManager.put('prompts', this.cloudToLocalPrompt(cloudPrompt), { fromRealtime: true });
                        promptsDownloaded++;
                    } else if (strategy === 'auto') {
                        // Conflict: check if cloud is newer
                        const localPrompt = localPromptMap.get(id);
                        const localTime = new Date(localPrompt.updated_at || localPrompt.created_at).getTime();
                        const cloudTime = new Date(cloudPrompt.updated_at || cloudPrompt.created_at).getTime();

                        if (cloudTime > localTime) {
                            // Cloud is newer - download
                            await dbManager.put('prompts', this.cloudToLocalPrompt(cloudPrompt), { fromRealtime: true });
                            conflictsResolved++;
                        }
                    }
                }

                console.log(`AI ChatWorks: Smart merge completed - ${foldersUploaded}/${promptsUploaded} uploaded, ${foldersDownloaded}/${promptsDownloaded} downloaded, ${conflictsResolved} conflicts resolved`);

                return {
                    success: true,
                    foldersUploaded,
                    foldersDownloaded,
                    promptsUploaded,
                    promptsDownloaded,
                    conflictsResolved
                };

            } catch (error) {
                console.error('AI ChatWorks: Smart merge error:', error);
                return { success: false, error: error.message };
            }
        }

        /**
         * Sign in user
         * @param {string} email - User email
         * @param {string} password - User password
         * @returns {Object} Sign in result
         */
        async signIn(email, password) {
            try {
                if (!this.supabase) {
                    throw new Error('Supabase not initialized');
                }

                const { data, error } = await this.supabase.auth.signInWithPassword({
                    email,
                    password
                });

                if (error) throw error;

                this.currentUser = data.user;
                console.log('AI ChatWorks: User signed in:', data.user.email);
                console.log('AI ChatWorks: User metadata on sign-in:', data.user.user_metadata);

                // Ensure user profile exists (in case trigger didn't fire or user existed before trigger)
                // Pass user_metadata as fallback in case it contains first_name/last_name from signup
                const metadata = data.user.user_metadata || {};
                const profileCreated = await this.ensureUserProfile(metadata);
                if (!profileCreated) {
                    console.error('AI ChatWorks: Failed to ensure user profile - cloud sync may not work');
                    return {
                        success: false,
                        error: 'Failed to create user profile. Please run CLEANUP_DATABASE.sql in Supabase SQL Editor.'
                    };
                }

                // Subscribe to realtime changes
                this.subscribeToRealtimeChanges();

                // CRITICAL FIX: Perform initial sync and settings load in background
                // This allows the dialog to close immediately, preventing UI freeze
                console.log('AI ChatWorks: Starting background sync...');

                // Return success immediately so dialog can close
                const result = {
                    success: true,
                    user: data.user,
                    downloadedFolders: 0,
                    downloadedPrompts: 0
                };

                // Run sync in background (non-blocking)
                this.performBackgroundSyncAfterSignIn().catch(err => {
                    console.error('AI ChatWorks: Background sync failed:', err);
                });

                return result;

            } catch (error) {
                // SECURITY FIX: Don't log sensitive auth error details (wrong password/username) to console
                // Only log that sign-in failed, without exposing the specific error message
                console.warn('AI ChatWorks: Sign in failed');
                return { success: false, error: error.message };
            }
        }

        /**
         * Perform background sync after sign-in
         * This runs async without blocking the UI
         * @returns {Promise<Object>} Sync result
         */
        async performBackgroundSyncAfterSignIn() {
            try {
                this.isSyncing = true;
                console.log('AI ChatWorks: Background sync starting...');

                // CRITICAL: Check leadership for upload operations
                // Follower tabs should still DOWNLOAD data, but skip UPLOADS to prevent conflicts
                const isLeader = await this.verifyLeadershipForSync();

                const dbManager = window.AI_ChatWorks_IndexedDBManager;
                let uploadedFolders = 0;
                let uploadedPrompts = 0;

                if (!isLeader) {
                    // FOLLOWER TAB: Skip uploads but download from cloud if needed
                    console.log('AI ChatWorks: Follower tab - checking if sync needed...');

                    // PERFORMANCE FIX: Skip download if local data already exists
                    // chrome.storage.local is shared across tabs, so follower tabs
                    // already have data from leader tab
                    let shouldSync = true;
                    let syncResult = { success: true, downloadedFolders: 0, downloadedPrompts: 0 };

                    if (dbManager) {
                        const localPrompts = await dbManager.getAll('prompts');
                        const localFolders = await dbManager.getAll('folders');
                        const hasLocalData = localPrompts.length > 0 || localFolders.length > 0;

                        if (hasLocalData) {
                            console.log('AI ChatWorks: Follower tab - local data exists, skipping download (tab sync optimization)');
                            shouldSync = false;
                        }
                    }

                    if (shouldSync) {
                        console.log('AI ChatWorks: Follower tab - downloading cloud data...');
                        // Download existing data from cloud
                        // Skip UI refresh during sign-in - ui-components.js handles it with proper timing
                        syncResult = await this.performInitialSync(true);
                    }

                    // Always load settings (lightweight operation)
                    try {
                        await this.loadAndApplyCloudSettings(false);
                    } catch (settingsError) {
                        console.warn('AI ChatWorks: Settings load failed:', settingsError.message);
                    }

                    // Update last sync time
                    this.lastSyncTime = new Date().toISOString();

                    console.log(`AI ChatWorks: Follower sync completed - ${syncResult.downloadedFolders || 0} folders, ${syncResult.downloadedPrompts || 0} prompts downloaded`);

                    // Show notification only if data was actually downloaded
                    const downloaded = (syncResult.downloadedFolders || 0) + (syncResult.downloadedPrompts || 0);
                    if (syncResult.success && downloaded > 0) {
                        if (window.AI_ChatWorks_UserFeedbackManager) {
                            window.AI_ChatWorks_UserFeedbackManager.showToast(
                                `Cloud sync completed: ${syncResult.downloadedFolders || 0} folders and ${syncResult.downloadedPrompts || 0} prompts synced`,
                                'success'
                            );
                        }
                    }

                    this.isSyncing = false;

                    // Dispatch event to notify UI that sync is complete
                    window.dispatchEvent(new CustomEvent('ai-chatworks-sync-complete', {
                        detail: { timestamp: new Date().toISOString(), source: 'follower' }
                    }));

                    return {
                        success: true,
                        downloadedFolders: syncResult.downloadedFolders || 0,
                        downloadedPrompts: syncResult.downloadedPrompts || 0
                    };
                }

                // LEADER TAB: Full sync with uploads
                console.log('AI ChatWorks: Leader tab - performing full sync');

                // CRITICAL: Detect if this is a NEW account (empty cloud) or EXISTING account (has cloud data)
                // - NEW account: Upload local data to cloud first (preserve offline work)
                // - EXISTING account: Clear local data first (security - prevent User A's data leaking to User B)
                let isNewAccount = false;
                try {
                    // Check if cloud has any data for this user
                    // IMPORTANT: Don't use head:true as it returns null data even when rows exist
                    const { data: cloudFolders, error: foldersCheckError } = await this.supabase
                        .from('folders')
                        .select('id')
                        .limit(1);

                    const { data: cloudPrompts, error: promptsCheckError } = await this.supabase
                        .from('prompts')
                        .select('id')
                        .limit(1);

                    if (foldersCheckError) throw foldersCheckError;
                    if (promptsCheckError) throw promptsCheckError;

                    // If both folders and prompts are empty, this is likely a new account
                    isNewAccount = (!cloudFolders || cloudFolders.length === 0) &&
                        (!cloudPrompts || cloudPrompts.length === 0);

                    console.log(`AI ChatWorks: Account type detected - ${isNewAccount ? 'NEW (will upload local data)' : 'EXISTING (will clear local data)'}`);
                    console.log(`AI ChatWorks: Cloud has ${cloudFolders?.length || 0} folders, ${cloudPrompts?.length || 0} prompts(sampled)`);
                } catch (checkError) {
                    console.warn('AI ChatWorks: Could not check cloud data, assuming existing account:', checkError);
                    isNewAccount = false; // Default to existing account (safer for security)
                }

                if (isNewAccount) {
                    // NEW ACCOUNT: Upload local data to cloud first
                    if (dbManager) {
                        console.log('AI ChatWorks: New account detected - uploading local data to cloud...');
                        try {
                            // PERFORMANCE FIX: Batch upload all local folders in a single request
                            const localFolders = await dbManager.getAll('folders');
                            if (localFolders.length > 0) {
                                const cloudFolders = localFolders.map(folder => this.localToCloudFolder(folder));
                                await this.batchUpsertFolders(cloudFolders);
                                uploadedFolders = localFolders.length;
                                console.log(`AI ChatWorks: Batch uploaded ${uploadedFolders} folders to cloud in 1 request`);
                            }

                            // PERFORMANCE FIX: Batch upload all local prompts in a single request (except default demo prompts)
                            const localPrompts = await dbManager.getAll('prompts');
                            const userPrompts = localPrompts.filter(p => !p.id?.startsWith('default-'));
                            if (userPrompts.length > 0) {
                                const cloudPrompts = userPrompts.map(prompt => this.localToCloudPrompt(prompt));
                                await this.batchUpsertPrompts(cloudPrompts);
                                uploadedPrompts = userPrompts.length;
                                console.log(`AI ChatWorks: Batch uploaded ${uploadedPrompts} prompts to cloud in 1 request`);
                            }
                        } catch (uploadError) {
                            console.warn('AI ChatWorks: Error uploading local data to cloud:', uploadError);
                        }
                    }
                } else {
                    // EXISTING ACCOUNT: Check for conflicts (offline work, multiple devices, etc.)
                    const conflictInfo = await this.detectPotentialConflicts();

                    if (conflictInfo.hasConflicts) {
                        // User has local data that might conflict with cloud
                        console.log(`AI ChatWorks: Potential conflicts detected - ${conflictInfo.localFolderCount} folders, ${conflictInfo.localPromptCount} prompts`);
                        console.log('AI ChatWorks: Last sync action:', conflictInfo.metadata.lastAction);

                        // Use smart merge to resolve conflicts intelligently
                        // This preserves offline work while preventing data loss
                        const mergeResult = await this.performSmartMerge('auto');

                        if (mergeResult.success) {
                            uploadedFolders = mergeResult.foldersUploaded;
                            uploadedPrompts = mergeResult.promptsUploaded;
                            console.log(`AI ChatWorks: Smart merge completed - preserved ${uploadedPrompts} prompts and ${uploadedFolders} folders from offline work`);

                            // Clear offline work pending flag after successful merge
                            await this.clearOfflineWorkPending();
                        } else {
                            console.warn('AI ChatWorks: Smart merge failed, falling back to cloud download');
                        }
                    } else {
                        // No conflicts: Clear local data BEFORE downloading from cloud
                        // SECURITY: This prevents previous user's offline data from being uploaded to new user's account
                        if (dbManager) {
                            console.log('AI ChatWorks: No conflicts detected - clearing local data before sync (security measure)...');
                            try {
                                // PERFORMANCE FIX: Clear all data in ONE operation to prevent UI flickering
                                // Before: 26 individual deletes = 26 UI refreshes = flickering GUI
                                // After: 1 bulk clear = 1 UI refresh = smooth UX

                                const prompts = await dbManager.getAll('prompts');
                                const folders = await dbManager.getAll('folders');

                                // Keep only demo prompts, remove all user data
                                const demoPrompts = prompts.filter(p => p.id?.startsWith('default-'));

                                // Clear and replace with demo-only data in ONE storage operation
                                await chrome.storage.local.set({
                                    [dbManager.PROMPTS_KEY]: demoPrompts,
                                    [dbManager.FOLDERS_KEY]: [] // Clear all folders
                                });

                                // Trigger ONE UI refresh instead of 26
                                dbManager.notifyTabs();

                                console.log(`AI ChatWorks: Local data cleared successfully(kept ${demoPrompts.length} demo prompts)`);
                            } catch (clearError) {
                                console.warn('AI ChatWorks: Error clearing local data:', clearError);
                            }
                        }
                    }
                }

                // Step 1: Download from cloud to local (initial sync)
                // Skip UI refresh during sign-in - ui-components.js handles it with proper timing
                const syncResult = await this.performInitialSync(true);

                // Step 2: Load and apply cloud settings (even if sync failed partially)
                try {
                    await this.loadAndApplyCloudSettings(isNewAccount);
                } catch (settingsError) {
                    console.warn('AI ChatWorks: Settings load failed:', settingsError.message);
                }

                // Update last sync time
                this.lastSyncTime = new Date().toISOString();

                // Show notification after sync completes
                const downloaded = (syncResult.downloadedFolders || 0) + (syncResult.downloadedPrompts || 0);
                const uploaded = uploadedFolders + uploadedPrompts;

                if (isNewAccount && uploaded > 0) {
                    // New account: show upload notification
                    console.log(`AI ChatWorks: New account sync completed - ${uploadedFolders} folders, ${uploadedPrompts} prompts uploaded to cloud`);
                    if (window.AI_ChatWorks_UserFeedbackManager) {
                        window.AI_ChatWorks_UserFeedbackManager.showToast(
                            `Welcome! Your ${uploadedFolders} folders and ${uploadedPrompts} prompts have been backed up to the cloud`,
                            'success'
                        );
                    }
                } else if (syncResult.success && downloaded > 0) {
                    // Existing account: show download notification
                    console.log(`AI ChatWorks: Background sync completed - ${syncResult.downloadedFolders} folders, ${syncResult.downloadedPrompts} prompts downloaded`);
                    if (window.AI_ChatWorks_UserFeedbackManager) {
                        window.AI_ChatWorks_UserFeedbackManager.showToast(
                            `Cloud sync completed: ${syncResult.downloadedFolders} folders and ${syncResult.downloadedPrompts} prompts synced`,
                            'success'
                        );
                    }
                } else if (!syncResult.success) {
                    console.warn('AI ChatWorks: Background sync had issues:', syncResult.error);
                    if (window.AI_ChatWorks_UserFeedbackManager) {
                        window.AI_ChatWorks_UserFeedbackManager.showToast(
                            'Cloud sync incomplete - check your connection',
                            'warning'
                        );
                    }
                } else {
                    console.log('AI ChatWorks: Background sync completed - no new data');
                }

                // Track sign-in in metadata
                await this.setSyncMetadata({
                    lastAction: 'sign-in',
                    lastTimestamp: new Date().toISOString()
                });

                return {
                    success: syncResult.success,
                    downloadedFolders: syncResult.downloadedFolders || 0,
                    downloadedPrompts: syncResult.downloadedPrompts || 0
                };

            } catch (error) {
                console.error('AI ChatWorks: Background sync error:', error);
                return { success: false, error: error.message };
            } finally {
                this.isSyncing = false;

                // Dispatch event to notify UI that sync is complete
                window.dispatchEvent(new CustomEvent('ai-chatworks-sync-complete', {
                    detail: { timestamp: new Date().toISOString() }
                }));

                // CRITICAL: Trigger UI refresh AFTER isSyncing is false
                // This ensures the cloud status updates from "Syncing..." to "Synced"
                this.triggerUIRefresh();
            }
        }

        /**
         * Perform background sync after sign-up
         * This runs async without blocking the UI and uploads local data for new accounts
         * @returns {Promise<Object>} Sync result with upload counts
         */
        async performBackgroundSyncAfterSignUp() {
            try {
                this.isSyncing = true;
                console.log('AI ChatWorks: Background sync after sign-up starting...');

                const dbManager = window.AI_ChatWorks_IndexedDBManager;
                let uploadedFolders = 0;
                let uploadedPrompts = 0;
                let uploadedSettings = false;

                // NEW ACCOUNT: Always upload local data to cloud
                if (dbManager) {
                    console.log('AI ChatWorks: New account - uploading local data to cloud...');
                    try {
                        // PERFORMANCE FIX: Batch upload all local folders in a single request
                        console.log('AI ChatWorks: Fetching local folders...');
                        const localFolders = await dbManager.getAll('folders');
                        console.log(`AI ChatWorks: Found ${localFolders.length} local folders`);

                        if (localFolders.length > 0) {
                            const cloudFolders = localFolders.map(folder => this.localToCloudFolder(folder));
                            await this.batchUpsertFolders(cloudFolders);
                            uploadedFolders = localFolders.length;
                            console.log(`AI ChatWorks: ✓ Batch uploaded ${uploadedFolders} folders to cloud in 1 request`);
                        }

                        // PERFORMANCE FIX: Batch upload all local prompts in a single request (except default demo prompts)
                        console.log('AI ChatWorks: Fetching local prompts...');
                        const localPrompts = await dbManager.getAll('prompts');
                        const userPrompts = localPrompts.filter(p => !p.id?.startsWith('default-'));
                        console.log(`AI ChatWorks: Found ${userPrompts.length} user prompts(${localPrompts.length} total)`);

                        if (userPrompts.length > 0) {
                            const cloudPrompts = userPrompts.map(prompt => this.localToCloudPrompt(prompt));
                            await this.batchUpsertPrompts(cloudPrompts);
                            uploadedPrompts = userPrompts.length;
                            console.log(`AI ChatWorks: ✓ Batch uploaded ${uploadedPrompts} prompts to cloud in 1 request`);
                        }
                    } catch (uploadError) {
                        console.error('AI ChatWorks: Error uploading local data to cloud:', uploadError);
                        // Continue despite error - we still want to complete sign-up
                    }
                } else {
                    console.log('AI ChatWorks: IndexedDB manager not available, skipping local data upload');
                }

                // Upload local settings to cloud
                console.log('AI ChatWorks: Uploading local settings...');
                try {
                    const SettingsManager = window.AI_ChatWorks_SettingsManager;
                    if (SettingsManager?.saveSettingsToCloud) {
                        await SettingsManager.saveSettingsToCloud();
                        uploadedSettings = true;
                        console.log('AI ChatWorks: ✓ Uploaded local settings to cloud');
                    } else {
                        console.log('AI ChatWorks: SettingsManager not available, skipping settings upload');
                    }
                } catch (settingsError) {
                    console.error('AI ChatWorks: Error uploading settings:', settingsError);
                    // Continue despite error - we still want to complete sign-up
                }

                // Update last sync time
                this.lastSyncTime = new Date().toISOString();
                console.log('AI ChatWorks: Updated last sync time:', this.lastSyncTime);

                // Show notification after sync completes
                const uploaded = uploadedFolders + uploadedPrompts;
                if (uploaded > 0) {
                    console.log(`AI ChatWorks: Sign - up sync completed - ${uploadedFolders} folders, ${uploadedPrompts} prompts uploaded to cloud`);
                } else {
                    console.log('AI ChatWorks: Sign-up sync completed - no local data to upload');
                }

                // Track sign-up in metadata
                console.log('AI ChatWorks: Saving sync metadata...');
                try {
                    await this.setSyncMetadata({
                        lastAction: 'sign-up',
                        lastTimestamp: new Date().toISOString()
                    });
                    console.log('AI ChatWorks: ✓ Sync metadata saved');
                } catch (metadataError) {
                    console.error('AI ChatWorks: Error saving sync metadata:', metadataError);
                    // Continue despite error
                }

                console.log('AI ChatWorks: Returning sign-up sync result:', { uploadedFolders, uploadedPrompts, uploadedSettings });

                return {
                    success: true,
                    uploadedFolders,
                    uploadedPrompts,
                    uploadedSettings
                };

            } catch (error) {
                console.error('AI ChatWorks: Background sync after sign-up error:', error);
                return { success: false, error: error.message, uploadedFolders: 0, uploadedPrompts: 0, uploadedSettings: false };
            } finally {
                this.isSyncing = false;
                console.log('AI ChatWorks: performBackgroundSyncAfterSignUp completed, isSyncing set to false');
                // CRITICAL: Trigger UI refresh AFTER isSyncing is false
                this.triggerUIRefresh();
            }
        }

        /**
         * Sign up new user
         * @param {string} email - User email
         * @param {string} password - User password
         * @param {Object} metadata - Optional user metadata
         * @returns {Object} Sign up result
         */
        async signUp(email, password, metadata = {}) {
            try {
                if (!this.supabase) {
                    throw new Error('Supabase not initialized');
                }

                console.log('AI ChatWorks: Signing up user with metadata:', metadata);
                console.log('AI ChatWorks: Supabase URL:', window.AI_ChatWorks_SupabaseConfig?.url);

                const { data, error } = await this.supabase.auth.signUp({
                    email,
                    password,
                    options: {
                        data: metadata
                    }
                });

                if (error) {
                    console.error('AI ChatWorks: Supabase signup error:', {
                        message: error.message,
                        status: error.status,
                        name: error.name
                    });
                    throw error;
                }

                console.log('AI ChatWorks: User signed up:', email);
                console.log('AI ChatWorks: Session exists:', !!data.session);
                console.log('AI ChatWorks: User exists:', !!data.user);

                // CRITICAL: Always try to create profile if user exists, even without session
                // This handles both auto-confirmed (has session) and email-confirmed (no session yet) cases
                if (data.user) {
                    this.currentUser = data.user;

                    // Pass metadata directly to ensureUserProfile to avoid timing issues
                    const profileCreated = await this.ensureUserProfile(metadata);
                    if (!profileCreated) {
                        console.error('AI ChatWorks: Failed to ensure user profile after signup');
                        return {
                            success: false,
                            error: 'Failed to create user profile. Please check database configuration.'
                        };
                    }

                    // Only start auto-sync if user has a session (auto-confirmed)
                    if (data.session) {
                        console.log('AI ChatWorks: User auto-confirmed, starting sync');
                        this.subscribeToRealtimeChanges();

                        // CRITICAL FIX: Perform initial sync for new sign-ups to upload local data
                        // Wait for sync to complete so we can show accurate counts in success popup
                        console.log('AI ChatWorks: Starting background sync after sign-up...');

                        // Await sync to get actual upload counts
                        const syncResult = await this.performBackgroundSyncAfterSignUp();

                        console.log('AI ChatWorks: Background sync after sign-up completed:', syncResult);

                        const result = {
                            success: true,
                            user: data.user,
                            needsConfirmation: false,
                            uploadedFolders: syncResult.uploadedFolders || 0,
                            uploadedPrompts: syncResult.uploadedPrompts || 0,
                            uploadedSettings: syncResult.uploadedSettings || false
                        };

                        console.log('AI ChatWorks: signUp() returning result:', result);

                        return result;
                    } else {
                        console.log('AI ChatWorks: Email confirmation required, profile created but not syncing yet');
                        return { success: true, user: data.user, needsConfirmation: true };
                    }
                }

                return { success: true, user: data.user, needsConfirmation: !data.session };

            } catch (error) {
                console.error('AI ChatWorks: Sign up failed:', error);

                // Provide more helpful error messages
                let errorMessage = error.message;
                if (error.message === 'Failed to fetch' || error.name === 'TypeError') {
                    errorMessage = 'Cannot connect to Supabase. Please check:\n' +
                        '1. Your Supabase project is active (not paused)\n' +
                        '2. Network connection is working\n' +
                        '3. Supabase URL is correct in supabase-config.js';
                }

                return { success: false, error: errorMessage };
            }
        }

        /**
         * Send password reset email
         * @param {string} email - User email address
         * @returns {Object} Reset result { success, error }
         */
        async resetPassword(email) {
            try {
                if (!this.supabase) {
                    throw new Error('Supabase not initialized');
                }

                console.log('AI ChatWorks: Sending password reset email to:', email);

                const { error } = await this.supabase.auth.resetPasswordForEmail(email, {
                    redirectTo: 'https://roeymit84.github.io/ai-chatworks-website/reset-password.html'
                });

                if (error) {
                    console.error('AI ChatWorks: Password reset failed:', error.message);
                    return { success: false, error: error.message };
                }

                console.log('AI ChatWorks: Password reset email sent successfully');
                return { success: true };

            } catch (error) {
                console.error('AI ChatWorks: Password reset error:', error);
                return { success: false, error: error.message };
            }
        }

        /**
         * Ensure user profile exists in database
         * Creates profile if it doesn't exist (idempotent operation using UPSERT)
         * @param {Object} metadata - Optional metadata object with first_name, last_name, display_name
         * @returns {Promise<boolean>} True if profile exists/created successfully
         */
        async ensureUserProfile(metadata = {}) {
            try {
                if (!this.currentUser) {
                    console.warn('AI ChatWorks: Cannot ensure profile - no current user');
                    return false;
                }

                // Verify we have a valid session
                const { data: { session }, error: sessionError } = await this.supabase.auth.getSession();
                if (sessionError || !session) {
                    console.warn('AI ChatWorks: No valid session for user profile creation');
                    console.warn('AI ChatWorks: Profile creation may fail due to RLS policies');
                    console.warn('AI ChatWorks: If email confirmation is enabled, profile will be created after confirmation');
                    // Don't return false - try anyway, RLS will enforce security
                }

                console.log('AI ChatWorks: Ensuring user profile exists for:', this.currentUser.email);
                console.log('AI ChatWorks: Metadata received:', metadata);

                // Use UPSERT (insert with ON CONFLICT DO UPDATE) for atomic operation
                // Prioritize metadata parameter over user_metadata to avoid timing issues
                const firstName = metadata.first_name || this.currentUser.user_metadata?.first_name || '';
                const lastName = metadata.last_name || this.currentUser.user_metadata?.last_name || '';
                const displayName = metadata.display_name || this.currentUser.user_metadata?.display_name ||
                    (firstName && lastName ? `${firstName} ${lastName} ` : null) ||
                    this.currentUser.email?.split('@')[0] || 'User';

                console.log('AI ChatWorks: Creating profile with:', { firstName, lastName, displayName });

                // Try to insert with firstName/lastName columns first
                let { data, error } = await this.supabase
                    .from('user_profiles')
                    .upsert({
                        id: this.currentUser.id,
                        email: this.currentUser.email,
                        first_name: firstName,
                        last_name: lastName,
                        display_name: displayName,
                        settings: {}
                    }, {
                        onConflict: 'id',
                        ignoreDuplicates: false // Update existing if needed
                    })
                    .select()
                    .single();

                // If columns don't exist (migration not run), try without firstName/lastName
                if (error && (error.code === '42703' || error.message?.includes('column') || error.message?.includes('first_name') || error.message?.includes('last_name'))) {
                    console.warn('AI ChatWorks: first_name/last_name columns may not exist, trying without them...');
                    console.warn('AI ChatWorks: Please run MIGRATION_ADD_NAME_FIELDS.sql to add these columns');

                    const fallbackResult = await this.supabase
                        .from('user_profiles')
                        .upsert({
                            id: this.currentUser.id,
                            email: this.currentUser.email,
                            display_name: displayName,
                            settings: {}
                        }, {
                            onConflict: 'id',
                            ignoreDuplicates: false
                        })
                        .select()
                        .single();

                    data = fallbackResult.data;
                    error = fallbackResult.error;
                }

                if (error) {
                    console.error('AI ChatWorks: Failed to ensure user profile:', {
                        message: error.message,
                        code: error.code,
                        details: error.details,
                        hint: error.hint
                    });
                    return false;
                }

                console.log('AI ChatWorks: User profile ensured successfully:', data.email);

                // Store user data in local storage for avatar/initials access
                try {
                    await chrome.storage.local.set({
                        user_email: this.currentUser.email,
                        user_first_name: firstName,
                        user_last_name: lastName
                    });
                    console.log('AI ChatWorks: User data stored in local storage:', {
                        email: this.currentUser.email,
                        firstName,
                        lastName
                    });
                } catch (storageError) {
                    console.warn('AI ChatWorks: Failed to store user data in local storage:', storageError);
                }

                return true;

            } catch (error) {
                console.error('AI ChatWorks: Error ensuring user profile:', {
                    message: error.message,
                    stack: error.stack
                });
                return false;
            }
        }

        /**
         * Sign out current user
         * @returns {Object} Sign out result
         */
        async signOut() {
            try {
                // STEP 1: Sync settings to cloud BEFORE sign-out
                // This ensures user's settings are preserved for their next login
                if (this.currentUser && this.supabase) {
                    try {
                        console.log('AI ChatWorks: Syncing settings to cloud before sign-out...');
                        // Get settings from chrome.storage.sync (where they're actually stored)
                        const CONSTANTS = window.AI_ChatWorks_Constants || {};
                        const syncKeys = [
                            CONSTANTS.STORAGE_KEYS?.THEME || 'aiChatWorks_theme',
                            CONSTANTS.STORAGE_KEYS?.PANEL_POSITION || 'aiChatWorks_panelPosition',
                            CONSTANTS.STORAGE_KEYS?.DEBUG_MODE || 'aiChatWorks_debugMode',
                            CONSTANTS.STORAGE_KEYS?.CARD_LAYOUT || 'aiChatWorks_cardLayout',
                            CONSTANTS.STORAGE_KEYS?.LANGUAGE || 'aiChatWorks_language',
                            CONSTANTS.STORAGE_KEYS?.LIBRARY_ZOOM || 'aiChatWorks_libraryZoom',
                            CONSTANTS.STORAGE_KEYS?.EXPORT_ENABLED || 'aiChatWorks_exportEnabled',
                            CONSTANTS.STORAGE_KEYS?.EXPORT_FORMATS || 'aiChatWorks_exportFormats',
                            CONSTANTS.STORAGE_KEYS?.EXPORT_FORMAT_ORDER || 'aiChatWorks_exportFormatOrder',
                            CONSTANTS.STORAGE_KEYS?.ALL_SITES || 'aiChatWorks_allSites',
                            'timelineEnabled'
                        ];
                        const syncResult = await chrome.storage.sync.get(syncKeys);
                        // Get avatar from local storage
                        const localResult = await chrome.storage.local.get(['user_avatar_id', 'ai_chatworks_flow_settings']);

                        const settings = {
                            theme: syncResult[CONSTANTS.STORAGE_KEYS?.THEME || 'aiChatWorks_theme'],
                            panel_position: syncResult[CONSTANTS.STORAGE_KEYS?.PANEL_POSITION || 'aiChatWorks_panelPosition'],
                            debug_mode: syncResult[CONSTANTS.STORAGE_KEYS?.DEBUG_MODE || 'aiChatWorks_debugMode'],
                            card_layout: syncResult[CONSTANTS.STORAGE_KEYS?.CARD_LAYOUT || 'aiChatWorks_cardLayout'],
                            language: syncResult[CONSTANTS.STORAGE_KEYS?.LANGUAGE || 'aiChatWorks_language'],
                            library_zoom: syncResult[CONSTANTS.STORAGE_KEYS?.LIBRARY_ZOOM || 'aiChatWorks_libraryZoom'],
                            export_enabled: syncResult[CONSTANTS.STORAGE_KEYS?.EXPORT_ENABLED || 'aiChatWorks_exportEnabled'],
                            export_formats: syncResult[CONSTANTS.STORAGE_KEYS?.EXPORT_FORMATS || 'aiChatWorks_exportFormats'],
                            export_format_order: syncResult[CONSTANTS.STORAGE_KEYS?.EXPORT_FORMAT_ORDER || 'aiChatWorks_exportFormatOrder'],
                            site_settings: syncResult[CONSTANTS.STORAGE_KEYS?.ALL_SITES || 'aiChatWorks_allSites'],
                            timeline_enabled: syncResult.timelineEnabled,
                            avatar_id: localResult.user_avatar_id,
                            flow_settings: localResult.ai_chatworks_flow_settings
                        };

                        // Save directly with skipLeadershipCheck to ensure it works during sign-out
                        const result = await this.saveSettingsToCloud(settings, { skipLeadershipCheck: true });
                        if (result.success) {
                            console.log('AI ChatWorks: Settings synced to cloud before sign-out');
                        } else {
                            console.warn('AI ChatWorks: Settings sync failed (non-blocking):', result.error);
                        }
                    } catch (e) {
                        console.warn('AI ChatWorks: Error syncing settings before sign-out:', e);
                        // Continue with sign-out even if sync fails
                    }
                }

                // STEP 2: Stop auto-sync
                try {
                    this.stopAutoSync();
                } catch (e) {
                    console.warn('AI ChatWorks: Error stopping auto-sync:', e);
                }

                // STEP 3: Unsubscribe from realtime
                try {
                    this.unsubscribeFromRealtimeChanges();
                } catch (e) {
                    console.warn('AI ChatWorks: Error unsubscribing from realtime:', e);
                }

                // STEP 3.5: Release leadership and stop leader check interval
                // CRITICAL FIX: Prevent leader check from running after sign-out (causes lag in offline tabs)
                try {
                    await this.releaseLeadership();
                } catch (e) {
                    console.warn('AI ChatWorks: Error releasing leadership:', e);
                }

                // STEP 4: Sign out from Supabase (if initialized) with timeout
                if (this.supabase) {
                    try {
                        // Add 5-second timeout to prevent hanging
                        const signOutPromise = this.supabase.auth.signOut();
                        const timeoutPromise = new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Sign out timeout')), 5000)
                        );

                        const { error } = await Promise.race([signOutPromise, timeoutPromise]);
                        if (error) {
                            console.log('AI ChatWorks: Supabase sign out error (will clear local storage anyway):', error.message);
                        }
                    } catch (e) {
                        console.log('AI ChatWorks: Supabase sign out exception (will clear local storage anyway):', e.message);
                    }

                    // Force clear Supabase session from localStorage
                    // This ensures sign out works even if supabase.auth.signOut() fails
                    try {
                        const config = window.AI_ChatWorks_SupabaseConfig;
                        if (config && config.url) {
                            // Extract project reference from Supabase URL (e.g., "abcdefgh" from "https://abcdefgh.supabase.co")
                            const projectRef = new URL(config.url).hostname.split('.')[0];

                            // Clear all Supabase auth keys from localStorage
                            const keysToRemove = [
                                `sb - ${projectRef} -auth - token`,
                                `sb - ${projectRef} -auth - token - code - verifier`,
                                `supabase.auth.token`,
                                `supabase.auth.refreshToken`
                            ];

                            keysToRemove.forEach(key => {
                                try {
                                    localStorage.removeItem(key);
                                } catch (e) {
                                    // Ignore errors when removing individual keys
                                }
                            });

                            console.log('AI ChatWorks: Cleared Supabase session from localStorage');
                        }
                    } catch (e) {
                        console.warn('AI ChatWorks: Error clearing localStorage (non-fatal):', e.message);
                    }
                } else {
                    console.log('AI ChatWorks: Supabase not initialized, clearing local session only');
                }

                // STEP 5: Clear ALL user data from chrome storage with timeout
                try {
                    // Add 3-second timeout to prevent hanging
                    // Include settings keys to fully reset user state
                    const storagePromise = chrome.storage.local.remove([
                        'user_email',
                        'user_first_name',
                        'user_last_name',
                        'user_avatar_id',
                        'settings',
                        'theme',
                        'panel_position',
                        'debug_mode',
                        'card_layout',
                        'language',
                        'export_enabled',
                        'export_formats',
                        'export_format_order',
                        'site_settings'
                    ]);
                    const timeoutPromise = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Storage clear timeout')), 3000)
                    );

                    await Promise.race([storagePromise, timeoutPromise]);
                    console.log('AI ChatWorks: Cleared ALL user data from chrome storage (including settings)');
                } catch (e) {
                    console.warn('AI ChatWorks: Error clearing chrome storage:', e.message);
                }

                // CRITICAL: Clear prompts and folders from IndexedDB (LOCAL ONLY)
                // This prevents next user from seeing previous user's data
                // Use skipCloudSync to prevent deleting from cloud - data should stay in cloud for user
                try {
                    const dbManager = window.AI_ChatWorks_IndexedDBManager;
                    if (dbManager) {
                        console.log('AI ChatWorks: Clearing LOCAL user data from IndexedDB...');

                        // Clear all prompts (LOCAL ONLY - don't delete from cloud)
                        // CRITICAL FIX: Use skipCloudSync instead of fromRealtime
                        // skipCloudSync = skip cloud deletion but STILL notify other tabs
                        // fromRealtime = skip both cloud sync AND tab notifications (causes bug)
                        const prompts = await dbManager.getAll('prompts');
                        for (const prompt of prompts) {
                            await dbManager.delete('prompts', prompt.id, { skipCloudSync: true });
                        }
                        console.log('AI ChatWorks: Cleared', prompts.length, 'prompts from local storage (notifying other tabs)');

                        // Clear all folders (LOCAL ONLY - don't delete from cloud)
                        const folders = await dbManager.getAll('folders');
                        for (const folder of folders) {
                            await dbManager.delete('folders', folder.id, { skipCloudSync: true });
                        }
                        console.log('AI ChatWorks: Cleared', folders.length, 'folders from local storage (notifying other tabs)');

                        // Clear settings from IndexedDB if stored there
                        try {
                            await dbManager.clear('settings');
                        } catch (e) {
                            // Settings store might not exist
                        }

                        console.log('AI ChatWorks: All LOCAL user data cleared (cloud data preserved)');
                    }
                } catch (e) {
                    console.warn('AI ChatWorks: Error clearing IndexedDB:', e.message);
                }

                // STEP 6: Reset settings to defaults for next user
                try {
                    const CONSTANTS = window.AI_ChatWorks_Constants || {};
                    const defaultSettings = {
                        [CONSTANTS.STORAGE_KEYS?.THEME || 'aiChatWorks_theme']: 'auto',
                        [CONSTANTS.STORAGE_KEYS?.PANEL_POSITION || 'aiChatWorks_panelPosition']: 'pos-bottom-right',
                        [CONSTANTS.STORAGE_KEYS?.DEBUG_MODE || 'aiChatWorks_debugMode']: false,
                        [CONSTANTS.STORAGE_KEYS?.CARD_LAYOUT || 'aiChatWorks_cardLayout']: 'compact',
                        [CONSTANTS.STORAGE_KEYS?.LANGUAGE || 'aiChatWorks_language']: 'en',
                        [CONSTANTS.STORAGE_KEYS?.LIBRARY_ZOOM || 'aiChatWorks_libraryZoom']: 100,
                        [CONSTANTS.STORAGE_KEYS?.EXPORT_ENABLED || 'aiChatWorks_exportEnabled']: true,
                        [CONSTANTS.STORAGE_KEYS?.EXPORT_FORMATS || 'aiChatWorks_exportFormats']: { markdown: true, text: true, json: false, csv: false },
                        [CONSTANTS.STORAGE_KEYS?.EXPORT_FORMAT_ORDER || 'aiChatWorks_exportFormatOrder']: ['markdown', 'text', 'json', 'csv']
                    };
                    await chrome.storage.sync.set(defaultSettings);
                    console.log('AI ChatWorks: Settings reset to defaults');
                } catch (e) {
                    console.warn('AI ChatWorks: Error resetting settings to defaults:', e.message);
                }

                // STEP 7: Track sign-out in metadata (for edge case handling)
                // This helps detect when user works offline after sign-out
                try {
                    await this.setSyncMetadata({
                        lastAction: 'sign-out',
                        lastTimestamp: new Date().toISOString(),
                        offlineWorkPending: false // Reset flag on sign-out
                    });
                    console.log('AI ChatWorks: Sign-out tracked in metadata');
                } catch (e) {
                    console.warn('AI ChatWorks: Error tracking sign-out metadata:', e.message);
                }

                // Clear current user state - this is the critical part
                this.currentUser = null;
                console.log('AI ChatWorks: User signed out successfully');

                return { success: true };

            } catch (error) {
                // Even if something goes wrong, always clear local user state
                console.error('AI ChatWorks: Sign out error:', error);
                this.currentUser = null;
                // Still return success since local state is cleared
                return { success: true };
            }
        }

        /**
         * Start automatic sync every 3 hours
         * @param {boolean} skipImmediate - If true, skip immediate sync (used after sign-in when background sync handles it)
         */
        startAutoSync(skipImmediate = false) {
            // Clear any existing interval
            this.stopAutoSync();

            console.log('AI ChatWorks: Auto-sync started (every 3 hours)');

            // Run sync immediately unless skipped (e.g., after sign-in when background sync is running)
            if (!skipImmediate) {
                this.performAutoSync();
            }

            // Set up interval for 3-hour sync
            this.autoSyncInterval = setInterval(() => {
                this.performAutoSync();
            }, this.AUTO_SYNC_INTERVAL_MS);
        }

        /**
         * Stop automatic sync
         */
        stopAutoSync() {
            if (this.autoSyncInterval) {
                clearInterval(this.autoSyncInterval);
                this.autoSyncInterval = null;
                console.log('AI ChatWorks: Auto-sync stopped');
            }
        }

        /**
         * Add failed sync to retry queue
         * @param {string} operation - 'upsert' or 'delete'
         * @param {string} storeName - 'prompts' or 'folders'
         * @param {Object} data - The data to retry
         */
        addToRetryQueue(operation, storeName, data) {
            // Don't add if queue is full
            if (this.retryQueue.length >= this.MAX_RETRY_QUEUE_SIZE) {
                console.warn('AI ChatWorks: Retry queue full, dropping oldest item');
                this.retryQueue.shift(); // Remove oldest
            }

            // Check if item already in queue (by ID)
            const existingIndex = this.retryQueue.findIndex(
                item => item.storeName === storeName &&
                    item.data.id === data.id &&
                    item.operation === operation
            );

            if (existingIndex >= 0) {
                // Already in queue, don't duplicate
                console.log('AI ChatWorks: Item already in retry queue, skipping');
                return;
            }

            this.retryQueue.push({
                operation,
                storeName,
                data,
                retries: 0,
                timestamp: Date.now()
            });

            console.log(`AI ChatWorks: Added to retry queue(${this.retryQueue.length} items pending)`);
        }

        /**
         * Process retry queue - attempt to sync failed items
         */
        async processRetryQueue() {
            if (this.retryQueue.length === 0) {
                return;
            }

            console.log(`AI ChatWorks: Processing retry queue(${this.retryQueue.length} items)...`);

            const itemsToRetry = [...this.retryQueue];
            this.retryQueue = []; // Clear queue

            for (const item of itemsToRetry) {
                try {
                    if (item.operation === 'upsert') {
                        if (item.storeName === 'prompts') {
                            const cloudPrompt = this.localToCloudPrompt(item.data);
                            await this.upsertPrompt(cloudPrompt);
                            console.log(`AI ChatWorks: ✓ Retry succeeded for prompt: ${item.data.name} `);
                        } else if (item.storeName === 'folders') {
                            const cloudFolder = this.localToCloudFolder(item.data);
                            await this.upsertFolder(cloudFolder);
                            console.log(`AI ChatWorks: ✓ Retry succeeded for folder: ${item.data.name} `);
                        }
                    } else if (item.operation === 'delete') {
                        if (item.storeName === 'prompts') {
                            await this.deletePrompt(item.data.id);
                            console.log(`AI ChatWorks: ✓ Retry succeeded for deleting prompt: ${item.data.id} `);
                        } else if (item.storeName === 'folders') {
                            await this.deleteFolder(item.data.id);
                            console.log(`AI ChatWorks: ✓ Retry succeeded for deleting folder: ${item.data.id} `);
                        }
                    }
                } catch (error) {
                    // Retry failed - add back to queue if under max retries
                    item.retries++;
                    if (item.retries < this.MAX_RETRIES_PER_ITEM) {
                        this.retryQueue.push(item);
                        console.warn(`AI ChatWorks: Retry failed(${item.retries} / ${this.MAX_RETRIES_PER_ITEM}), will try again: `, error.message);
                    } else {
                        console.error(`AI ChatWorks: Max retries reached for item, giving up: `, item.data.name || item.data.id);
                    }
                }
            }

            if (this.retryQueue.length > 0) {
                console.log(`AI ChatWorks: ${this.retryQueue.length} items remaining in retry queue`);
            }
        }

        /**
         * Perform automatic sync (background backup)
         * This syncs ALL local data to cloud without user intervention
         * @param {boolean} userInitiated - If true, bypass leader check (user clicked "Sync Now")
         */
        async performAutoSync(userInitiated = false) {
            // Skip if not properly initialized, not authenticated, or offline
            if (!this.supabase) {
                console.log('AI ChatWorks: Skipping auto-sync (Supabase not initialized)');
                return { success: false, error: 'Supabase not initialized' };
            }
            if (!this.currentUser || !this.isOnline) {
                console.log('AI ChatWorks: Skipping auto-sync (offline or not authenticated)');
                return { success: false, error: 'Not authenticated or offline' };
            }

            // CRITICAL: Verify leadership before syncing (prevents race conditions)
            // UNLESS user explicitly requested sync (forceSync)
            if (!userInitiated) {
                const isLeader = await this.verifyLeadershipForSync();
                if (!isLeader) {
                    console.log('AI ChatWorks: Skipping auto-sync (not leader or lost leadership)');
                    return { success: false, error: 'Not leader', skipped: true };
                }
            }

            // Skip if already syncing
            if (this.isSyncing) {
                console.log('AI ChatWorks: Sync already in progress, skipping');
                return { success: false, error: 'Sync already in progress' };
            }

            try {
                this.isSyncing = true;
                const syncType = userInitiated ? 'user-initiated sync' : 'scheduled auto-sync backup';
                console.log(`AI ChatWorks: Performing ${syncType}...`);

                // CRITICAL: Process retry queue first (failed syncs from live sync)
                await this.processRetryQueue();

                // NOTE: Folders and prompts are NOT synced during auto-sync
                // They are synced immediately via live sync when user creates/edits them
                // This reduces API calls while maintaining data integrity through:
                // 1. Live sync (immediate, all tabs)
                // 2. Retry queue (automatic retries for failures)

                // Sync settings and avatar (8-hour backup)
                const SettingsManager = window.AI_ChatWorks_SettingsManager;
                if (SettingsManager?.saveSettingsToCloud) {
                    try {
                        await SettingsManager.saveSettingsToCloud();
                        console.log('AI ChatWorks: ✓ Settings and avatar backed up to cloud');
                    } catch (error) {
                        console.warn('AI ChatWorks: Failed to backup settings:', error.message);
                    }
                }

                this.lastSyncTime = new Date().toISOString();
                console.log('AI ChatWorks: Auto-sync completed - settings & avatar backed up to cloud');

                return { success: true };

            } catch (error) {
                console.error('AI ChatWorks: Auto-sync failed:', error);
                return { success: false, error: error.message };
            } finally {
                this.isSyncing = false;
            }
        }

        /**
         * Force sync now (user-initiated)
         * Returns detailed sync report
         */
        async forceSync() {
            console.log('AI ChatWorks: User initiated force sync...');
            // Pass userInitiated=true to bypass leader check
            // User explicitly wants THIS tab to sync NOW

            // Add timeout to prevent UI from getting stuck
            const timeoutPromise = new Promise(resolve =>
                setTimeout(() => resolve({ success: false, error: 'Sync timed out' }), 15000)
            );

            const syncPromise = this.performAutoSync(true);
            const result = await Promise.race([syncPromise, timeoutPromise]);

            if (result && result.success) {
                return {
                    success: true,
                    message: 'Settings and avatar synced to cloud',
                    timestamp: this.lastSyncTime
                };
            }

            return result || { success: false, error: 'Sync failed to start' };
        }

        /**
         * Sync offline work to cloud (cross-device offline sync fix)
         * Called when signed-in tab receives changes from offline tab
         * Uploads new items and deletes items that were deleted offline
         * @returns {Promise<Object>} Sync result with counts
         */
        async syncOfflineWorkToCloud() {
            try {
                // Skip if not authenticated or already syncing
                if (!this.currentUser || !this.supabase || this.isSyncing) {
                    return { success: false, skipped: true };
                }

                // Skip if offline (no network) - prevents repeated failed network calls
                if (!navigator.onLine) {
                    console.log('AI ChatWorks: Skipping offline sync - no network connection');
                    return { success: false, skipped: true, offline: true };
                }

                // Only leader tab should upload (prevent duplicate uploads)
                const isLeader = await this.verifyLeadershipForSync();
                if (!isLeader) {
                    console.log('AI ChatWorks: Skipping offline sync - not leader tab');
                    return { success: false, skipped: true };
                }

                const dbManager = window.AI_ChatWorks_IndexedDBManager;
                if (!dbManager) return { success: false, error: 'No DB manager' };

                console.log('AI ChatWorks: Checking for offline work to sync...');

                let uploadedFolders = 0;
                let uploadedPrompts = 0;
                let deletedFolders = 0;
                let deletedPrompts = 0;

                // Get local items
                const localFolders = await dbManager.getAll('folders');
                const localPrompts = await dbManager.getAll('prompts');
                const userPrompts = localPrompts.filter(p => !p.id?.startsWith('default-'));

                // Get cloud items to compare
                const { data: cloudFolders } = await this.supabase
                    .from('folders')
                    .select('id');

                const { data: cloudPrompts } = await this.supabase
                    .from('prompts')
                    .select('id');

                const cloudFolderIds = new Set(cloudFolders?.map(f => f.id) || []);
                const cloudPromptIds = new Set(cloudPrompts?.map(p => p.id) || []);
                const localFolderIds = new Set(localFolders.map(f => f.id));
                const localPromptIds = new Set(userPrompts.map(p => p.id));

                // Find items that exist locally but not in cloud (new items created offline)
                const newFolders = localFolders.filter(f => !cloudFolderIds.has(f.id));
                const newPrompts = userPrompts.filter(p => !cloudPromptIds.has(p.id));

                // Find items that exist in cloud but not locally (deleted offline)
                const deletedFolderIds = Array.from(cloudFolderIds).filter(id => !localFolderIds.has(id));
                const deletedPromptIds = Array.from(cloudPromptIds).filter(id => !localPromptIds.has(id));

                if (newFolders.length === 0 && newPrompts.length === 0 &&
                    deletedFolderIds.length === 0 && deletedPromptIds.length === 0) {
                    console.log('AI ChatWorks: No offline work to sync');
                    return { success: true, uploadedFolders: 0, uploadedPrompts: 0, deletedFolders: 0, deletedPrompts: 0 };
                }

                console.log(`AI ChatWorks: Found offline work - ${newFolders.length} new folders, ${newPrompts.length} new prompts, ${deletedFolderIds.length} deleted folders, ${deletedPromptIds.length} deleted prompts`);

                // Upload new folders
                if (newFolders.length > 0) {
                    const cloudFoldersData = newFolders.map(f => this.localToCloudFolder(f));
                    await this.batchUpsertFolders(cloudFoldersData);
                    uploadedFolders = newFolders.length;
                    console.log(`AI ChatWorks: Uploaded ${uploadedFolders} offline folders to cloud`);
                }

                // Upload new prompts
                if (newPrompts.length > 0) {
                    const cloudPromptsData = newPrompts.map(p => this.localToCloudPrompt(p));
                    await this.batchUpsertPrompts(cloudPromptsData);
                    uploadedPrompts = newPrompts.length;
                    console.log(`AI ChatWorks: Uploaded ${uploadedPrompts} offline prompts to cloud`);
                }

                // Delete prompts that were deleted offline (delete prompts first due to foreign key)
                if (deletedPromptIds.length > 0) {
                    for (const promptId of deletedPromptIds) {
                        try {
                            await this.deletePrompt(promptId);
                            deletedPrompts++;
                        } catch (error) {
                            console.warn(`AI ChatWorks: Failed to delete prompt ${promptId} from cloud: `, error);
                        }
                    }
                    console.log(`AI ChatWorks: Deleted ${deletedPrompts} offline - deleted prompts from cloud`);
                }

                // Delete folders that were deleted offline
                if (deletedFolderIds.length > 0) {
                    for (const folderId of deletedFolderIds) {
                        try {
                            await this.deleteFolder(folderId);
                            deletedFolders++;
                        } catch (error) {
                            console.warn(`AI ChatWorks: Failed to delete folder ${folderId} from cloud: `, error);
                        }
                    }
                    console.log(`AI ChatWorks: Deleted ${deletedFolders} offline - deleted folders from cloud`);
                }

                // Clear offline work pending flag
                await this.clearOfflineWorkPending();

                return {
                    success: true,
                    uploadedFolders,
                    uploadedPrompts,
                    deletedFolders,
                    deletedPrompts
                };

            } catch (error) {
                console.error('AI ChatWorks: Error syncing offline work:', error);
                return { success: false, error: error.message };
            }
        }

        /**
         * Reset all cloud data (delete all folders and prompts from cloud)
         * Local data is not affected
         * @returns {Object} Reset result
         */
        async resetCloudData() {
            try {
                if (!this.supabase || !this.currentUser) {
                    return { success: false, error: 'Not authenticated' };
                }

                console.log('AI ChatWorks: Resetting cloud data...');

                // Delete all prompts first (due to foreign key to folders)
                const { error: promptsError } = await this.supabase
                    .from('prompts')
                    .delete()
                    .eq('user_id', this.currentUser.id);

                if (promptsError) {
                    console.error('AI ChatWorks: Failed to delete prompts:', promptsError);
                    return { success: false, error: `Failed to delete prompts: ${promptsError.message} ` };
                }

                // Delete all folders
                const { error: foldersError } = await this.supabase
                    .from('folders')
                    .delete()
                    .eq('user_id', this.currentUser.id);

                if (foldersError) {
                    console.error('AI ChatWorks: Failed to delete folders:', foldersError);
                    return { success: false, error: `Failed to delete folders: ${foldersError.message} ` };
                }

                // Delete usage history
                const { error: historyError } = await this.supabase
                    .from('usage_history')
                    .delete()
                    .eq('user_id', this.currentUser.id);

                if (historyError) {
                    console.warn('AI ChatWorks: Failed to delete usage history:', historyError);
                    // Don't fail on history deletion
                }

                console.log('AI ChatWorks: Cloud data reset complete');
                return { success: true, message: 'All cloud data deleted successfully' };

            } catch (error) {
                console.error('AI ChatWorks: Error resetting cloud data:', error);
                return { success: false, error: error.message };
            }
        }

        /**
         * Perform initial sync (download from cloud to local)
         * This is called once after sign-in to download user's cloud data
         * @param {boolean} skipUIRefresh - If true, skip automatic UI refresh (used during sign-in when ui-components.js handles refresh)
         * @returns {Promise<Object>} Sync result with downloadedFolders and downloadedPrompts counts
         */
        async performInitialSync(skipUIRefresh = false) {
            // Guard: Ensure Supabase and user are initialized
            if (!this.supabase) {
                console.warn('AI ChatWorks: Cannot perform initial sync - Supabase not initialized');
                return { success: false, error: 'Supabase not initialized' };
            }
            if (!this.currentUser) {
                console.warn('AI ChatWorks: Cannot perform initial sync - User not authenticated');
                return { success: false, error: 'User not authenticated' };
            }

            try {
                console.log('AI ChatWorks: Performing initial sync (cloud → local)...');

                const dbManager = window.AI_ChatWorks_IndexedDBManager;
                let downloadedFolders = 0;
                let downloadedPrompts = 0;

                // Download folders from cloud
                const { data: cloudFolders, error: foldersError } = await this.supabase
                    .from('folders')
                    .select('*')
                    .eq('user_id', this.currentUser.id)
                    .order('created_at', { ascending: true });

                if (foldersError) throw foldersError;

                // Download prompts from cloud
                const { data: cloudPrompts, error: promptsError } = await this.supabase
                    .from('prompts')
                    .select('*')
                    .eq('user_id', this.currentUser.id)
                    .order('created_at', { ascending: true });

                if (promptsError) throw promptsError;

                // Get local data
                const localFolders = await dbManager.getAll('folders');
                const localPrompts = await dbManager.getAll('prompts');

                console.log(`AI ChatWorks: Cloud has ${cloudFolders?.length || 0} folders, ${cloudPrompts?.length || 0} prompts`);
                console.log(`AI ChatWorks: Local has ${localFolders.length} folders, ${localPrompts.length} prompts`);

                // Merge folders using timestamps (most recent wins)
                if (cloudFolders && cloudFolders.length > 0) {
                    const localFolderMap = new Map(localFolders.map(f => [f.id, f]));

                    for (const cloudFolder of cloudFolders) {
                        const localFolder = localFolderMap.get(cloudFolder.id);
                        const cloudUpdatedAt = new Date(cloudFolder.updated_at).getTime();

                        // Download if: doesn't exist locally OR (exists but cloud is newer)
                        let shouldDownload = false;

                        if (!localFolder) {
                            // Doesn't exist locally - always download
                            shouldDownload = true;
                        } else if (localFolder.updatedAt) {
                            // Exists locally with timestamp - compare timestamps
                            const localUpdatedAt = new Date(localFolder.updatedAt).getTime();
                            shouldDownload = cloudUpdatedAt > localUpdatedAt;
                        } else {
                            // Exists locally but no timestamp - download if cloud is newer than creation
                            const localCreatedAt = new Date(localFolder.createdAt || 0).getTime();
                            shouldDownload = cloudUpdatedAt > localCreatedAt;
                        }

                        if (shouldDownload) {
                            const folderToSave = this.cloudToLocalFolder(cloudFolder);
                            // CRITICAL: Pass fromRealtime flag to prevent re-uploading data we just downloaded!
                            await dbManager.put('folders', folderToSave, { fromRealtime: true });
                            downloadedFolders++;
                            console.log(`AI ChatWorks: ⬇ Downloaded folder from cloud: ${cloudFolder.name} `);
                        }
                    }
                }

                // Merge prompts using timestamps (most recent wins)
                if (cloudPrompts && cloudPrompts.length > 0) {
                    const localPromptMap = new Map(localPrompts.map(p => [p.id, p]));

                    for (const cloudPrompt of cloudPrompts) {
                        // Skip demo/default prompts (should never download these)
                        if (cloudPrompt.id && cloudPrompt.id.startsWith('default-')) {
                            console.log(`AI ChatWorks: Skipping demo prompt: ${cloudPrompt.id} `);
                            continue;
                        }

                        const localPrompt = localPromptMap.get(cloudPrompt.id);
                        const cloudUpdatedAt = new Date(cloudPrompt.updated_at).getTime();

                        // Download if: doesn't exist locally OR (exists but cloud is newer)
                        let shouldDownload = false;

                        if (!localPrompt) {
                            // Doesn't exist locally - always download
                            shouldDownload = true;
                        } else if (localPrompt.updatedAt) {
                            // Exists locally with timestamp - compare timestamps
                            const localUpdatedAt = new Date(localPrompt.updatedAt).getTime();
                            shouldDownload = cloudUpdatedAt > localUpdatedAt;
                        } else {
                            // Exists locally but no timestamp - download if cloud is newer than creation
                            const localCreatedAt = new Date(localPrompt.createdAt || 0).getTime();
                            shouldDownload = cloudUpdatedAt > localCreatedAt;
                        }

                        if (shouldDownload) {
                            const promptToSave = this.cloudToLocalPrompt(cloudPrompt);
                            // CRITICAL: Pass fromRealtime flag to prevent re-uploading data we just downloaded!
                            await dbManager.put('prompts', promptToSave, { fromRealtime: true });
                            downloadedPrompts++;
                            console.log(`AI ChatWorks: ⬇ Downloaded prompt from cloud: ${cloudPrompt.name} `);
                        }
                    }
                }

                console.log(`AI ChatWorks: ✓ Downloaded ${downloadedFolders} folders and ${downloadedPrompts} prompts from cloud`);

                // Upload local items that don't exist in cloud or are newer
                // This is handled by the background sync process after initial download
                console.log('AI ChatWorks: Initial download sync completed successfully');

                // Trigger UI refresh if any data was downloaded
                // SKIP during sign-in flow as ui-components.js handles the refresh with proper timing
                if ((downloadedFolders > 0 || downloadedPrompts > 0) && !skipUIRefresh) {
                    console.log('AI ChatWorks: Triggering UI refresh...');
                    this.triggerUIRefresh();
                }

                // Cleanup demo prompts from cloud if they exist
                await this.cleanupDemoPrompts();

                return {
                    success: true,
                    downloadedFolders,
                    downloadedPrompts
                };

            } catch (error) {
                // Always log the actual error for debugging
                console.warn('AI ChatWorks: Initial sync error:', error.message);

                // Handle network errors gracefully (offline scenario)
                const isOffline = !navigator.onLine;
                const isNetworkError = isOffline ||
                    error.message?.includes('Failed to fetch') ||
                    error.message?.includes('NetworkError') ||
                    error.message?.includes('network request failed') ||
                    error.code === 'NETWORK_ERROR';

                if (isNetworkError) {
                    console.warn('AI ChatWorks: Will retry sync when back online');
                    this.pendingSettingsSync = true; // Will retry when online
                    return { success: false, error: 'Network unavailable', offline: true };
                }

                return { success: false, error: error.message };
            }
        }

        /**
         * Cleanup demo prompts from cloud
         * Deletes any demo prompts (default-001, default-002, default-003, default-004) from cloud storage
         */
        async cleanupDemoPrompts() {
            if (!this.currentUser || !this.isOnline) return;

            try {
                console.log('AI ChatWorks: Cleaning up demo prompts from cloud...');

                // PERFORMANCE FIX: Delete all demo prompts in a single query
                // Before: 1 SELECT + N DELETE (5 REST calls for 4 demo prompts)
                // After: 1 DELETE (1 REST call)
                const { error, count } = await this.supabase
                    .from('prompts')
                    .delete({ count: 'exact' })
                    .eq('user_id', this.currentUser.id)
                    .like('id', 'default-%');

                if (error) {
                    console.warn('AI ChatWorks: Error cleaning up demo prompts:', error);
                    return;
                }

                if (count > 0) {
                    console.log(`AI ChatWorks: ✓ Deleted ${count} demo prompts from cloud in 1 query`);
                } else {
                    console.log('AI ChatWorks: No demo prompts found in cloud');
                }
            } catch (error) {
                console.warn('AI ChatWorks: Error during demo prompts cleanup:', error);
            }
        }

        /**
         * Trigger UI refresh after downloading cloud data
         * Dispatches custom event that UI components listen to
         */
        triggerUIRefresh() {
            try {
                // DIRECT UI REFRESH: Refresh UI managers if available
                // If not available, data is still in local storage and will appear when UI opens
                const attemptRefresh = (retryCount = 0) => {
                    const maxRetries = 8;
                    const retryDelay = 1000;

                    if (window.AI_ChatWorks_PromptLibraryManager && window.AI_ChatWorks_PromptUIManager) {
                        console.log('AI ChatWorks: Refreshing UI after sync');
                        window.AI_ChatWorks_PromptLibraryManager.loadData({ force: true });
                        window.AI_ChatWorks_PromptUIManager.refresh?.();
                    } else if (retryCount < maxRetries) {
                        // Silently retry - no need to spam console
                        setTimeout(() => attemptRefresh(retryCount + 1), retryDelay);
                        return;
                    }
                    // If UI managers not available after retries, that's OK - data is in local storage
                };

                attemptRefresh();

                // Dispatch custom event for UI to refresh
                const event = new CustomEvent('ai-chatworks-data-updated', {
                    detail: { source: 'cloud-sync', timestamp: Date.now() }
                });
                document.dispatchEvent(event);

                // Broadcast sync status to other tabs
                chrome.storage.local.set({
                    last_sync_update: {
                        timestamp: Date.now(),
                        lastSync: this.lastSyncTime,
                        isSyncing: this.isSyncing
                    }
                }).catch(() => {
                    // Silently fail - not critical
                });
            } catch (error) {
                console.warn('AI ChatWorks: UI refresh failed:', error.message);
            }
        }

        /**
         * Add or update folder in cloud
         */
        async addFolder(folder) {
            if (!this.supabase || !this.currentUser || !this.isOnline) return;

            try {
                const cloudFolder = this.localToCloudFolder(folder);
                await this.upsertFolder(cloudFolder);
            } catch (error) {
                console.warn('AI ChatWorks: Failed to sync folder to cloud:', error.message);
            }
        }

        /**
         * Update folder in cloud
         */
        async updateFolder(folder) {
            return this.addFolder(folder); // Same operation - upsert
        }

        /**
         * Delete folder from cloud
         */
        async deleteFolder(folderId) {
            console.log('AI ChatWorks: deleteFolder() called for:', folderId);

            if (!this.supabase) {
                console.warn('AI ChatWorks: Cannot delete folder - Supabase not initialized');
                return;
            }
            if (!this.currentUser) {
                console.warn('AI ChatWorks: Cannot delete folder - User not authenticated');
                return;
            }
            if (!this.isOnline) {
                console.warn('AI ChatWorks: Cannot delete folder - Browser is offline');
                return;
            }

            try {
                console.log('AI ChatWorks: Executing DELETE query for folder:', folderId);
                const { error } = await this.supabase
                    .from('folders')
                    .delete()
                    .eq('id', folderId)
                    .eq('user_id', this.currentUser.id);

                if (error) throw error;
                console.log('AI ChatWorks: ✓ Folder deleted from cloud:', folderId);
            } catch (error) {
                console.error('AI ChatWorks: ✗ Failed to delete folder from cloud:', error.message, error);
            }
        }

        /**
         * Add or update prompt in cloud
         */
        async addPrompt(prompt) {
            if (!this.supabase || !this.currentUser || !this.isOnline) return;

            try {
                const cloudPrompt = this.localToCloudPrompt(prompt);
                await this.upsertPrompt(cloudPrompt);
            } catch (error) {
                console.warn('AI ChatWorks: Failed to sync prompt to cloud:', error.message);
            }
        }

        /**
         * Update prompt in cloud
         */
        async updatePrompt(prompt) {
            return this.addPrompt(prompt); // Same operation - upsert
        }

        /**
         * Delete prompt from cloud
         */
        async deletePrompt(promptId) {
            // DIAGNOSTIC: Log complete call stack to identify duplicate deletions
            const callStack = new Error().stack?.split('\n').slice(2, 7).join('\n    ') || 'unknown';
            console.log(`AI ChatWorks: ❌ deletePrompt() - Making DELETE request for: ${promptId} `);
            console.log(`   Call stack: \n    ${callStack} `);

            if (!this.supabase) {
                console.warn('AI ChatWorks: Cannot delete prompt - Supabase not initialized');
                return;
            }
            if (!this.currentUser) {
                console.warn('AI ChatWorks: Cannot delete prompt - User not authenticated');
                return;
            }
            if (!this.isOnline) {
                console.warn('AI ChatWorks: Cannot delete prompt - Browser is offline');
                return;
            }

            try {
                console.log(`AI ChatWorks: 💀 Executing DELETE query to Supabase for: ${promptId} `);
                const { error } = await this.supabase
                    .from('prompts')
                    .delete()
                    .eq('id', promptId)
                    .eq('user_id', this.currentUser.id);

                if (error) throw error;
                console.log(`AI ChatWorks: ✓ DELETE completed for prompt: ${promptId} `);
            } catch (error) {
                console.error(`AI ChatWorks: ✗ DELETE failed for prompt ${promptId}: `, error.message, error);
            }
        }

        /**
         * Track prompt usage in cloud
         */
        async trackUsage(promptId, promptName, platform) {
            if (!this.currentUser || !this.isOnline) return;

            try {
                const { error } = await this.supabase
                    .from('usage_history')
                    .insert({
                        user_id: this.currentUser.id,
                        prompt_id: promptId,
                        prompt_name: promptName,
                        platform: platform,
                        used_at: new Date().toISOString()
                    });

                if (error) throw error;
            } catch (error) {
                console.warn('AI ChatWorks: Failed to track usage:', error.message);
            }
        }

        /**
         * Upsert folder (insert or update)
         */
        async upsertFolder(cloudFolder) {
            if (!this.supabase) {
                throw new Error('Supabase client not initialized');
            }
            if (!this.currentUser) {
                throw new Error('User not authenticated');
            }

            const { error } = await this.supabase
                .from('folders')
                .upsert(cloudFolder, {
                    onConflict: 'id'
                });

            if (error) throw error;
        }

        /**
         * Upsert prompt (insert or update)
         */
        async upsertPrompt(cloudPrompt) {
            if (!this.supabase) {
                throw new Error('Supabase client not initialized');
            }
            if (!this.currentUser) {
                throw new Error('User not authenticated');
            }

            // DIAGNOSTIC: Log call stack to identify where REST POST originates
            const callStack = new Error().stack?.split('\n').slice(2, 7).join('\n    ') || 'unknown';
            console.log(`AI ChatWorks: 🟢 upsertPrompt() - Making POST request for: ${cloudPrompt.name || cloudPrompt.id} `);
            console.log(`   Call stack: \n    ${callStack} `);

            const { error } = await this.supabase
                .from('prompts')
                .upsert(cloudPrompt, {
                    onConflict: 'id'
                });

            if (error) throw error;
            console.log(`AI ChatWorks: ✓ POST completed for prompt: ${cloudPrompt.name || cloudPrompt.id} `);
        }

        /**
         * Batch upsert folders (insert or update multiple in one request)
         * PERFORMANCE OPTIMIZATION: Reduces N requests to 1 request
         */
        async batchUpsertFolders(cloudFolders) {
            if (!this.supabase) {
                throw new Error('Supabase client not initialized');
            }
            if (!this.currentUser) {
                throw new Error('User not authenticated');
            }
            if (!Array.isArray(cloudFolders) || cloudFolders.length === 0) {
                return; // Nothing to upsert
            }

            const { error } = await this.supabase
                .from('folders')
                .upsert(cloudFolders, {
                    onConflict: 'id'
                });

            if (error) throw error;
        }

        /**
         * Batch upsert prompts (insert or update multiple in one request)
         * PERFORMANCE OPTIMIZATION: Reduces N requests to 1 request
         */
        async batchUpsertPrompts(cloudPrompts) {
            if (!this.supabase) {
                throw new Error('Supabase client not initialized');
            }
            if (!this.currentUser) {
                throw new Error('User not authenticated');
            }
            if (!Array.isArray(cloudPrompts) || cloudPrompts.length === 0) {
                return; // Nothing to upsert
            }

            const { error } = await this.supabase
                .from('prompts')
                .upsert(cloudPrompts, {
                    onConflict: 'id'
                });

            if (error) throw error;
        }

        /**
         * Convert local folder format to cloud format
         */
        localToCloudFolder(localFolder) {
            return {
                id: localFolder.id,
                user_id: this.currentUser.id,
                name: localFolder.name,
                color: localFolder.color || '#3b82f6',
                icon: localFolder.icon || null,
                description: localFolder.description || null,
                position: localFolder.position || 0,
                created_at: localFolder.createdAt || new Date().toISOString(),
                updated_at: localFolder.updatedAt || new Date().toISOString()
            };
        }

        /**
         * Convert cloud folder format to local format
         */
        cloudToLocalFolder(cloudFolder) {
            return {
                id: cloudFolder.id,
                name: cloudFolder.name,
                color: cloudFolder.color,
                icon: cloudFolder.icon,
                description: cloudFolder.description,
                position: cloudFolder.position,
                createdAt: cloudFolder.created_at,
                updatedAt: cloudFolder.updated_at
            };
        }

        /**
         * Convert local prompt format to cloud format
         */
        localToCloudPrompt(localPrompt) {
            return {
                id: localPrompt.id,
                user_id: this.currentUser.id,
                folder_id: localPrompt.folder || null,
                name: localPrompt.name,
                content: localPrompt.content,
                description: localPrompt.description || null,
                is_favorite: localPrompt.isFavorite || false,
                tags: localPrompt.tags || [],
                position: localPrompt.position || 0,
                created_at: localPrompt.createdAt || new Date().toISOString(),
                updated_at: localPrompt.updatedAt || new Date().toISOString()
            };
        }

        /**
         * Convert cloud prompt format to local format
         */
        cloudToLocalPrompt(cloudPrompt) {
            return {
                id: cloudPrompt.id,
                folder: cloudPrompt.folder_id,
                name: cloudPrompt.name,
                content: cloudPrompt.content,
                description: cloudPrompt.description,
                isFavorite: cloudPrompt.is_favorite,
                tags: cloudPrompt.tags || [],
                position: cloudPrompt.position,
                createdAt: cloudPrompt.created_at,
                updatedAt: cloudPrompt.updated_at
            };
        }

        /**
         * Subscribe to realtime changes (RTL - Real-Time Listening)
         */
        subscribeToRealtimeChanges() {
            if (!this.supabase || !this.currentUser) {
                console.warn('AI ChatWorks: ⚠️ Cannot subscribe to realtime - missing supabase or user');
                return;
            }

            console.log('AI ChatWorks: 📡 Subscribing to realtime changes for user:', this.currentUser.id);

            // Clear any existing reconnection timers
            if (this.foldersReconnectTimer) clearTimeout(this.foldersReconnectTimer);
            if (this.promptsReconnectTimer) clearTimeout(this.promptsReconnectTimer);

            // Subscribe to folders changes
            this.foldersSubscription = this.supabase
                .channel('folders_changes', {
                    config: {
                        broadcast: { self: false },
                        presence: { key: '' }
                    }
                })
                .on(
                    'postgres_changes',
                    {
                        event: '*',
                        schema: 'public',
                        table: 'folders',
                        filter: `user_id = eq.${this.currentUser.id} `
                    },
                    (payload) => this.handleRealtimeFolderChange(payload)
                )
                .subscribe((status, err) => {
                    if (status === 'SUBSCRIBED') {
                        console.log('AI ChatWorks: Folders realtime ACTIVE');
                        if (this.foldersReconnectTimer) clearTimeout(this.foldersReconnectTimer);
                    } else if (status === 'CHANNEL_ERROR') {
                        // Only log reconnection attempts in debug mode
                        if (window.AI_ChatWorks_is_Debug_Mode) {
                            console.warn('AI ChatWorks: Folders realtime FAILED - will reconnect in 30s');
                        }
                        this.foldersReconnectTimer = setTimeout(() => {
                            this.reconnectFoldersSubscription();
                        }, 30000);
                    } else if (status === 'TIMED_OUT') {
                        // Only log reconnection attempts in debug mode
                        if (window.AI_ChatWorks_is_Debug_Mode) {
                            console.warn('AI ChatWorks: Folders realtime TIMED OUT - will reconnect in 10s');
                        }
                        this.foldersReconnectTimer = setTimeout(() => {
                            this.reconnectFoldersSubscription();
                        }, 10000);
                    } else if (status === 'CLOSED') {
                        if (!this.currentUser) {
                            // User signed out - no reconnection
                            return;
                        }
                        // Silently reconnect after CLOSED - this is normal during network changes
                        this.foldersReconnectTimer = setTimeout(() => {
                            this.reconnectFoldersSubscription();
                        }, 15000);
                    }
                });

            // Subscribe to prompts changes
            this.promptsSubscription = this.supabase
                .channel('prompts_changes', {
                    config: {
                        broadcast: { self: false },
                        presence: { key: '' }
                    }
                })
                .on(
                    'postgres_changes',
                    {
                        event: '*',
                        schema: 'public',
                        table: 'prompts',
                        filter: `user_id = eq.${this.currentUser.id} `
                    },
                    (payload) => this.handleRealtimePromptChange(payload)
                )
                .subscribe((status, err) => {
                    if (status === 'SUBSCRIBED') {
                        console.log('AI ChatWorks: Prompts realtime ACTIVE');
                        if (this.promptsReconnectTimer) clearTimeout(this.promptsReconnectTimer);
                    } else if (status === 'CHANNEL_ERROR') {
                        // Only log reconnection attempts in debug mode
                        if (window.AI_ChatWorks_is_Debug_Mode) {
                            console.warn('AI ChatWorks: Prompts realtime FAILED - will reconnect in 30s');
                        }
                        this.promptsReconnectTimer = setTimeout(() => {
                            this.reconnectPromptsSubscription();
                        }, 30000);
                    } else if (status === 'TIMED_OUT') {
                        // Only log reconnection attempts in debug mode
                        if (window.AI_ChatWorks_is_Debug_Mode) {
                            console.warn('AI ChatWorks: Prompts realtime TIMED OUT - will reconnect in 10s');
                        }
                        this.promptsReconnectTimer = setTimeout(() => {
                            this.reconnectPromptsSubscription();
                        }, 10000);
                    } else if (status === 'CLOSED') {
                        if (!this.currentUser) {
                            // User signed out - no reconnection
                            return;
                        }
                        // Silently reconnect after CLOSED - this is normal during network changes
                        this.promptsReconnectTimer = setTimeout(() => {
                            this.reconnectPromptsSubscription();
                        }, 15000);
                    }
                });

            console.log('AI ChatWorks: 📡 Realtime subscriptions initiated (waiting for confirmation)');
        }

        /**
         * Reconnect folders realtime subscription
         */
        reconnectFoldersSubscription() {
            if (!this.currentUser || !this.supabase) {
                // Silently return - user signed out or not initialized
                return;
            }

            console.log('AI ChatWorks: Reconnecting folders subscription...');

            // Unsubscribe old channel
            if (this.foldersSubscription) {
                try {
                    this.foldersSubscription.unsubscribe();
                } catch (e) {
                    console.warn('AI ChatWorks: Error unsubscribing old folders channel:', e);
                }
            }

            // Resubscribe (will use the logic in subscribeToRealtimeChanges for folders only)
            this.foldersSubscription = this.supabase
                .channel(`folders_changes_${Date.now()} `, {  // Unique channel name for reconnection
                    config: {
                        broadcast: { self: false },
                        presence: { key: '' }
                    }
                })
                .on(
                    'postgres_changes',
                    {
                        event: '*',
                        schema: 'public',
                        table: 'folders',
                        filter: `user_id = eq.${this.currentUser.id} `
                    },
                    (payload) => this.handleRealtimeFolderChange(payload)
                )
                .subscribe((status, err) => {
                    if (window.AI_ChatWorks_is_Debug_Mode) {
                        console.log('AI ChatWorks: 📡 Folders reconnection status:', status);
                    }
                    if (status === 'SUBSCRIBED') {
                        console.log('AI ChatWorks: ✅ Folders realtime reconnected successfully');
                    } else if (status !== 'SUBSCRIBED') {
                        if (window.AI_ChatWorks_is_Debug_Mode) {
                            console.error('AI ChatWorks: ❌ Folders reconnection failed:', status, err);
                        }
                    }
                });
        }

        /**
         * Reconnect prompts realtime subscription
         */
        reconnectPromptsSubscription() {
            if (!this.currentUser || !this.supabase) {
                // Silently return - user signed out or not initialized
                return;
            }

            console.log('AI ChatWorks: Reconnecting prompts subscription...');

            // Unsubscribe old channel
            if (this.promptsSubscription) {
                try {
                    this.promptsSubscription.unsubscribe();
                } catch (e) {
                    console.warn('AI ChatWorks: Error unsubscribing old prompts channel:', e);
                }
            }

            // Resubscribe (will use the logic in subscribeToRealtimeChanges for prompts only)
            this.promptsSubscription = this.supabase
                .channel(`prompts_changes_${Date.now()} `, {  // Unique channel name for reconnection
                    config: {
                        broadcast: { self: false },
                        presence: { key: '' }
                    }
                })
                .on(
                    'postgres_changes',
                    {
                        event: '*',
                        schema: 'public',
                        table: 'prompts',
                        filter: `user_id = eq.${this.currentUser.id} `
                    },
                    (payload) => this.handleRealtimePromptChange(payload)
                )
                .subscribe((status, err) => {
                    if (window.AI_ChatWorks_is_Debug_Mode) {
                        console.log('AI ChatWorks: 📡 Prompts reconnection status:', status);
                    }
                    if (status === 'SUBSCRIBED') {
                        console.log('AI ChatWorks: ✅ Prompts realtime reconnected successfully');
                    } else if (status !== 'SUBSCRIBED') {
                        if (window.AI_ChatWorks_is_Debug_Mode) {
                            console.error('AI ChatWorks: ❌ Prompts reconnection failed:', status, err);
                        }
                    }
                });
        }

        /**
         * Unsubscribe from realtime changes
         */
        unsubscribeFromRealtimeChanges() {
            let unsubscribed = false;

            // Clear reconnection timers
            if (this.foldersReconnectTimer) {
                clearTimeout(this.foldersReconnectTimer);
                this.foldersReconnectTimer = null;
            }
            if (this.promptsReconnectTimer) {
                clearTimeout(this.promptsReconnectTimer);
                this.promptsReconnectTimer = null;
            }

            if (this.foldersSubscription) {
                this.foldersSubscription.unsubscribe();
                this.foldersSubscription = null;
                console.log('AI ChatWorks: 🔌 Unsubscribed from folders realtime');
                unsubscribed = true;
            }
            if (this.promptsSubscription) {
                this.promptsSubscription.unsubscribe();
                this.promptsSubscription = null;
                console.log('AI ChatWorks: 🔌 Unsubscribed from prompts realtime');
                unsubscribed = true;
            }

            if (unsubscribed) {
                console.log('AI ChatWorks: 🔌 All realtime subscriptions and reconnection timers cleared');
            } else {
                console.log('AI ChatWorks: 🔌 No active subscriptions to unsubscribe');
            }
        }

        /**
         * Handle realtime folder change
         */
        async handleRealtimeFolderChange(payload) {
            console.log('AI ChatWorks: Realtime folder change:', payload.eventType, payload.old?.id || payload.new?.id);

            const dbManager = window.AI_ChatWorks_IndexedDBManager;
            if (!dbManager) {
                console.warn('AI ChatWorks: Cannot handle realtime folder change - IndexedDB manager not available');
                return;
            }

            try {
                switch (payload.eventType) {
                    case 'INSERT':
                    case 'UPDATE':
                        const localFolder = this.cloudToLocalFolder(payload.new);
                        console.log('AI ChatWorks: Applying realtime folder INSERT/UPDATE to local storage:', localFolder.id);
                        // CRITICAL: Pass fromRealtime flag to prevent sync loop
                        await dbManager.put('folders', localFolder, { fromRealtime: true });
                        break;
                    case 'DELETE':
                        console.log('AI ChatWorks: Applying realtime folder DELETE to local storage:', payload.old.id);
                        // CRITICAL: Pass fromRealtime flag to prevent sync loop
                        await dbManager.delete('folders', payload.old.id, { fromRealtime: true });
                        console.log('AI ChatWorks: ✓ Folder deleted from local storage via realtime:', payload.old.id);
                        break;
                }

                // PERFORMANCE FIX: Debounced UI refresh instead of immediate
                // This prevents 18 refreshes when batch uploading 20 prompts + 5 folders
                this.scheduleRealtimeUIRefresh();
            } catch (error) {
                console.error('AI ChatWorks: Failed to handle realtime folder change:', error);
            }
        }

        /**
         * Handle realtime prompt change
         */
        async handleRealtimePromptChange(payload) {
            console.log('AI ChatWorks: 🔴 Realtime prompt change received:', payload.eventType, payload.old?.id || payload.new?.id);

            const dbManager = window.AI_ChatWorks_IndexedDBManager;
            if (!dbManager) {
                console.warn('AI ChatWorks: Cannot handle realtime prompt change - IndexedDB manager not available');
                return;
            }

            try {
                switch (payload.eventType) {
                    case 'INSERT':
                    case 'UPDATE':
                        const localPrompt = this.cloudToLocalPrompt(payload.new);
                        console.log('AI ChatWorks: Applying realtime prompt INSERT/UPDATE to local storage:', localPrompt.id);
                        console.log('   📥 RECEIVING from websocket - fromRealtime: true (no POST back to cloud)');
                        // CRITICAL: Pass fromRealtime flag to prevent sync loop
                        await dbManager.put('prompts', localPrompt, { fromRealtime: true });
                        break;
                    case 'DELETE':
                        console.log('AI ChatWorks: Applying realtime prompt DELETE to local storage:', payload.old.id);
                        console.log('   📥 RECEIVING from websocket - fromRealtime: true (no POST back to cloud)');
                        // CRITICAL: Pass fromRealtime flag to prevent sync loop
                        await dbManager.delete('prompts', payload.old.id, { fromRealtime: true });
                        console.log('AI ChatWorks: ✓ Prompt deleted from local storage via realtime:', payload.old.id);
                        break;
                }

                // PERFORMANCE FIX: Debounced UI refresh instead of immediate
                // This prevents 18 refreshes when batch uploading 20 prompts + 5 folders
                this.scheduleRealtimeUIRefresh();
            } catch (error) {
                console.error('AI ChatWorks: Failed to handle realtime prompt change:', error);
            }
        }

        /**
         * Schedule debounced UI refresh for realtime updates
         * PERFORMANCE OPTIMIZATION: Prevents UI refresh storm when receiving batch updates
         * Example: 20 prompts uploaded = 20 realtime events, but only 1 UI refresh after 500ms
         */
        scheduleRealtimeUIRefresh() {
            // Clear existing timer if any
            if (this.realtimeRefreshTimer) {
                clearTimeout(this.realtimeRefreshTimer);
            }

            // Schedule new refresh after debounce period
            this.realtimeRefreshTimer = setTimeout(() => {
                console.log('AI ChatWorks: Executing debounced realtime UI refresh');

                // Force reload from IndexedDB
                if (window.AI_ChatWorks_PromptLibraryManager) {
                    window.AI_ChatWorks_PromptLibraryManager.loadData({ force: true });
                }

                // Also trigger UI refresh if prompt UI is active
                if (window.AI_ChatWorks_PromptUIManager?.refresh) {
                    window.AI_ChatWorks_PromptUIManager.refresh();
                }

                // Dispatch data updated event for other components
                this.triggerUIRefresh();

                this.realtimeRefreshTimer = null;
            }, this.REALTIME_REFRESH_DEBOUNCE_MS);
        }

        /**
         * Save settings to cloud
         * @param {Object} settings - Settings object to save
         * @param {Object} options - Options for save operation
         * @param {boolean} options.skipLeadershipCheck - Skip leadership verification (for sign-out sync)
         * @param {boolean} options.isUserInitiated - User-initiated changes always sync regardless of leadership
         * @returns {Promise<Object>} Save result
         */
        async saveSettingsToCloud(settings, options = {}) {
            try {
                if (!this.supabase || !this.currentUser) {
                    return { success: false, error: 'Not authenticated' };
                }

                // CRITICAL: User-initiated changes ALWAYS sync to cloud (avatar, zoom, theme, etc.)
                // Only automatic/periodic background syncs respect leader election
                if (!options.skipLeadershipCheck && !options.isUserInitiated) {
                    const isLeader = await this.verifyLeadershipForSync();
                    if (!isLeader) {
                        console.log('AI ChatWorks: Skipping auto settings save to cloud (not leader)');
                        return { success: true, skipped: true };
                    }
                }

                console.log('AI ChatWorks: Saving settings to cloud...');

                // Prepare settings data for cloud storage
                // Note: settings-manager may send user_avatar_id, map to avatar_id
                const settingsData = {
                    theme: settings.theme || 'light',
                    panel_position: settings.panel_position || 'pos-bottom-right',
                    debug_mode: settings.debug_mode || false,
                    card_layout: settings.card_layout || 'compact',
                    language: settings.language || 'en',
                    export_enabled: settings.export_enabled !== false,
                    export_formats: settings.export_formats || { markdown: true, text: true, json: false, csv: false },
                    export_format_order: settings.export_format_order || ['markdown', 'text', 'json', 'csv'],
                    site_settings: settings.site_settings || {},
                    avatar_id: settings.avatar_id || settings.user_avatar_id || null,  // Accept both keys
                    library_zoom: settings.library_zoom || 100,
                    timeline_enabled: settings.timeline_enabled !== false, // Default to true if undefined
                    flow_settings: settings.flow_settings || null
                };

                // Use upsert to insert or update settings
                const { data, error } = await this.supabase
                    .from('user_settings')
                    .upsert({
                        user_id: this.currentUser.id,
                        settings_data: settingsData,
                        updated_at: new Date().toISOString()
                    }, {
                        onConflict: 'user_id'
                    })
                    .select()
                    .single();

                if (error) {
                    console.error('AI ChatWorks: Failed to save settings:', error);
                    return { success: false, error: error.message };
                }

                console.log('AI ChatWorks: ✓ Settings saved to cloud successfully');
                this.pendingSettingsSync = false; // Clear pending flag on success
                return { success: true, data };

            } catch (error) {
                console.error('AI ChatWorks: Error saving settings to cloud:', error);
                this.pendingSettingsSync = true; // Mark for retry when online
                return { success: false, error: error.message };
            }
        }

        /**
         * Load settings from cloud
         * @returns {Promise<Object>} Load result with settings data
         */
        async loadSettingsFromCloud() {
            try {
                if (!this.supabase || !this.currentUser) {
                    return { success: false, error: 'Not authenticated' };
                }

                console.log('AI ChatWorks: Loading settings from cloud...');

                const { data, error } = await this.supabase
                    .from('user_settings')
                    .select('*')
                    .eq('user_id', this.currentUser.id)
                    .single();

                if (error) {
                    // If no settings found, that's okay - user hasn't saved settings yet
                    if (error.code === 'PGRST116') {
                        console.log('AI ChatWorks: No cloud settings found (first time user)');
                        return { success: true, data: null, isFirstTime: true };
                    }

                    console.error('AI ChatWorks: Failed to load settings:', error);
                    return { success: false, error: error.message };
                }

                console.log('AI ChatWorks: ✓ Settings loaded from cloud successfully');
                return { success: true, data: data.settings_data, cloudTimestamp: data.updated_at };

            } catch (error) {
                console.error('AI ChatWorks: Error loading settings from cloud:', error);
                return { success: false, error: error.message };
            }
        }

        /**
         * Sync pending settings changes made while offline
         * Called when connection is restored
         */
        async syncPendingSettings() {
            if (!this.pendingSettingsSync || !this.isOnline || !this.currentUser) {
                return;
            }

            try {
                // Use SettingsManager to gather and sync all current settings
                const SettingsManager = window.AI_ChatWorks_SettingsManager;
                if (SettingsManager?.saveSettingsToCloud) {
                    await SettingsManager.saveSettingsToCloud();
                    console.log('AI ChatWorks: ✓ Pending settings synced to cloud');
                }
            } catch (error) {
                console.warn('AI ChatWorks: Failed to sync pending settings:', error);
            }
        }

        /**
         * Sync settings (download from cloud, cloud always wins after sign-in)
         * @param {Object} localSettings - Current local settings (used as fallback only)
         * @returns {Promise<Object>} Sync result with merged settings
         */
        async syncSettings(localSettings, isNewAccount = false) {
            try {
                if (!this.supabase || !this.currentUser) {
                    return { success: false, error: 'Not authenticated' };
                }

                console.log(`AI ChatWorks: Syncing settings(${isNewAccount ? 'upload local to cloud' : 'cloud wins'})...`);

                // Load settings from cloud
                const cloudResult = await this.loadSettingsFromCloud();

                // If NEW account (empty cloud), UPLOAD local settings to cloud
                // This preserves the user's offline work when they create an account
                if (cloudResult.isFirstTime && isNewAccount) {
                    console.log('AI ChatWorks: New account - uploading local settings to cloud...');
                    // Upload local settings to cloud
                    const uploadResult = await this.saveSettingsToCloud(localSettings);
                    if (uploadResult.success) {
                        console.log('AI ChatWorks: ✓ Local settings uploaded to cloud successfully');
                    }
                    return {
                        success: true,
                        merged: localSettings,
                        action: 'uploaded_to_cloud'
                    };
                }

                // If first time user on EXISTING account (no cloud settings but not new account)
                // Keep local settings but DON'T upload - this prevents defaults from overwriting cloud
                if (cloudResult.isFirstTime && !isNewAccount) {
                    console.log('AI ChatWorks: No cloud settings found - keeping local settings');
                    return {
                        success: true,
                        merged: localSettings,
                        action: 'kept_local'
                    };
                }

                if (!cloudResult.success) {
                    console.warn('AI ChatWorks: Cloud settings load failed, keeping local');
                    return {
                        success: true,
                        merged: localSettings,
                        action: 'kept_local_on_error'
                    };
                }

                const cloudSettings = cloudResult.data;

                // CLOUD WINS: Use cloud settings, fall back to local for missing values
                const merged = {
                    ...localSettings,   // Local as base (for any missing cloud values)
                    ...cloudSettings    // Cloud overwrites
                };

                console.log('AI ChatWorks: ✓ Settings synced successfully (cloud applied)');
                return {
                    success: true,
                    merged,
                    cloudTimestamp: cloudResult.cloudTimestamp,
                    action: 'cloud_applied'
                };

            } catch (error) {
                console.error('AI ChatWorks: Error syncing settings:', error);
                return { success: false, error: error.message };
            }
        }

        /**
         * Load settings from cloud and apply them to local storage
         * This is called after successful sign-in to sync settings across devices
         * @param {boolean} isNewAccount - If true, upload local settings to cloud; if false, cloud wins
         * @returns {Promise<Object>} Result of loading and applying settings
         */
        async loadAndApplyCloudSettings(isNewAccount = false) {
            try {
                console.log('AI ChatWorks: Loading settings from cloud...');

                // Get current local settings first
                const CONSTANTS = window.AI_ChatWorks_Constants;
                if (!CONSTANTS) {
                    console.warn('AI ChatWorks: Constants not available, skipping settings sync');
                    return { success: false, error: 'Constants not loaded' };
                }

                const keys = [
                    CONSTANTS.STORAGE_KEYS.THEME,
                    CONSTANTS.STORAGE_KEYS.PANEL_POSITION,
                    CONSTANTS.STORAGE_KEYS.DEBUG_MODE,
                    CONSTANTS.STORAGE_KEYS.CARD_LAYOUT,
                    CONSTANTS.STORAGE_KEYS.LANGUAGE,
                    CONSTANTS.STORAGE_KEYS.EXPORT_ENABLED,
                    CONSTANTS.STORAGE_KEYS.EXPORT_FORMATS,
                    CONSTANTS.STORAGE_KEYS.EXPORT_FORMAT_ORDER,
                    CONSTANTS.STORAGE_KEYS.ALL_SITES,
                    CONSTANTS.STORAGE_KEYS.LIBRARY_ZOOM
                ];

                return new Promise((resolve) => {
                    chrome.storage.sync.get(keys, async (localResult) => {
                        // CRITICAL FIX: Get avatar from local storage (avatars use chrome.storage.local)
                        const localStorageResult = await chrome.storage.local.get('user_avatar_id');

                        const localSettings = {
                            theme: localResult[CONSTANTS.STORAGE_KEYS.THEME],
                            panel_position: localResult[CONSTANTS.STORAGE_KEYS.PANEL_POSITION],
                            debug_mode: localResult[CONSTANTS.STORAGE_KEYS.DEBUG_MODE],
                            card_layout: localResult[CONSTANTS.STORAGE_KEYS.CARD_LAYOUT],
                            language: localResult[CONSTANTS.STORAGE_KEYS.LANGUAGE],
                            export_enabled: localResult[CONSTANTS.STORAGE_KEYS.EXPORT_ENABLED],
                            export_formats: localResult[CONSTANTS.STORAGE_KEYS.EXPORT_FORMATS],
                            export_format_order: localResult[CONSTANTS.STORAGE_KEYS.EXPORT_FORMAT_ORDER],
                            site_settings: localResult[CONSTANTS.STORAGE_KEYS.ALL_SITES],
                            avatar_id: localStorageResult.user_avatar_id || null,  // CRITICAL FIX: Include avatar
                            library_zoom: localResult[CONSTANTS.STORAGE_KEYS.LIBRARY_ZOOM] || 100
                        };

                        // Sync with cloud
                        const syncResult = await this.syncSettings(localSettings, isNewAccount);

                        if (!syncResult.success) {
                            console.warn('AI ChatWorks: Settings sync failed:', syncResult.error);
                            resolve(syncResult);
                            return;
                        }

                        // Apply merged settings to local storage
                        const merged = syncResult.merged;
                        const toSave = {};

                        if (merged.theme) toSave[CONSTANTS.STORAGE_KEYS.THEME] = merged.theme;
                        if (merged.panel_position) toSave[CONSTANTS.STORAGE_KEYS.PANEL_POSITION] = merged.panel_position;
                        if (merged.debug_mode !== undefined) toSave[CONSTANTS.STORAGE_KEYS.DEBUG_MODE] = merged.debug_mode;
                        if (merged.card_layout) toSave[CONSTANTS.STORAGE_KEYS.CARD_LAYOUT] = merged.card_layout;
                        if (merged.language) toSave[CONSTANTS.STORAGE_KEYS.LANGUAGE] = merged.language;
                        if (merged.export_enabled !== undefined) toSave[CONSTANTS.STORAGE_KEYS.EXPORT_ENABLED] = merged.export_enabled;
                        if (merged.export_formats) toSave[CONSTANTS.STORAGE_KEYS.EXPORT_FORMATS] = merged.export_formats;
                        if (merged.export_format_order) toSave[CONSTANTS.STORAGE_KEYS.EXPORT_FORMAT_ORDER] = merged.export_format_order;
                        if (merged.site_settings) toSave[CONSTANTS.STORAGE_KEYS.ALL_SITES] = merged.site_settings;
                        if (merged.library_zoom) toSave[CONSTANTS.STORAGE_KEYS.LIBRARY_ZOOM] = merged.library_zoom;

                        // CRITICAL FIX: Save avatar to local storage (avatars use chrome.storage.local)
                        if (merged.avatar_id) {
                            await chrome.storage.local.set({ user_avatar_id: merged.avatar_id });
                            console.log('AI ChatWorks: ✓ Avatar synced from cloud:', merged.avatar_id);
                        }

                        chrome.storage.sync.set(toSave, () => {
                            if (chrome.runtime.lastError) {
                                console.error('AI ChatWorks: Error saving merged settings:', chrome.runtime.lastError);
                                resolve({ success: false, error: chrome.runtime.lastError.message });
                            } else {
                                console.log('AI ChatWorks: ✓ Settings synced and applied successfully');

                                // CRITICAL: Apply visual effects after settings are saved
                                // Apply library zoom
                                if (merged.library_zoom && window.AI_ChatWorks_SettingsManager?.applyLibraryZoom) {
                                    window.AI_ChatWorks_SettingsManager.applyLibraryZoom(merged.library_zoom);
                                    console.log('AI ChatWorks: ✓ Library zoom applied:', merged.library_zoom);
                                }

                                // Apply theme
                                if (merged.theme && window.AI_ChatWorks_Utils?.ThemeManager?.applyTheme) {
                                    window.AI_ChatWorks_Utils.ThemeManager.applyTheme(merged.theme);
                                    console.log('AI ChatWorks: ✓ Theme applied:', merged.theme);
                                }

                                // Update avatar display
                                if (merged.avatar_id) {
                                    const Avatars = window.AI_ChatWorks_Avatars;
                                    if (Avatars && Avatars.render) {
                                        const avatar = Avatars.getById(merged.avatar_id);
                                        if (avatar) {
                                            // Update main avatar button
                                            const mainAvatarBtn = document.querySelector('#user-avatar-btn');
                                            if (mainAvatarBtn) {
                                                mainAvatarBtn.innerHTML = Avatars.render(avatar, 32);
                                            }
                                            console.log('AI ChatWorks: ✓ Avatar display updated:', avatar.name);
                                        }
                                    }
                                }

                                resolve({ success: true, action: syncResult.action });
                            }
                        });
                    });
                });

            } catch (error) {
                console.error('AI ChatWorks: Error loading and applying cloud settings:', error);
                return { success: false, error: error.message };
            }
        }

        /**
         * Get last sync time
         */
        getLastSyncTime() {
            return this.lastSyncTime;
        }

        /**
         * Check if user is authenticated
         */
        isAuthenticated() {
            return !!this.currentUser;
        }

        /**
         * Get current user
         */
        getCurrentUser() {
            return this.currentUser;
        }

        /**
         * Get sync status
         */
        getSyncStatus() {
            return {
                authenticated: this.isAuthenticated(),
                online: this.isOnline,
                syncing: this.isSyncing,
                lastSync: this.lastSyncTime,
                autoSyncEnabled: !!this.autoSyncInterval,
                isLeader: this.isLeader,
                tabId: this.tabId
            };
        }

        /**
         * Leader Election Methods
         * Only one tab should sync to cloud to prevent sync storms
         */

        /**
         * Initialize leader election (called once during init)
         */
        async initLeaderElection() {
            try {
                console.log('AI ChatWorks: Initializing leader election for tab:', this.tabId);

                // Try to become leader immediately (AWAIT THIS!)
                await this.tryBecomeLeader();

                // Mark leader election as ready
                this.leaderReady = true;

                // Start periodic heartbeat check
                this.leaderCheckInterval = setInterval(() => {
                    this.checkLeaderStatus();
                }, this.LEADER_HEARTBEAT_INTERVAL);

                console.log('AI ChatWorks: Leader election initialized. isLeader:', this.isLeader);
            } catch (error) {
                console.error('AI ChatWorks: Leader election initialization failed:', error);
                // Default to follower mode if election fails
                this.isLeader = false;
                this.leaderReady = true;
            }
        }

        /**
         * Try to become the leader tab
         */
        async tryBecomeLeader() {
            try {
                // Guard: Check extension context is valid
                if (!chrome?.storage?.local) {
                    this.isLeader = false;
                    return;
                }

                // Add small random delay (0-100ms) to reduce race condition likelihood
                await new Promise(resolve => setTimeout(resolve, Math.random() * 100));

                const result = await chrome.storage.local.get(['cloud_sync_leader']);
                const leaderInfo = result.cloud_sync_leader;
                const now = Date.now();

                // Become leader if:
                // 1. No leader exists
                // 2. Current leader's heartbeat is too old (leader died)
                // 3. This tab is already the leader (refresh heartbeat)
                if (!leaderInfo ||
                    (now - leaderInfo.timestamp) > this.LEADER_TIMEOUT ||
                    leaderInfo.tabId === this.tabId) {

                    await this.becomeLeader();
                } else {
                    // We're a follower - only log in debug mode
                    this.isLeader = false;
                    if (window.AI_ChatWorks_is_Debug_Mode) {
                        console.log('AI ChatWorks: This tab is a FOLLOWER. Leader is:', leaderInfo.tabId.substring(0, 20) + '...');
                    }
                }
            } catch (error) {
                // Only log errors in debug mode
                if (window.AI_ChatWorks_is_Debug_Mode) {
                    console.warn('AI ChatWorks: Error in tryBecomeLeader:', error);
                }
                this.isLeader = false; // Default to follower on error
            }
        }

        /**
         * Become the leader tab
         */
        async becomeLeader() {
            try {
                const wasLeader = this.isLeader;

                // Write ourselves as leader
                await chrome.storage.local.set({
                    cloud_sync_leader: {
                        tabId: this.tabId,
                        timestamp: Date.now()
                    }
                });

                // CRITICAL: Verify we're actually the leader (handles race conditions)
                // Another tab might have written simultaneously
                await new Promise(resolve => setTimeout(resolve, 50)); // Small delay
                const verification = await chrome.storage.local.get(['cloud_sync_leader']);
                const currentLeader = verification.cloud_sync_leader;

                if (currentLeader && currentLeader.tabId === this.tabId) {
                    this.isLeader = true;
                    if (!wasLeader) {
                        console.log('AI ChatWorks: 👑 This tab is now the LEADER for cloud sync');
                    }
                } else {
                    // Another tab became leader instead
                    this.isLeader = false;
                    console.log('AI ChatWorks: Lost leadership race to:', currentLeader?.tabId?.substring(0, 20) + '...');
                }
            } catch (error) {
                console.error('AI ChatWorks: Error becoming leader:', error);
                this.isLeader = false;
            }
        }

        /**
         * Release leadership (called when tab closes)
         */
        async releaseLeadership() {
            if (!this.isLeader) return;

            try {
                // Check if extension context is still valid
                if (!chrome?.runtime?.id) {
                    // Extension context invalidated - silently exit
                    return;
                }

                const result = await chrome.storage.local.get(['cloud_sync_leader']);
                const leaderInfo = result.cloud_sync_leader;

                // Only release if this tab is the current leader
                if (leaderInfo && leaderInfo.tabId === this.tabId) {
                    await chrome.storage.local.remove(['cloud_sync_leader']);
                    if (window.AI_ChatWorks_is_Debug_Mode) {
                        console.log('AI ChatWorks: Released leadership');
                    }
                }

                this.isLeader = false;

                // Stop leader check interval
                if (this.leaderCheckInterval) {
                    clearInterval(this.leaderCheckInterval);
                    this.leaderCheckInterval = null;
                }
            } catch (error) {
                // Silently ignore errors during cleanup - extension context may be invalidated
                // Only log in debug mode for troubleshooting
                if (window.AI_ChatWorks_is_Debug_Mode) {
                    console.warn('AI ChatWorks: Error releasing leadership:', error);
                }
            }
        }

        /**
         * Check leader status and heartbeat
         */
        async checkLeaderStatus() {
            try {
                // Guard: Check extension context is valid
                if (!chrome?.storage?.local) {
                    // Extension context invalid (tab closed, extension reloaded, etc.)
                    // Clear the interval to prevent further errors
                    if (this.leaderCheckInterval) {
                        clearInterval(this.leaderCheckInterval);
                        this.leaderCheckInterval = null;
                    }
                    return;
                }

                if (this.isLeader) {
                    // Refresh heartbeat if we're the leader
                    await chrome.storage.local.set({
                        cloud_sync_leader: {
                            tabId: this.tabId,
                            timestamp: Date.now()
                        }
                    });
                } else {
                    // Try to become leader if current leader is dead
                    await this.tryBecomeLeader();
                }
            } catch (error) {
                // Silently handle errors if extension context is invalid
                // This is expected when tabs are closed or extension is reloaded
                if (error.message?.includes('Extension context invalidated') ||
                    error.message?.includes('message channel closed')) {
                    if (this.leaderCheckInterval) {
                        clearInterval(this.leaderCheckInterval);
                        this.leaderCheckInterval = null;
                    }
                } else {
                    // Log unexpected errors for debugging
                    console.warn('AI ChatWorks: Error checking leader status:', error);
                }
            }
        }

        /**
         * Check if this tab is the leader
         * SYNCHRONOUS check of cached leader status
         * @returns {boolean} True if this tab is the leader
         */
        isLeaderTab() {
            return this.isLeader;
        }

        /**
         * Verify leadership before performing sync operation
         * ASYNCHRONOUS check that validates against storage
         * @returns {Promise<boolean>} True if this tab is verified as leader
         */
        async verifyLeadershipForSync() {
            try {
                // Quick check of cached status first
                if (!this.isLeader) {
                    return false;
                }

                // Verify against storage to handle edge cases
                const result = await chrome.storage.local.get(['cloud_sync_leader']);
                const leaderInfo = result.cloud_sync_leader;
                const now = Date.now();

                // We're the leader if:
                // 1. We're marked as leader in storage AND timestamp is recent
                if (leaderInfo &&
                    leaderInfo.tabId === this.tabId &&
                    (now - leaderInfo.timestamp) <= this.LEADER_TIMEOUT) {
                    return true;
                }

                // We lost leadership
                this.isLeader = false;
                console.log('AI ChatWorks: Lost leadership during verification');
                return false;
            } catch (error) {
                console.warn('AI ChatWorks: Error verifying leadership:', error);
                return false; // Safe default: don't sync if verification fails
            }
        }
    }

    // Make SupabaseManager globally available
    window.AI_ChatWorks_SupabaseManager = new SupabaseManager();

    console.log('AI ChatWorks: Supabase Manager loaded');
})();
