// ============================================
// Xtractor Smart Attendance System - Main Application File
// ============================================

// ====== Basic Variables and Constants ======

// Backend data is served from Firestore through the server proxy.
const STUDENTS_TABLE = 'LEC_1';
const MODE_TABLE = 'MODE'; // Mode control table (ON/OFF and lecture number)
const MODE_RECORD_NAME = 'Website Status'; // Must match the Firestore document name used in MODE collection

// Proxy configuration (empty => same origin)
const API_PROXY_BASE = '';
let protectionCheckInterval = null;
let isWebsiteLocked = false;
let lockMessage = '';
let lockLink = '';

// Runtime traffic is routed through the Firestore proxy only.

// ====== Pre-programmed QR Codes ======
const QR_CODES = {
    qr1: '8CmsmS],lZmK$3%ge_=0].1hf]&o>7D)0c)(y^#cpe<9u!8a<oNUqN6"E1(08Dl5',
    qr2: 't:0+9n"$vf;[/%:xLqn&!sr@c!paHn12}UP02"nKif{a0g@(KXi&sl\\1FUEj.S]1',
    qr3: '!#W"{SeNLOX05@dOGg=^Cxx1z>)bIA2l|<DG8Tn<]_pOV97`CR1zIeBg(iiPvv`>'
};

// Geographic region coordinates (4 points forming a rectangle)
const GEO_BOUNDARIES = [
    { lat: 29.9820791, lng: 31.2336799 }, // الإحداثي العلوي
    { lat: 29.9821587, lng: 31.2335790 }, // الإحداثي الأيسر
    { lat: 29.9816374, lng: 31.2335180 }, // الإحداثي الأيمن
    { lat: 29.9817190, lng: 31.2332451 }  // الإحداثي السفلي
];

// Geographic tolerance constant - approximately 15 meters
const REGION_TOLERANCE = 0.00015;

// State variables
let currentMode = null; // 'student' or 'doctor'
let currentStudentCode = null;
let currentStudentName = null; // To save student name
let currentStudentRecord = null;
// Safe storage wrapper: uses localStorage when available, falls back to in-memory object
const _inMemoryStorage = {};
// Detect localStorage availability once to avoid repeated browser blocking messages
let _localStorageAvailable = false;
function detectLocalStorageAvailability() {
    try {
        const testKey = '__xtractor_storage_test__';
        localStorage.setItem(testKey, '1');
        localStorage.removeItem(testKey);
        _localStorageAvailable = true;
    } catch (e) {
        _localStorageAvailable = false;
    }
}
try { detectLocalStorageAvailability(); } catch (e) { _localStorageAvailable = false; }

const safeStorage = {
    getItem(key) {
        if (_localStorageAvailable) return localStorage.getItem(key);
        return _inMemoryStorage[key] ?? null;
    },
    setItem(key, value) {
        if (_localStorageAvailable) return localStorage.setItem(key, String(value));
        _inMemoryStorage[key] = String(value);
    },
    removeItem(key) {
        if (_localStorageAvailable) return localStorage.removeItem(key);
        delete _inMemoryStorage[key];
    }
};

// If localStorage is unavailable (Tracking Prevention), install safe shim
function installLocalStorageShim() {
    try {
        if (_localStorageAvailable) return;
        // Avoid double-patching
        if (Storage.prototype.__xtractor_shim_installed__) return;

        Storage.prototype.__xtractor_shim_installed__ = true;

        Storage.prototype.getItem = function(key) {
            return _inMemoryStorage[key] ?? null;
        };
        Storage.prototype.setItem = function(key, value) {
            _inMemoryStorage[key] = String(value);
        };
        Storage.prototype.removeItem = function(key) {
            delete _inMemoryStorage[key];
        };
        // Provide key() and length to be minimally compatible
        Storage.prototype.key = function(i) {
            const keys = Object.keys(_inMemoryStorage);
            return keys[i] || null;
        };
        Object.defineProperty(Storage.prototype, 'length', {
            get: function() { return Object.keys(_inMemoryStorage).length; }
        });
    } catch (e) {
        // ignore shim errors
    }
}

// Ensure shim is installed early if storage unavailable
try { if (!_localStorageAvailable) installLocalStorageShim(); } catch (e) {}

// ====== API Request Manager (coalescing + backoff) ======
const _inFlightRequests = new Map();
const _lastCalledAt = new Map();
const _minIntervalFor = new Map();
const _backoffUntil = new Map();
const MODE_CACHE_TTL_MS = 15000;
const LECTURE_REFRESH_MS = 15000;
const LOCATION_WRITE_INTERVAL_MS = 60000;
let modeRecordCache = null;
let lectureStudentsTimer = null;
let lastSavedLocation = null;
let lastLocationWriteAt = 0;

function _normalizeUrlKey(url) {
    return url.split('?')[0];
}

function _defaultMinInterval(url) {
    // MODE table is more sensitive - default higher
    if (url.includes('/' + encodeURIComponent(MODE_TABLE))) return 10000; // 10s for MODE reads
    // Lecture tables and others - slightly lower
    if (/LEC_\d+/.test(url)) return 1500;
    return 1000;
}

async function apiGet(url, config = {}) {
    const key = _normalizeUrlKey(url);

    // If currently backing off for this key, throw a 429-like error immediately
    const blockedUntil = _backoffUntil.get(key) || 0;
    if (Date.now() < blockedUntil) {
        const err = new Error('Client-side backoff - too many requests');
        err.response = { status: 429, data: { error: 'BACKOFF' } };
        throw err;
    }

    // Return existing in-flight promise to coalesce duplicate requests
    if (_inFlightRequests.has(key)) return _inFlightRequests.get(key);

    // Enforce minimum interval between requests
    const minInterval = _minIntervalFor.get(key) || _defaultMinInterval(url);
    const last = _lastCalledAt.get(key) || 0;
    const now = Date.now();
    const waitMs = Math.max(0, minInterval - (now - last));

    const promise = (waitMs > 0 ? new Promise(r => setTimeout(r, waitMs)) : Promise.resolve()).then(() => {
        return axios.get(url, config).then(resp => {
            _lastCalledAt.set(key, Date.now());
            // on success reset any backoff for this key
            _backoffUntil.delete(key);
            // clear in-flight
            _inFlightRequests.delete(key);
            return resp;
        }).catch(err => {
            // mark in-flight cleared
            _inFlightRequests.delete(key);
            const status = err?.response?.status;
            // If unauthorized, set medium backoff and notify
            if (status === 401) {
                const next = 30 * 1000; // 30s backoff for auth failures
                _backoffUntil.set(key, Date.now() + next);
                try { showAlert('❌ Server rejected the data request. Please try again.', 'error'); } catch(e){}
            }
            if (status === 429) {
                // exponential backoff per-key
                const prev = _minIntervalFor.get(key) || _defaultMinInterval(url);
                const next = Math.min(Math.max(prev * 2, 2000), 60000);
                _minIntervalFor.set(key, next);
                _backoffUntil.set(key, Date.now() + next);
                try { window._lastData429 = true; } catch(e){}
            }
            throw err;
        });
    });

    _inFlightRequests.set(key, promise);
    return promise;
}


let currentLectureNumber = safeStorage.getItem('selectedLecture'); // Load from safeStorage
let lectureSelected = safeStorage.getItem('lectureSelected') === 'true'; // Load from safeStorage
let monitoringInterval = null; // 🎯 To monitor Student Mode changes
// Adaptive polling for student mode
const STUDENT_MODE_POLL_BASE_MS = 10000; // 10s base poll interval
let studentModePollMs = STUDENT_MODE_POLL_BASE_MS;
let studentLocation = null;
let qrScanner = null;
let scannedQRs = {
    qr1: false,
    qr2: false,
    qr3: false
};
let isProcessingQR = false; // Prevent concurrent processing
let deviceIP = null; // Device IP address

async function getModeRecord(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && modeRecordCache && now - modeRecordCache.timestamp < MODE_CACHE_TTL_MS) {
        return modeRecordCache.record;
    }

    const response = await apiGet(
        `/api/data/${encodeURIComponent(MODE_TABLE)}`,
        { headers: getDataHeaders() }
    );
    const records = Array.isArray(response?.data?.records) ? response.data.records : [];
    const record = records.find(item => {
        const name = item.fields?.Name || '';
        return name.trim() === MODE_RECORD_NAME.trim();
    }) || (records.length === 1 ? records[0] : null);

    modeRecordCache = { record, timestamp: now };
    return record;
}

function invalidateModeRecordCache() {
    modeRecordCache = null;
}

// ====== Client-side input rate limiter (prevents brute-force and rapid submits)
const RATE_LIMIT_KEY = 'client_rate_limits_v1';

function _loadRateLimits() {
    try {
        return JSON.parse(safeStorage.getItem(RATE_LIMIT_KEY) || '{}');
    } catch (e) { return {}; }
}

function _saveRateLimits(obj) {
    try { safeStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(obj)); } catch (e) { /* ignore */ }
}

/**
 * allowAction - returns true if action allowed, false if blocked.
 * options: { limit: number, windowMs: number, lockMs: number }
 */
function allowAction(actionKey, options = {}) {
    const limits = Object.assign({ limit: 5, windowMs: 60 * 1000, lockMs: 5 * 60 * 1000 }, options);
    const now = Date.now();
    const state = _loadRateLimits();
    const info = state[actionKey] || { count: 0, windowStart: now, lockedUntil: 0 };

    if (info.lockedUntil && now < info.lockedUntil) {
        // still locked
        state[actionKey] = info;
        _saveRateLimits(state);
        return false;
    }

    // reset window if expired
    if (!info.windowStart || now - info.windowStart > limits.windowMs) {
        info.count = 0;
        info.windowStart = now;
    }

    info.count = (info.count || 0) + 1;

    if (info.count > limits.limit) {
        // lock for lockMs
        info.lockedUntil = now + limits.lockMs;
        _saveRateLimits(state);
        state[actionKey] = info;
        _saveRateLimits(state);
        return false;
    }

    state[actionKey] = info;
    _saveRateLimits(state);
    return true;
}

// Utility to get remaining lock time (ms)
function getActionLockRemaining(actionKey) {
    const state = _loadRateLimits();
    const info = state[actionKey];
    if (!info || !info.lockedUntil) return 0;
    const rem = info.lockedUntil - Date.now();
    return rem > 0 ? rem : 0;
}

// Attach data-rate-limit handling: any button with data-rate-key will be auto-protected
document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('button[data-rate-key]');
    if (!btn) return;
    const key = btn.getAttribute('data-rate-key');
    if (!key) return;
    const allowed = allowAction(key, { limit: 6, windowMs: 60 * 1000, lockMs: 5 * 60 * 1000 });
    if (!allowed) {
        e.preventDefault();
        e.stopPropagation();
        const rem = Math.ceil(getActionLockRemaining(key) / 1000);
        showAlert(`Too many attempts. Try again in ${rem} seconds.`, 'error');
    }
}, true);

// ====== Silence informational console output (keep errors visible)
// Set to true to hide console.log/info/warn/debug messages that may leak data
const SILENT_CONSOLE = true;
if (SILENT_CONSOLE) {
    ['log', 'info', 'warn', 'debug'].forEach(fn => { try { console[fn] = function(){}; } catch(e){} });
}

// ====== Auto-protect interactive elements (buttons/forms) by adding data-rate-key
function autoProtectInteractiveElements() {
    try {
        // Buttons: assign key from id/name/onclick or generate one
        const buttons = document.querySelectorAll('button');
        buttons.forEach(btn => {
            if (!btn.getAttribute('data-rate-key')) {
                const onclick = btn.getAttribute('onclick') || '';
                const match = onclick.match(/([a-zA-Z0-9_]+)\s*\(/);
                const key = btn.id || btn.name || (match && match[1]) || `btn_${Math.random().toString(36).slice(2,8)}`;
                btn.setAttribute('data-rate-key', key);
            }
        });

        // Forms: attach submit guard
        const forms = document.querySelectorAll('form');
        forms.forEach(form => {
            const key = form.id || form.name || (`form_${form.action || location.pathname}`);
            form.addEventListener('submit', (ev) => {
                const allowed = allowAction(key, { limit: 6, windowMs: 60 * 1000, lockMs: 5 * 60 * 1000 });
                if (!allowed) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    const rem = Math.ceil(getActionLockRemaining(key) / 1000);
                    showAlert(`Too many attempts. Try again in ${rem} seconds.`, 'error');
                }
            }, { capture: true });
        });
    } catch (e) {
        // Do not leak errors to console if silenced
        try { console.error('autoProtectInteractiveElements error', e); } catch (ignore) {}
    }
}

document.addEventListener('DOMContentLoaded', autoProtectInteractiveElements);

// ====== 🔐 Website Protection System Functions ======


/**
 * 🔐 Read protection settings from Firestore
 * Checks if website is locked or unlocked
 */
async function checkWebsiteProtectionStatus() {
    try {
        console.log('🔐 Checking website protection status via proxy...');

        const resp = await apiGet(`${API_PROXY_BASE}/api/protection`);

        if (!resp || !resp.data) {
            console.warn('⚠️ No response from protection endpoint');
            return false;
        }

        // If proxy returns success structure
        const payload = resp.data;
        const data = payload.data || payload;

        if (!data || !data.records || data.records.length === 0) {
            console.warn('⚠️ Protection table is empty or response invalid');
            return false;
        }

        const protectionRecord = data.records[0];
        const fields = protectionRecord.fields;

        // Use debug level so it doesn't clutter normal console output
        console.debug && console.debug('📊 Protection Record (proxy):', fields);

        const protectionStatus = fields.Select || 'Unlock';
        isWebsiteLocked = protectionStatus === 'Lock';
        lockMessage = fields.Text || 'Website is currently locked';
        lockLink = fields.Link || '';
        console.log(`🔐 Protection Status: ${isWebsiteLocked ? 'LOCKED' : 'UNLOCKED'}`);
        return true;
    } catch (error) {
        // Provide more actionable client-side logs for debugging
        try {
            const details = error?.response?.data || error?.message || error;
            console.error('❌ Error checking protection status (proxy):', details);
            // Show a user-friendly alert when protection cannot be verified
            showAlert('Cannot verify protection settings. Please try again later.', 'error');
        } catch (e) {
            console.error('❌ Error checking protection status (proxy):', error);
        }
        return false;
    }
}

/**
 * 🔐 Check protection status (one-time, no longer continuous)
 * This is now called only at login to save API calls
 */
function checkProtectionStatusAtLogin() {
    return checkWebsiteProtectionStatus();
}

/**
 * 🔐 Stop monitoring Protection table
 */
function stopProtectionMonitoring() {
    if (protectionCheckInterval) {
        clearInterval(protectionCheckInterval);
        protectionCheckInterval = null;
    }
}

/**
 * 🔐 Show website locked screen
 */
function showLockedWebsite() {
    console.log('🔒 Showing locked website screen');
    
    // Hide main content
    document.getElementById('login-section').style.display = 'none';
    document.getElementById('student-section').style.display = 'none';
    document.getElementById('doctor-panel').style.display = 'none';
    document.getElementById('top-bar').style.display = 'none';

    // Show locked screen
    const lockedSection = document.getElementById('locked-section');
    if (lockedSection) {
        lockedSection.style.display = 'block';

        // Update lock message
        const messageEl = document.getElementById('lock-message');
        if (messageEl) {
            messageEl.textContent = lockMessage || 'Website is currently locked';
        }

        // Update lock link if provided
        if (lockLink) {
            const linkContainer = document.getElementById('lock-link-container');
            const linkEl = document.getElementById('lock-link');
            if (linkContainer && linkEl) {
                linkContainer.style.display = 'block';
                linkEl.href = lockLink;
                linkEl.textContent = lockLink;
            }
        } else {
            const linkContainer = document.getElementById('lock-link-container');
            if (linkContainer) {
                linkContainer.style.display = 'none';
            }
        }
    }
}

/**
 * 🔐 Hide website locked screen and show login
 */
function showUnlockedWebsite() {
    console.log('🔓 Showing normal website');
    
    const lockedSection = document.getElementById('locked-section');
    if (lockedSection) {
        lockedSection.style.display = 'none';
    }
    
    // Show normal login interface
    document.getElementById('login-section').style.display = 'block';
}

/**
 * 🔐 Check if website status changed (disabled - was checking every 5 seconds)
 * Protection check now only happens at login to save API calls
 */
function startWebsiteLockMonitoring() {
    // Disabled continuous monitoring to save API calls
    // Protection check now only happens at login time
    console.log('✓ Lock monitoring configured - checks only at login');
}

// ====== وظائف حماية الجهاز (Device IP) ======

/**
 * قراءة المحاضرة المختارة من جدول MODE (والتحقق من أن QR محدد)
 */
async function getSelectedLectureFromMode() {
    try {
        const record = await getModeRecord(true);
        if (!record) {
            console.warn('⚠️ MODE table is empty or the configured record was not found');
            return null;
        }

        const lectureNum = record.fields?.Lecture;
        const studentMode = record.fields?.['Student Mode'];
        const qrSelected = record.fields?.['QR Selected'] || 'NONE';
        if ((studentMode === 'ON' || studentMode === true) && lectureNum && qrSelected !== 'NONE') {
            return parseInt(lectureNum, 10);
        }

        console.warn('⚠️ Student mode is disabled or no lecture/QR is selected');
        return null;
    } catch (error) {
        console.error('❌ خطأ في قراءة جدول MODE:', error);
        if (error.response?.status === 401 || error.response?.status === 403) {
            console.error('❌ خطأ في المصادقة: تحقق من إعدادات Firebase');
            showAlert('❌ تعذر التحقق من إعدادات البيانات.', 'error');
        } else if (error.message === 'Network Error') {
            console.error('❌ خطأ في الاتصال بالإنترنت');
        }
        return null;
    }
}

/**
 * تحديث حالة Student Mode في جدول MODE
 */
async function updateStudentMode(lectureNumber, isEnabled) {
    try {
        // البحث عن السجل في جدول MODE
        console.log('🔍 جاري البحث في جدول MODE...');
        const response = await apiGet(
              `/api/data/${encodeURIComponent(MODE_TABLE)}`,
            { headers: getDataHeaders() }
        );

        // Defensive: validate response structure
        if (!response || !response.data || !Array.isArray(response.data.records)) {
            console.error('❌ Invalid response from MODE endpoint when updating student mode', response && response.data);
            showAlert('❌ MODE table response invalid', 'error');
            return false;
        }

        console.log('📋 عدد السجلات المتاحة:', response.data.records.length);

        if (response.data.records.length === 0) {
            console.error('❌ No records found in MODE table');
            showAlert('❌ MODE table is empty or not found', 'error');
            return false;
        }

        // Search for the correct record - with flexible handling
        let record = response.data.records.find(r => {
            const name = r.fields.Name || '';
            return name.trim() === MODE_RECORD_NAME.trim();
        });
        
        // If not found, try searching for first record if there's only one
        if (!record && response.data.records.length === 1) {
            console.warn('⚠️ Using the only record in the table');
            record = response.data.records[0];
        }
        
        if (!record) {
            console.error(`❌ Record with name "${MODE_RECORD_NAME}" not found`);
            console.log('Available record names:');
            response.data.records.forEach((r, idx) => {
                console.log(`  ${idx + 1}. "${r.fields.Name || '(empty)'}" - ID: ${r.id}`);
            });
            showAlert(`❌ Record "${MODE_RECORD_NAME}" not found in MODE table`, 'error');
            return false;
        }

        const recordId = record.id;

        console.log('✓ Record found, updating...');

        // تحديث السجل
        const updateResponse = await axios.patch(
            `/api/data/${encodeURIComponent(MODE_TABLE)}`,
            {
                fields: {
                    'Lecture': isEnabled ? String(lectureNumber) : null,
                    'Student Mode': isEnabled ? 'ON' : 'OFF'
                }
            },
            { headers: getDataHeaders() }
        );

        invalidateModeRecordCache();
        console.log(`✓ MODE table updated: Student Mode = ${isEnabled ? 'ON' : 'OFF'}, Lecture = ${lectureNumber}`);
        return true;
    } catch (error) {
        console.error('❌ Error updating MODE table:', error);
        console.error('Error details:', error.response?.data || error.message);
        showAlert(`❌ Connection error: ${error.message}`, 'error');
        return false;
    }
}

/**
 * 🎚️ Toggle Student Mode ON/OFF (from instructor page)
 */
/**
 * Select QR Code for Doctor Mode
 * Updates the QR Selected field in MODE table
 */
async function selectQRCode(qrValue) {
    const statusDiv = document.getElementById('mode-status');
    
    if (!statusDiv) {
        console.error('❌ Status div not found');
        return;
    }
    
    if (!currentLectureNumber) {
        showAlert('⚠️ Please select a lecture number first', 'warning');
        // Deselect radio button
        const radios = document.querySelectorAll('input[name="qr-select"]');
        radios.forEach(r => r.checked = false);
        return;
    }
    
    console.log(`🎚️ Select QR Code: ${qrValue}`);
    
    // Update MODE table with selected QR
    const success = await updateSelectedQR(currentLectureNumber, qrValue);
    
    if (!success) {
        showAlert('❌ Failed to update QR selection', 'error');
        // Deselect radio button
        const radios = document.querySelectorAll('input[name="qr-select"]');
        radios.forEach(r => r.checked = false);
        return;
    }
    
    // Update UI status text
    if (qrValue === 'NONE') {
        statusDiv.textContent = '✗ Status: No QR Selected';
        statusDiv.style.color = '#c62828';
        showAlert('✗ All QR codes disabled - Students cannot login', 'warning');
    } else {
        statusDiv.textContent = `✓ Status: ${qrValue} Active`;
        statusDiv.style.color = '#2e7d32';
        showAlert(`✓ ${qrValue} is now active - Students can scan this QR only`, 'success');
    }
    
    console.log(`✓ QR Selection updated: ${qrValue}`);
}

/**
 * Update Selected QR in MODE table
 */
async function updateSelectedQR(lectureNumber, qrValue) {
    try {
        const studentMode = qrValue === 'NONE' ? 'OFF' : 'ON';

        await axios.patch(
            `/api/data/${encodeURIComponent(MODE_TABLE)}`,
            {
                fields: {
                    'Lecture': String(lectureNumber),
                    'QR Selected': qrValue === 'NONE' ? null : qrValue,
                    'Student Mode': studentMode
                }
            },
            { headers: getDataHeaders() }
        );

        invalidateModeRecordCache();
        console.log(`✓ MODE table updated: QR Selected = ${qrValue}, Student Mode = ${studentMode}`);
        return true;
    } catch (error) {
        console.error('❌ Error updating MODE table:', error);
        console.error('Error details:', error.response?.data || error.message);
        showAlert(`❌ Connection error: ${error.message}`, 'error');
        return false;
    }
}

/**
 * Get Selected QR from MODE table
 */
async function getSelectedQRFromMode() {
    try {
        const record = await getModeRecord();
        if (!record) return 'NONE';

        const qrSelected = record.fields?.['QR Selected'] || 'NONE';
        const studentMode = record.fields?.['Student Mode'];
        return (studentMode === 'ON' || studentMode === true) ? qrSelected : 'NONE';
    } catch (error) {
        console.error('❌ خطأ في قراءة جدول MODE:', error);
        return 'NONE';
    }
}

/**
 * 🎚️ تحديث حالة QR Selection من Firestore
 */
async function updateQRSelectionDisplay() {
    try {
        const record = await getModeRecord(true);
        if (!record) return;

        const qrSelected = record.fields['QR Selected'] || 'NONE';
        const statusDiv = document.getElementById('mode-status');
        
        if (statusDiv) {
            if (qrSelected === 'NONE' || !qrSelected) {
                statusDiv.textContent = '✗ Status: No QR Selected';
                statusDiv.style.color = '#c62828';
            } else {
                statusDiv.textContent = `✓ Status: ${qrSelected} Active`;
                statusDiv.style.color = '#2e7d32';
            }
        }
        
        // Set radio button
        const radio = document.querySelector(`input[name="qr-select"][value="${qrSelected}"]`);
        if (radio) {
            radio.checked = true;
        }
    } catch (error) {
        console.error('⚠️ Error updating QR selection display:', error.message);
    }
}

/**
 * 🎚️ تحديث حالة Toggle من Firestore
 */
async function updateToggleStatus() {
    try {
        // هذه الدالة الآن تستدعي updateQRSelectionDisplay
        await updateQRSelectionDisplay();
        return;
    } catch (error) {
        console.error('⚠️ Error updating toggle status:', error.message);
    }
}

/**
 * جلب عنوان IP للجهاز
 */
/**
 * جلب عنوان IP الداخلي (Local IP) للجهاز باستخدام WebRTC فقط
 * بدون أي معرّف localStorage - يجب أن يكون IP الحقيقي فقط
 */
async function getDeviceIP() {
    if (deviceIP) {
        return deviceIP;
    }

    return new Promise((resolve) => {
        let ipFound = false;
        let timeoutId;

        const pc = new RTCPeerConnection({
            iceServers: []
        });

        // مهم: إنشاء data channel لبدء عملية ICE
        pc.createDataChannel('');

        // إنشاء offer لبدء جمع ICE candidates
        pc.createOffer()
            .then(offer => pc.setLocalDescription(offer))
            .catch(e => {
                console.error('❌ خطأ في WebRTC:', e);
                clearTimeout(timeoutId);
                pc.close();
                resolve(null); // فشل - IP غير متاح
            });

        // معالج ICE candidates
        pc.onicecandidate = (ice) => {
            if (ipFound) return;

            if (!ice || !ice.candidate) {
                // انتهى جمع candidates ولم نجد IP
                if (!ipFound) {
                    console.warn('⚠️ فشل جلب Local IP - الجهاز غير مدعوم أو الشبكة غير متوفرة');
                    clearTimeout(timeoutId);
                    pc.close();
                    resolve(null); // فشل - IP غير متاح
                }
                return;
            }

            try {
                const candidate = ice.candidate.candidate;
                
                // استخراج IP من candidate
                const ipMatch = candidate.match(/([0-9]{1,3}(\.[0-9]{1,3}){3})/);
                
                if (ipMatch && ipMatch[1]) {
                    const ip = ipMatch[1];
                    
                    // فلترة: نقبل فقط IPs الداخلية (Private IPs)
                    if (isPrivateIP(ip)) {
                        console.log('✓ تم العثور على Local IP الحقيقي:', ip);
                        deviceIP = ip;
                        ipFound = true;
                        clearTimeout(timeoutId);
                        pc.close();
                        resolve(deviceIP);
                    }
                }
            } catch (e) {
                console.error('❌ خطأ في معالجة ICE candidate:', e);
            }
        };

        // timeout: 2 seconds for IP detection (reduced from 5s)
        timeoutId = setTimeout(() => {
            if (!ipFound) {
                console.warn('⚠️ IP detection timeout - not available');
                pc.close();
                resolve(null); // فشل - timeout
            }
        }, 2000);

        function isPrivateIP(ip) {
            const parts = ip.split('.').map(Number);
            
            // 10.0.0.0 - 10.255.255.255
            if (parts[0] === 10) return true;
            
            // 172.16.0.0 - 172.31.255.255
            if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
            
            // 192.168.0.0 - 192.168.255.255
            if (parts[0] === 192 && parts[1] === 168) return true;
            
            return false;
        }
    });
}

/**
 * التحقق من أن IP الجهاز لم يُستخدم برمز جامعي مختلف
 * و التحقق من أن الكود الجامعي لم يُستخدم من IP مختلف
 * استخدام جدول RAM الذي يسجل جلسات الدخول الحالية
 */
async function checkDeviceIPConflict(studentCode, lectureNumber, existingStudentRecord = null) {
    const currentIP = await getDeviceIP();
    console.log(`🔍 فحص تضارب IP: Code=${studentCode}, IP=${currentIP}, Lecture=${lectureNumber}`);
    
    if (!currentIP) {
        console.error('❌ لم تتمكن من الحصول على IP');
        showAlert('❌ جهازك غير مدعوم أو الشبكة غير متوفرة - لا يمكن تحديد Local IP', 'error');
        return false;
    }

    try {
        const tableName = `LEC_${lectureNumber}`;

        // ✅ الفحص الأول: البحث في جدول المحاضرة عن IP (هل مسجل برمز مختلف؟)
        console.log(`🔍 الفحص الأول - فحص جدول ${tableName} عن IP: ${currentIP}`);
        const lectureResponseByIP = await apiGet(
            `/api/data/${encodeURIComponent(tableName)}?filterByFormula=({Device IP}='${currentIP}')`,
            { headers: getDataHeaders() }
        );

        const ipRecords = Array.isArray(lectureResponseByIP?.data?.records)
            ? lectureResponseByIP.data.records
            : [];
        console.log('فحص IP في جدول المحاضرة:', ipRecords.length, 'records');
        const matchingIPRecord = ipRecords.find(record => {
            const registeredIP = String(record.fields?.['Device IP'] || '').trim();
            return registeredIP === String(currentIP).trim();
        });
        if (matchingIPRecord) {
            const lectureRecord = matchingIPRecord;
            const registeredCode = String(lectureRecord.fields?.Code || lectureRecord.id || '').trim();
            console.log(`✓ وجد في ${tableName}: Code=${registeredCode}, IP=${currentIP}`);
            
            if (registeredCode !== String(studentCode)) { // ✅ مقارنة String مع String
                console.warn(`❌ رفض الفحص الأول: IP مسجل برمز مختلف (${registeredCode} ≠ ${studentCode})`);
                showAlert(`❌ هذا الجهاز مرتبط برمز جامعي مختلف (${registeredCode}) - لا يمكن الدخول`, 'error');
                return false; // ❌ IP موجود في المحاضرة برمز مختلف
            }
            console.log(`✓ الفحص الأول نجح: نفس الكود (${studentCode})`);
        } else {
            console.log(`✓ الفحص الأول نجح: IP جديد لم يُسجل من قبل`);
        }

        // ✅ الفحص الثاني: البحث عن رمز الطالب (هل عنده IP مختلف مسجل؟)
        console.log(`🔍 الفحص الثاني - فحص جدول ${tableName} عن رمز الطالب: ${studentCode}`);
        const lectureResponseByCode = existingStudentRecord ? null : await apiGet(
            `/api/data/${encodeURIComponent(tableName)}?filterByFormula=({Code}='${studentCode}')`,
            { headers: getDataHeaders() }
        );

        const studentRecords = existingStudentRecord
            ? [existingStudentRecord]
            : (Array.isArray(lectureResponseByCode?.data?.records) ? lectureResponseByCode.data.records : []);
        console.log('فحص الكود في جدول المحاضرة:', studentRecords.length, 'records');
        if (studentRecords.length > 0) {
            const studentRecord = studentRecords[0];
            const registeredIP = String(studentRecord.fields?.['Device IP'] || '').trim();
            console.log(`✓ وجد كود الطالب في ${tableName}: Code=${studentCode}, Device IP=${registeredIP}`);
            
            if (registeredIP && registeredIP !== String(currentIP).trim() && registeredIP !== 'Unknown') {
                // ❌ الكود نفسه عنده IP مختلف مسجل
                console.warn(`❌ رفض الفحص الثاني: رمز الطالب عنده IP مختلف (${registeredIP} ≠ ${currentIP})`);
                showAlert(`❌ رمز الطالب هذا مسجل من IP مختلف (${registeredIP}) - لا يمكن تسجيل الدخول من جهاز جديد`, 'error');
                return false;
            } else if (registeredIP === currentIP) {
                console.log(`✓ الفحص الثاني نجح: نفس IP المسجل (${currentIP})`);
            } else {
                console.log(`✓ الفحص الثاني نجح: لا يوجد IP مسجل بعد`);
            }
        } else {
            console.log(`✓ الفحص الثاني نجح: رمز الطالب جديد في هذه المحاضرة`);
        }

        console.log(`✅ فحوصات IP نجحت - سماح بالدخول`);
        return true;
        
    } catch (error) {
        console.error('❌ خطأ في فحص تضارب IP:', error.response?.data || error.message);
        showAlert('❌ تعذر التحقق من جهازك. حاول مرة أخرى.', 'error');
        return false;
    }
}

// ====== وظائف طلب الصلاحيات ======

/**
 * طلب صلاحية الكاميرا
 */
async function requestCameraPermission() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        stream.getTracks().forEach(track => track.stop());
        return true;
    } catch (error) {
        showAlert('لم يتم الموافقة على صلاحية الكاميرا', 'error');
        console.error('خطأ في صلاحية الكاميرا:', error);
        return false;
    }
}

/**
 * طلب صلاحية الموقع الجغرافي
 */
async function requestLocationPermission() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) {
            showAlert('جهازك لا يدعم خدمة الموقع الجغرافي', 'error');
            resolve(false);
            return;
        }

        navigator.geolocation.getCurrentPosition(
            (position) => {
                studentLocation = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                };
                checkGeographicRegion();
                resolve(true);
            },
            (error) => {
                // عند رفض الصلاحية، لا نسمح بالدخول
                console.error('رفض الطالب صلاحية الموقع:', error.code);
                showAlert('✗ يجب الموافقة على صلاحية الموقع الجغرافي للدخول', 'error');
                resolve(false);
            }
        );
    });
}

/**
 * Request all required permissions (optimized - parallel requests)
 */
async function requestAllPermissions() {
    try {
        // Request both permissions in parallel for faster login
        const [locationPermission, cameraPermission] = await Promise.all([
            requestLocationPermission(),
            requestCameraPermission()
        ]);

        if (!locationPermission || !cameraPermission) {
            return false;
        }

        return true;
    } catch (error) {
        console.error('Error requesting permissions:', error);
        return false;
    }
}

// ====== وظائف إدارة واجهة المستخدم ======

/**
 * عرض رسائل التنبيه
 */
function showAlert(message, type = 'info') {
    const alertEl = document.getElementById('alert');
    alertEl.textContent = message;
    alertEl.className = `alert show alert-${type}`;
    
    // إخفاء الرسالة بعد 5 ثواني
    setTimeout(() => {
        alertEl.classList.remove('show');
    }, 5000);
}

/**
 * عرض واجهة الطالب
 */
async function showStudentInterface() {
    // إخفاء واجهة الدخول
    document.getElementById('login-section').style.display = 'none';
    document.getElementById('student-section').style.display = 'block';
    document.getElementById('doctor-panel').style.display = 'none';
    
    // عرض اسم الطالب
    document.getElementById('student-name-display').textContent = `مرحباً بك: ${currentStudentName}`;
    
    // إخفاء رسالة الموقع الجغرافي إن كانت موجودة
    const locationStatus = document.getElementById('location-status');
    if (locationStatus) {
        locationStatus.style.display = 'none';
    }
    
    // إظهار الشريط العلوي
    const topBar = document.getElementById('top-bar');
    topBar.style.display = 'block';
    document.getElementById('mode-badge').textContent = 'وضع الطالب';
    document.getElementById('mode-badge').className = 'mode-badge student';
    
    // إعادة تعيين flag المعالجة
    isProcessingQR = false;
    
    currentMode = 'student';
    
    // 📖 قراءة الأكواد المحفوظة من Firestore وتحديث العلامات
    const tableName = `LEC_${currentLectureNumber}`;
    await loadStudentScannedQRs(currentStudentCode, currentLectureNumber, tableName, currentStudentRecord);
    
    // 🎯 بدء مراقبة Student Mode (للتحقق من الإيقاف من قبل المحاضر)
    startStudentModeMonitoring();
}

/**
 * عرض لوحة تحكم المحاضر
 */
function showDoctorInterface() {
    // Hide login interface
    document.getElementById('login-section').style.display = 'none';
    document.getElementById('student-section').style.display = 'none';
    document.getElementById('doctor-panel').style.display = 'block';
    currentMode = 'doctor';
    
    // Show top bar
    const topBar = document.getElementById('top-bar');
    topBar.style.display = 'block';
    document.getElementById('mode-badge').textContent = 'INSTRUCTOR MODE';
    document.getElementById('mode-badge').className = 'mode-badge doctor';
    
    // If there's a saved lecture, display it
    if (currentLectureNumber && lectureSelected) {
        document.getElementById('current-lecture').textContent = `Lec ${currentLectureNumber}`;
        document.getElementById('lecture-info').style.display = 'block';
        document.getElementById('lecture-number').value = currentLectureNumber;
        
        // 🎚️ Update toggle status from Firestore
        updateToggleStatus();
        
        // Start updating student list immediately
        startLectureStudentUpdates();
    }
    
}

/**
 * Exit current mode
 */
async function exitMode() {
    // Stop scanner if running
    if (qrScanner) {
        stopScanner();
    }
    
    // If instructor is exiting, disable Student Mode
    if (currentMode === 'doctor') {
        await updateStudentMode(currentLectureNumber, false);
    }
    
    // 🎯 Stop monitoring Student Mode
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
    }
    
    // Reset variables
    currentMode = null;
    currentStudentCode = null;
    currentStudentRecord = null;
    deviceIP = null; // ✅ Important: Reset Device IP
    lastSavedLocation = null;
    lastLocationWriteAt = 0;
    if (lectureStudentsTimer) {
        clearTimeout(lectureStudentsTimer);
        lectureStudentsTimer = null;
    }
    // currentLectureNumber and lectureSelected remain saved in localStorage
    scannedQRs = { qr1: false, qr2: false, qr3: false };
    isProcessingQR = false; // Reset processing flag
    
    // Reset interface
    document.getElementById('student-code').value = '';
    // Do not reset lecture-number because instructor may want to return to it
    
    // Reset QR Checkboxes
    resetQRCheckboxes();
    
    // Show login interface
    document.getElementById('login-section').style.display = 'block';
    document.getElementById('student-section').style.display = 'none';
    document.getElementById('doctor-panel').style.display = 'none';
    document.getElementById('top-bar').style.display = 'none';
    
    showAlert('Successfully logged out', 'info');
}

/**
 * Reset all QR Checkboxes
 */
function resetQRCheckboxes() {
    Object.keys(scannedQRs).forEach(qr => {
        scannedQRs[qr] = false;
        const checkbox = document.getElementById(`${qr}-check`);
        checkbox.classList.remove('checked');
    });
}

// ====== Shared API Helpers ======

/**
 * Create HTTP request headers for the local Firebase proxy.
 */
function getDataHeaders() {
    return { 'Content-Type': 'application/json' };
}

function getStudentName(fields = {}) {
    const candidates = [
        fields.name,
        fields['Student Name'],
        fields['Full Name'],
        fields.Name,
        fields.StudentName,
        fields.studentName,
        fields.Student_Name,
        fields.student_name,
        fields['اسم الطالب']
    ];
    const namedField = Object.entries(fields).find(([key, value]) => {
        const normalizedKey = key.toLowerCase().replace(/[\s_-]/g, '');
        return (normalizedKey === 'name' || normalizedKey === 'studentname' || normalizedKey === 'fullname') &&
            value !== undefined && value !== null && String(value).trim();
    });
    const name = candidates.find(value => value !== undefined && value !== null && String(value).trim()) || namedField?.[1];
    return name ? String(name).trim() : '';
}

/**
 * Search for student in the active Firestore-backed lecture directory.
 */
async function findStudent(studentCode, lectureNumber = null) {
    try {
        const tableName = lectureNumber ? `LEC_${lectureNumber}` : STUDENTS_TABLE;
        const response = await apiGet(
            `/api/data/${encodeURIComponent(tableName)}?filterByFormula=({Code}='${studentCode}')`,
            { headers: getDataHeaders() }
        );

        const lectureStudent = response?.data?.records?.[0];
        if (!lectureStudent) return null;

        const lectureFields = lectureStudent.fields || {};
        const hasName = getStudentName(lectureFields);
        if (hasName) return lectureStudent;

        if (lectureNumber && STUDENTS_TABLE !== tableName) {
            const directoryResponse = await apiGet(
                `/api/data/${encodeURIComponent(STUDENTS_TABLE)}?filterByFormula=({Code}='${studentCode}')`,
                { headers: getDataHeaders() }
            );
            const directoryStudent = directoryResponse?.data?.records?.[0];
            const directoryName = getStudentName(directoryStudent?.fields);
            if (directoryName) {
                return {
                    ...lectureStudent,
                    fields: { ...lectureFields, Name: directoryName }
                };
            }
        }

        return lectureStudent;
    } catch (error) {
        console.error('Error searching for student:', error);
        return null;
    }
}

/**
 * Save the student's login data with one write after the record was resolved.
 */
async function saveStudentLoginData(studentCode, lectureNumber, studentName, studentRecord) {
    if (!studentRecord?.id || !studentLocation) return false;

    try {
        const tableName = `LEC_${lectureNumber}`;
        const mapsLink = `https://maps.google.com/?q=${studentLocation.lat},${studentLocation.lng}`;
        const region = checkGeographicRegion();
        await axios.patch(
            `/api/data/${encodeURIComponent(tableName)}`,
            {
                id: studentRecord.id,
                fields: {
                    'Device IP': deviceIP || 'Unknown',
                    'Location': mapsLink,
                    'Region': region,
                    ...(studentName ? { Name: studentName } : {})
                }
            },
            { headers: getDataHeaders() }
        );
        lastSavedLocation = { lat: studentLocation.lat, lng: studentLocation.lng };
        lastLocationWriteAt = Date.now();
        return true;
    } catch (error) {
        console.error('Error saving student login data:', error);
        return false;
    }
}

/**
 * Update student attendance data in the current lecture table.
 */
async function updateStudentAttendance(studentCode, lectureNumber, tableName, columnName, existingStudentRecord = null) {
    try {
        const response = existingStudentRecord ? null : await apiGet(
            `/api/data/${encodeURIComponent(tableName)}?filterByFormula=({Code}='${studentCode}')`,
            { headers: getDataHeaders() }
        );

        const studentRecord = existingStudentRecord || response?.data?.records?.[0];
        if (!studentRecord) {
            console.error('❌ Student not found in lecture table');
            return null;
        }

        const mapsLink = `https://maps.google.com/?q=${studentLocation.lat},${studentLocation.lng}`;
        const recordId = studentRecord.id;
        const region = checkGeographicRegion();

        const updateResponse = await axios.patch(
            `/api/data/${encodeURIComponent(tableName)}`,
            {
                id: recordId,
                fields: {
                    [columnName]: true,
                    'Location': mapsLink,
                    'Region': region,
                    'Device IP': deviceIP || 'Unknown'
                }
            },
            { headers: getDataHeaders() }
        );

        console.log(`✓ تم تحديث ${columnName} والموقع والـ Device IP والـ Region للطالب في جدول ${tableName}`);
        return updateResponse.data;
    } catch (error) {
        console.error('خطأ في تحديث بيانات الطالب:', error);
        return null;
    }
}

/**
 * Add a new student record to the selected lecture table.
 */
async function addStudentToLecture(studentCode, lectureNumber, tableName) {
    try {
        if (!tableName) {
            tableName = `LEC_${lectureNumber}`;
        }

        const studentRecord = await findStudent(studentCode);
        if (!studentRecord) return null;

        const studentName = getStudentName(studentRecord.fields || '');

        const response = await axios.post(
            `/api/data/${encodeURIComponent(tableName)}`,
            {
                records: [
                    {
                        fields: {
                            'Name': studentName,
                            'Code': studentCode,
                            'Location': `https://maps.google.com/?q=${studentLocation.lat},${studentLocation.lng}`,
                            'Region': 'In region',
                            'Device IP': deviceIP || 'Unknown',
                            '1st QR': false,
                            '2nd QR': false,
                            '3rd QR': false
                        }
                    }
                ]
            },
            { headers: getDataHeaders() }
        );

        console.log(`✓ تم إضافة الطالب ${studentCode} إلى جدول ${tableName} مع Device IP`);
        return response.data.records[0];
    } catch (error) {
        console.error('خطأ في إضافة طالب جديد:', error);
        return null;
    }
}

/**
 * Update student location in the current lecture table.
 */
async function updateStudentLocation(studentCode, lectureNumber) {
    if (!studentLocation) return false;

    const now = Date.now();
    if (lastSavedLocation && now - lastLocationWriteAt < LOCATION_WRITE_INTERVAL_MS) {
        return true;
    }

    try {
        const tableName = `LEC_${lectureNumber}`;
        const mapsLink = `https://maps.google.com/?q=${studentLocation.lat},${studentLocation.lng}`;
        const response = await apiGet(
            `/api/data/${encodeURIComponent(tableName)}?filterByFormula=({Code}='${studentCode}')`,
            { headers: getDataHeaders() }
        );

        if (response?.data?.records?.length > 0 && studentLocation) {
            const recordId = response.data.records[0].id;
            const regionStatus = checkGeographicRegion();

            await axios.patch(
                `/api/data/${encodeURIComponent(tableName)}`,
                {
                    id: recordId,
                    fields: {
                        'Location': mapsLink,
                        'Region': regionStatus,
                        'Device IP': deviceIP || 'Unknown'
                    }
                },
                { headers: getDataHeaders() }
            );
            lastSavedLocation = { lat: studentLocation.lat, lng: studentLocation.lng };
            lastLocationWriteAt = now;
            return true;
        }
    } catch (error) {
        console.error('Error updating student location:', error);
    }
    return false;
}

/**
 * Fetch list of students for the selected lecture.
 */
async function fetchLectureStudents(lectureNumber) {
    try {
        const tableName = `LEC_${lectureNumber}`;
        const cacheKey = `lecture:${lectureNumber}`;
        const now = Date.now();
        const cached = window._lectureStudentsCache?.[cacheKey];
        if (cached && now - cached.timestamp < 4000) {
            return cached.records;
        }
        const response = await apiGet(
            `/api/data/${encodeURIComponent(tableName)}`,
            { headers: getDataHeaders() }
        );

        try { window._lastData429 = false; } catch (e) {}
        const records = Array.isArray(response?.data?.records) ? response.data.records : [];
        if (!window._lectureStudentsCache) window._lectureStudentsCache = {};
        window._lectureStudentsCache[cacheKey] = { timestamp: now, records };
        return records;
    } catch (error) {
        console.error('Error fetching students:', error);
        try {
            if (error.response && error.response.status === 429) {
                window._lastData429 = true;
            }
        } catch (e) {}
        return [];
    }
}

async function enrichStudentNamesForExport(records) {
    const missingNames = records.filter(record => !getStudentName(record.fields || {}));
    if (missingNames.length === 0) return;

    const directoryStudents = await fetchLectureStudents(1);
    const namesByCode = new Map();
    directoryStudents.forEach(record => {
        const code = String(record.fields?.Code || record.id || '').trim();
        const name = getStudentName(record.fields || {});
        if (code && name) namesByCode.set(code, name);
    });

    missingNames.forEach(record => {
        const code = String(record.fields?.Code || record.id || '').trim();
        const name = namesByCode.get(code);
        if (name) record.fields.Name = name;
    });
}

// ====== Geographic Verification Functions ======

/**
 * Read the student's stored QR progress from the current lecture table.
 */
async function loadStudentScannedQRs(studentCode, lectureNumber, tableName, existingStudentRecord = null) {
    try {
        console.log(`📖 جاري قراءة الأكواد المحفوظة للطالب ${studentCode}...`);
        scannedQRs = { qr1: false, qr2: false, qr3: false };
        updateQRCheckmarks();

        const response = existingStudentRecord ? null : await apiGet(
            `/api/data/${encodeURIComponent(tableName)}?filterByFormula=({Code}='${studentCode}')`,
            { headers: getDataHeaders() }
        );

        const studentRecord = existingStudentRecord || response?.data?.records?.[0];
        if (!studentRecord) {
            console.warn('⚠️ لم يتم العثور على سجل الطالب');
            return;
        }

        const fields = studentRecord.fields || {};
        const isRecorded = value => value === true || value === 'true' || value === 1 || value === '1';

        scannedQRs.qr1 = isRecorded(fields['1st QR'] ?? fields['1st_QR'] ?? fields.qr_1);
        scannedQRs.qr2 = isRecorded(fields['2nd QR'] ?? fields['2nd_QR'] ?? fields.qr_2);
        scannedQRs.qr3 = isRecorded(fields['3rd QR'] ?? fields['3rd_QR'] ?? fields.qr_3);

        console.log('✓ تم قراءة الأكواس المحفوظة:', scannedQRs);
        updateQRCheckmarks();
    } catch (error) {
        console.error('❌ خطأ في قراءة البيانات المحفوظة:', error);
    }
}

/**
 * تحديث العلامات الثلاث على الواجهة
 */
function updateQRCheckmarks() {
    // تحديث qr1
    const checkbox1 = document.getElementById('qr1-check');
    if (checkbox1) {
        if (scannedQRs.qr1) {
            checkbox1.classList.add('checked');
        } else {
            checkbox1.classList.remove('checked');
        }
    }

    // تحديث qr2
    const checkbox2 = document.getElementById('qr2-check');
    if (checkbox2) {
        if (scannedQRs.qr2) {
            checkbox2.classList.add('checked');
        } else {
            checkbox2.classList.remove('checked');
        }
    }

    // تحديث qr3
    const checkbox3 = document.getElementById('qr3-check');
    if (checkbox3) {
        if (scannedQRs.qr3) {
            checkbox3.classList.add('checked');
        } else {
            checkbox3.classList.remove('checked');
        }
    }

    console.log('✓ تم تحديث العلامات على الواجهة');
}

/**
 * Verify if student is within geographic region
 * Using Point in Polygon algorithm with tolerance
 */
function checkGeographicRegion() {
    if (!studentLocation) {
        updateLocationStatus('Unavailable');
        return 'Unknown';
    }

    const x = studentLocation.lng;
    const y = studentLocation.lat;
    
    let isInside = false;
    const n = GEO_BOUNDARIES.length;

    // Expand boundaries with tolerance value for flexibility
    const expandedBoundaries = GEO_BOUNDARIES.map(point => ({
        lat: point.lat,
        lng: point.lng
    }));

    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = expandedBoundaries[i].lng;
        const yi = expandedBoundaries[i].lat;
        const xj = expandedBoundaries[j].lng;
        const yj = expandedBoundaries[j].lat;

        const intersect = ((yi > y) !== (yj > y)) &&
            (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) isInside = !isInside;
    }

    // If not inside, check proximity to boundaries
    if (!isInside) {
        // Check distance from nearest boundary point
        for (let i = 0; i < n; i++) {
            const point = expandedBoundaries[i];
            const latDiff = Math.abs(point.lat - y);
            const lngDiff = Math.abs(point.lng - x);
            
            // If student is very close to any boundary point
            if (latDiff <= REGION_TOLERANCE && lngDiff <= REGION_TOLERANCE) {
                isInside = true;
                break;
            }
        }
    }

    const status = isInside ? 'In region' : 'Out region';
    updateLocationStatus(status);
    return status;
}

/**
 * Update location status in interface
 */
function updateLocationStatus(status) {
    const locationEl = document.getElementById('location-status');
    if (!locationEl) {
        // Element not found - do nothing
        return;
    }
    
    if (status === 'In region') {
        locationEl.className = 'location-status in-region';
        locationEl.textContent = '✓ You are within the geographic region';
    } else if (status === 'Out region') {
        locationEl.className = 'location-status out-region';
        locationEl.textContent = '✗ You are outside the geographic region';
    } else {
        locationEl.className = 'location-status loading';
        locationEl.textContent = 'Determining your location...';
    }
}

// ====== QR Scanner Functions ======

/**
 * Start QR Scanner - Mobile Optimized
 */
function startScanner() {
    const startBtn = document.getElementById('start-scanner-btn');
    startBtn.style.display = 'none';
    
    const container = document.getElementById('scanner-container');
    container.style.display = 'block';
    
    const statusEl = document.getElementById('scanner-status');
    if (statusEl) {
        statusEl.textContent = '📷 Loading camera...';
        statusEl.classList.add('scanning');
    }
    
    // Initialize html5-qrcode library with optimized settings
    qrScanner = new Html5Qrcode('qr_reader');
    
    // Use simple camera constraints - html5-qrcode handles video constraints internally
    const cameraId = { facingMode: 'environment' };
    
    const qrCodeConfig = {
        fps: 10,
        qrbox: { width: 280, height: 280 },
        disableFlip: false,
        aspectRatio: 1.0,
        useBarCodeDetectorIfSupported: true
    };
    
    qrScanner.start(
        cameraId,
        qrCodeConfig,
        onQRScanned,
        onQRScanError
    ).then(() => {
        if (statusEl) {
            statusEl.textContent = '✓ Camera active - Point at QR code';
            statusEl.classList.remove('scanning');
            statusEl.classList.add('scanning');
        }
        console.log('✓ QR Scanner started successfully');
    }).catch(err => {
        console.error('❌ Failed to start scanner:', err);
        if (statusEl) {
            statusEl.textContent = '❌ Camera access denied';
            statusEl.className = 'scanner-status';
        }
        showAlert('Failed to access camera. Please check permissions.', 'error');
        stopScanner();
    });
}

/**
 * Stop QR Scanner - Mobile Optimized
 */
function stopScanner() {
    if (qrScanner) {
        try {
            qrScanner.stop();
            qrScanner.clear();
        } catch (error) {
            console.warn('Warning while stopping scanner:', error);
        }
        qrScanner = null;
    }
    
    const statusEl = document.getElementById('scanner-status');
    if (statusEl) {
        statusEl.textContent = '📱 Scanner stopped';
        statusEl.className = 'scanner-status';
    }
    
    document.getElementById('scanner-container').style.display = 'none';
    document.getElementById('start-scanner-btn').style.display = 'block';
}

/**
 * معالج نجاح مسح QR - Mobile Optimized
 */
async function onQRScanned(decodedText) {
    // منع المعالجة المتزامنة
    if (isProcessingQR) {
        return;
    }

    // Update status indicator
    const statusEl = document.getElementById('scanner-status');
    if (statusEl) {
        statusEl.textContent = '⏳ Processing QR code...';
        statusEl.className = 'scanner-status processing';
    }

    // التحقق من القيمة المكتشفة
    let matchedQR = null;
    let qrValue = null; // QR_1, QR_2, QR_3
    
    if (decodedText === QR_CODES.qr1) {
        matchedQR = 'qr1';
        qrValue = 'QR_1';
    } else if (decodedText === QR_CODES.qr2) {
        matchedQR = 'qr2';
        qrValue = 'QR_2';
    } else if (decodedText === QR_CODES.qr3) {
        matchedQR = 'qr3';
        qrValue = 'QR_3';
    }

    if (matchedQR && !scannedQRs[matchedQR]) {
        // Check if this QR matches the one selected by doctor
        const selectedQR = await getSelectedQRFromMode();
        
        if (selectedQR === 'NONE') {
            // No QR is selected - reject scan
            if (statusEl) {
                statusEl.textContent = `❌ No QR codes are active - Ask instructor to enable QR`;
                statusEl.className = 'scanner-status';
                setTimeout(() => {
                    if (statusEl) {
                        statusEl.textContent = '✓ Camera active - Point at QR code';
                    }
                }, 2500);
            }
            showAlert(`❌ No QR codes are active. Ask the instructor to enable a QR code.`, 'error');
            return;
        }
        
        if (qrValue !== selectedQR) {
            // Wrong QR code - reject scan
            if (statusEl) {
                statusEl.textContent = `❌ Wrong QR! Only ${selectedQR} is active`;
                statusEl.className = 'scanner-status';
                setTimeout(() => {
                    if (statusEl) {
                        statusEl.textContent = '✓ Camera active - Point at QR code';
                    }
                }, 2500);
            }
            showAlert(`❌ You scanned ${qrValue}, but only ${selectedQR} is active. Scan the correct QR code.`, 'error');
            return;
        }
        
        // تعيين flag المعالجة
        isProcessingQR = true;
        
        // تحديث Firestore أولاً قبل تضييء العلامة
        if (currentMode === 'student' && currentLectureNumber && currentStudentCode) {
            const tableName = `LEC_${currentLectureNumber}`; // استخدام LEC_1 أو LEC_2 إلخ
            
            // تحديد اسم العمود الصحيح
            let columnName;
            if (matchedQR === 'qr1') {
                columnName = '1st QR';
            } else if (matchedQR === 'qr2') {
                columnName = '2nd QR';
            } else if (matchedQR === 'qr3') {
                columnName = '3rd QR';
            }
            
            // انتظر نتيجة التحديث في Firestore
            const updateResult = await updateStudentAttendance(
                currentStudentCode,
                currentLectureNumber,
                tableName,
                columnName,
                currentStudentRecord
            );
            
            // فقط إذا كان التحديث ناجحاً، قم بإضاءة العلامة
            if (updateResult) {
                // تحديث الحالة المحلية
                scannedQRs[matchedQR] = true;
                
                // تحديث الواجهة
                const checkbox = document.getElementById(`${matchedQR}-check`);
                checkbox.classList.add('checked');
                
                // Update status with success
                if (statusEl) {
                    statusEl.textContent = `✓ ${matchedQR.toUpperCase()} Recorded Successfully!`;
                    statusEl.className = 'scanner-status scanning';
                    setTimeout(() => {
                        if (statusEl) {
                            statusEl.textContent = '✓ Camera active - Point at QR code';
                        }
                    }, 2000);
                }
                
                showAlert(`✓ ${matchedQR} recorded`, 'success');
            } else {
                // إذا فشل التحديث، اعرض رسالة خطأ ولا تضء العلامة
                if (statusEl) {
                    statusEl.textContent = `❌ ${matchedQR.toUpperCase()} Failed to Record!`;
                    statusEl.className = 'scanner-status';
                    setTimeout(() => {
                        if (statusEl) {
                            statusEl.textContent = '✓ Camera active - Point at QR code';
                        }
                    }, 2000);
                }
                showAlert(`❌ Failed to record ${matchedQR}. Please try again.`, 'error');
            }
        }
        
        // Reset processing flag
        isProcessingQR = false;
    } else if (!matchedQR) {
        if (statusEl) {
            statusEl.textContent = '❌ Invalid QR code';
            statusEl.className = 'scanner-status';
            setTimeout(() => {
                if (statusEl) {
                    statusEl.textContent = '✓ Camera active - Point at QR code';
                }
            }, 1500);
        }
        showAlert('Invalid QR code', 'warning');
    }
}

/**
 * معالج أخطاء مسح QR
 */
function onQRScanError(error) {
    // Do not display errors as they are normal when QR code is not detected
    console.debug('Scan error:', error);
}

// ====== Instructor Functions ======

/**
 * Select lecture by instructor and enable student mode
 */
async function selectLecture() {
    const lectureNumber = document.getElementById('lecture-number').value;
    
    if (!lectureNumber || lectureNumber < 1) {
        showAlert('Please enter a valid lecture number', 'error');
        return;
    }

    showAlert('Loading lecture settings...', 'info');

    currentLectureNumber = lectureNumber;
    lectureSelected = true;
    
    // Save to safeStorage as well
    safeStorage.setItem('selectedLecture', lectureNumber);
    safeStorage.setItem('lectureSelected', 'true');
    
    // Display lecture information
    document.getElementById('current-lecture').textContent = `Lec ${lectureNumber}`;
    document.getElementById('lecture-info').style.display = 'block';
    
    // Load QR selection status for this lecture
    await updateQRSelectionDisplay();
    
    showAlert(`✓ Lecture ${lectureNumber} loaded - Select a QR code to enable`, 'success');
    
    // Start updating student list
    startLectureStudentUpdates();
}

/**
 * 🎚️ تحديث حالة Toggle من Firestore
 */


/**
 * 📊 Start monitoring Student Mode for students (check every 2 seconds)
 */
function startStudentModeMonitoring() {
    console.log('📊 Starting Student Mode monitoring...');

    // Cancel any previous monitor
    if (monitoringInterval) {
        clearTimeout(monitoringInterval);
        monitoringInterval = null;
    }

    // Poll loop using adaptive setTimeout so we can change interval on errors
    async function pollLoop() {
        try {
            if (currentMode === 'student') {
                await checkStudentModeStatus();
            }
        } catch (e) {
            // checkStudentModeStatus logs errors; we still continue
        }
        monitoringInterval = setTimeout(pollLoop, studentModePollMs);
    }

    // Start immediately
    pollLoop();
}

/**
 * 🔍 Check current Student Mode status
 */
async function checkStudentModeStatus() {
    try {
        const record = await getModeRecord();
        if (!record) {
            console.warn('⚠️ MODE record not found');
            return;
        }

        const studentMode = record.fields['Student Mode'];
        console.log(`📊 Student Mode status: ${studentMode}`);
        
        if (studentMode === 'OFF' && currentMode === 'student') {
            console.warn('⚠️ Detected student mode disabled! - Closing page...');
            showAlert('⛔ Student mode disabled by instructor - Exiting', 'warning');
            
            // الخروج الفوري
            setTimeout(() => {
                exitMode();
            }, 1500);
        }
    } catch (error) {
        // If the data route returns 429, back off polling exponentially
        const status = error.response?.status;
        if (status === 429) {
            // increase poll interval (exponential) up to 60s
            studentModePollMs = Math.min(studentModePollMs * 2, 60000);
            console.warn(`⚠️ Student Mode 429 received — backing off polling to ${studentModePollMs}ms`);
        } else {
            // For other errors, log and keep the base interval
            console.error('⚠️ Error checking Student Mode:', error.message || error);
            studentModePollMs = STUDENT_MODE_POLL_BASE_MS;
        }
    }
}

/**
 * Start updating student list periodically
 */
function startLectureStudentUpdates() {
    // Backoff-enabled polling for student updates
    const baseMs = 10000; // baseline polling interval
    const maxMs = 60000; // max backoff
    let currentMs = baseMs;
    if (lectureStudentsTimer) {
        clearTimeout(lectureStudentsTimer);
    }

    async function tick() {
        if (!(currentMode === 'doctor' && currentLectureNumber)) {
            lectureStudentsTimer = null;
            return;
        }

        try {
            await updateStudentsList();
            // if last fetch had 429 marker, increase backoff
            if (window._lastData429) {
                currentMs = Math.min(currentMs * 2, maxMs);
            } else {
                // reset to baseline on success
                currentMs = baseMs;
            }
        } catch (e) {
            // on unexpected error, increase backoff
            currentMs = Math.min(currentMs * 2, maxMs);
        }

        lectureStudentsTimer = setTimeout(tick, Math.max(currentMs, LECTURE_REFRESH_MS));
    }

    // start
    tick();
}

/**
 * Update registered student list
 * Display only students who scanned at least one QR
 */
async function updateStudentsList() {
    if (!currentLectureNumber) return;
    
    const students = await fetchLectureStudents(currentLectureNumber);
    const studentsList = document.getElementById('students-list');
    const isRecorded = value => value === true || value === 'true' || value === 1 || value === '1';
    
    // Filter students - show only those with at least one QR code true
    const attendedStudents = students.filter(record => {
        const student = record.fields || {};
        const has1stQR = isRecorded(student['1st QR'] ?? student['1st_QR'] ?? student.qr_1);
        const has2ndQR = isRecorded(student['2nd QR'] ?? student['2nd_QR'] ?? student.qr_2);
        const has3rdQR = isRecorded(student['3rd QR'] ?? student['3rd_QR'] ?? student.qr_3);
        return has1stQR || has2ndQR || has3rdQR;
    });

    await Promise.all(attendedStudents.map(async record => {
        const fields = record.fields || {};
        if (getStudentName(fields)) return;
        const code = String(fields.Code || record.id || '').trim();
        if (!code) return;
        const directoryStudent = await findStudent(code);
        const directoryName = getStudentName(directoryStudent?.fields);
        if (directoryName) fields.Name = directoryName;
    }));
    
    if (attendedStudents.length === 0) {
        studentsList.innerHTML = '<div class="empty-list">No students have scanned QR codes yet</div>';
        return;
    }

    let html = '';
    attendedStudents.forEach(record => {
        const student = record.fields;
        const studentCode = String(student.Code || record.id || 'N/A');
        const studentName = getStudentName(student) || 'Unknown';
        const region = student.Region || 'Unknown';
        
        // Count scanned QR codes
        const qr1Scanned = student['1st QR'] === true || student['1st QR'] === 'true';
        const qr2Scanned = student['2nd QR'] === true || student['2nd QR'] === 'true';
        const qr3Scanned = student['3rd QR'] === true || student['3rd QR'] === 'true';
        const qrCount = [qr1Scanned, qr2Scanned, qr3Scanned].filter(Boolean).length;
        const qrStatus = `(${qrCount}/3 QR)`;
        const qrIndicators = `
            <span class="student-qr-indicators" aria-label="Scanned QR codes">
                <span class="student-qr-dot ${qr1Scanned ? 'scanned' : ''}" title="QR 1">1</span>
                <span class="student-qr-dot ${qr2Scanned ? 'scanned' : ''}" title="QR 2">2</span>
                <span class="student-qr-dot ${qr3Scanned ? 'scanned' : ''}" title="QR 3">3</span>
            </span>`;
        
        // Check if student is out of region
        const isOutRegion = region === 'Out region';
        const locationIndicator = isOutRegion ? '<span class="location-alert-indicator" title="Student is out of region">📍</span>' : '';
        
        html += `
            <div class="student-item ${isOutRegion ? 'out-of-region' : ''}">
                <div class="student-info">
                    <div class="student-name">${studentName} ${locationIndicator} ${qrIndicators}</div>
                    <div class="student-code">Code: ${studentCode}</div>
                </div>
                <div class="student-status">✓ ${qrStatus}</div>
            </div>
        `;
    });
    
    studentsList.innerHTML = html;
}

/**
 * Toggle all lectures checkbox
 */
function toggleAllLectures() {
    const allCheckbox = document.getElementById('lec-all');
    const lectureCheckboxes = document.querySelectorAll('.lecture-checkbox');
    lectureCheckboxes.forEach(cb => {
        cb.checked = allCheckbox.checked;
    });
}

/**
 * Apply professional formatting to worksheet
 */
/**
 * Apply professional formatting to Excel worksheet
 * Uses ExcelJS for proper table and formatting support
 */
function applyProfessionalFormatting(worksheet, startRow = 1, endRow = 1) {
    // Header styling
    const headerFill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF4472C4' }  // Blue
    };

    const headerFont = {
        bold: true,
        name: 'Segoe UI',
        size: 11,
        color: { argb: 'FFFFFFFF' }  // White
    };

    const headerAlignment = {
        horizontal: 'center',
        vertical: 'center',
        wrapText: false
    };

    // Data styling
    const dataFont = {
        name: 'Segoe UI',
        size: 10,
        color: { argb: 'FF000000' }  // Black
    };

    const dataAlignment = {
        horizontal: 'center',
        vertical: 'center',
        wrapText: false
    };

    const borderAll = {
        top: { style: 'thin', color: { argb: 'FF000000' } },
        bottom: { style: 'thin', color: { argb: 'FF000000' } },
        left: { style: 'thin', color: { argb: 'FF000000' } },
        right: { style: 'thin', color: { argb: 'FF000000' } }
    };

    // Apply header formatting
    const headerRow = worksheet.getRow(1);
    headerRow.eachCell((cell) => {
        cell.fill = headerFill;
        cell.font = headerFont;
        cell.alignment = headerAlignment;
        cell.border = borderAll;
    });

    // Apply data formatting
    for (let rowNum = 2; rowNum <= endRow; rowNum++) {
        const row = worksheet.getRow(rowNum);
        row.eachCell((cell) => {
            cell.font = dataFont;
            cell.alignment = dataAlignment;
            cell.border = borderAll;
        });
    }
}

/**
 * Export multiple lectures data to Excel with proper tables
 */
async function exportMultipleLectures() {
    // Check if ExcelJS library is loaded
    if (typeof ExcelJS === 'undefined') {
        showAlert('❌ مكتبة Excel لم تحمل بعد. حاول في لحظة', 'error');
        console.error('ExcelJS library not loaded');
        return;
    }

    try {
        // Get selected lectures
        const selectedCheckboxes = document.querySelectorAll('.lecture-checkbox:checked');
        if (selectedCheckboxes.length === 0) {
            showAlert('⚠️ يرجى اختيار محاضرة واحدة على الأقل', 'warning');
            return;
        }

        showAlert('📊 جاري تصدير البيانات من المحاضرات المختارة...', 'info');

        const selectedLectures = Array.from(selectedCheckboxes).map(cb => ({
            lecNum: cb.value,
            tableName: cb.dataset.lecture
        }));

        // Collect all students from all selected lectures
        const studentsMap = new Map(); // Map<Code, {Name, Code, attendance, regionData}>

        // Fetch data from each lecture
        for (const lec of selectedLectures) {
            const students = await fetchLectureStudents(lec.lecNum);
            await enrichStudentNamesForExport(students);
            
            students.forEach(record => {
                const fields = record.fields || {};
                const code = fields.Code || record.id;
                const name = getStudentName(fields) || '---';
                const region = fields.Region || 'Unknown';
                
                // Count QR codes scanned
                const qrCount = [fields['1st QR'], fields['2nd QR'], fields['3rd QR']]
                    .filter(value => value === true || value === 'true').length;
                
                // Mark as attended only if 2 or more QRs were scanned
                const hasAttendance = qrCount >= 2;
                
                if (!studentsMap.has(code)) {
                    studentsMap.set(code, {
                        Name: name,
                        Code: code,
                        attendance: {},
                        regionData: {}  // Store region for each lecture
                    });
                }
                
                // Mark attendance for this lecture (X if 2+ QRs, empty if less)
                studentsMap.get(code).attendance[`Lec ${lec.lecNum}`] = hasAttendance ? 'X' : '';
                // Store region data for this lecture
                studentsMap.get(code).regionData[`Lec ${lec.lecNum}`] = region;
            });
        }

        // If no students found
        if (studentsMap.size === 0) {
            showAlert('❌ لا توجد بيانات طلاب في المحاضرات المختارة', 'error');
            return;
        }

        // Prepare data for Excel
        const excelData = [];
        
        studentsMap.forEach((student, code) => {
            const row = {
                'الاسم': student.Name,
                'الكود': student.Code
            };
            
            // Add lecture columns in order
            selectedLectures.forEach(lec => {
                row[`Lec ${lec.lecNum}`] = student.attendance[`Lec ${lec.lecNum}`] || '';
            });
            
            excelData.push(row);
        });

        // Sort by name
        excelData.sort((a, b) => a['الاسم'].localeCompare(b['الاسم'], 'ar'));

        // Create a new workbook with ExcelJS
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Attendance');

        // Add header row
        const headers = ['الاسم', 'الكود'];
        selectedLectures.forEach(lec => {
            headers.push(`Lec ${lec.lecNum}`);
        });
        worksheet.addRow(headers);

        // Add data rows with Region-based coloring
        excelData.forEach((row, rowIndex) => {
            const rowData = [row['الاسم'], row['الكود']];
            selectedLectures.forEach(lec => {
                rowData.push(row[`Lec ${lec.lecNum}`] || '');
            });
            
            const newRow = worksheet.addRow(rowData);
            
            // Color lecture columns based on region
            const studentCode = Array.from(studentsMap.keys()).find(code => {
                const student = studentsMap.get(code);
                return student.Name === row['الاسم'] && student.Code === row['الكود'];
            });
            
            if (studentCode) {
                const student = studentsMap.get(studentCode);
                selectedLectures.forEach((lec, lecIndex) => {
                    const cellIndex = 3 + lecIndex;  // Column index (1-based: 3 = Lec 1)
                    const region = student.regionData[`Lec ${lec.lecNum}`];
                    
                    if (region === 'Out region') {
                        // Red background for Out region lectures
                        const cell = newRow.getCell(cellIndex);
                        cell.fill = {
                            type: 'pattern',
                            pattern: 'solid',
                            fgColor: { argb: 'FFDC2626' }  // Red
                        };
                        cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
                    }
                });
            }
        });

        // Set column widths
        worksheet.getColumn(1).width = 30;  // Name
        worksheet.getColumn(2).width = 15;  // Code
        // Add width for each lecture column
        for (let i = 0; i < selectedLectures.length; i++) {
            worksheet.getColumn(3 + i).width = 9;  // Lecture columns  
        }

        // Apply professional formatting
        applyProfessionalFormatting(worksheet, 1, excelData.length + 1);

        // Generate file name with timestamp
        const timestamp = new Date().toLocaleString('ar-EG').replace(/[\/:]/g, '-');
        const lecRange = selectedLectures.length === 1 
            ? `Lec${selectedLectures[0].lecNum}` 
            : `Lec${selectedLectures[0].lecNum}-${selectedLectures[selectedLectures.length - 1].lecNum}`;
        const fileName = `Attendance_${lecRange}_${timestamp}.xlsx`;

        // Write the file using browser download method
        const buffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);

        showAlert(`✓ تم تصدير بيانات ${excelData.length} طالب من ${selectedLectures.length} محاضرة!\nملف: ${fileName}`, 'success');
        console.log('✓ Multiple lectures exported successfully:', fileName);

    } catch (error) {
        console.error('❌ Error exporting multiple lectures:', error);
        showAlert('❌ حدث خطأ أثناء التصدير', 'error');
    }
}

/**
 * Export students attendance data to Excel with proper table
 */
async function exportToExcel() {
    // Check if ExcelJS library is loaded
    if (typeof ExcelJS === 'undefined') {
        showAlert('❌ مكتبة Excel لم تحمل بعد. حاول في لحظة', 'error');
        console.error('ExcelJS library not loaded');
        return;
    }

    if (!currentLectureNumber) {
        showAlert('⚠️ Please select a lecture first', 'warning');
        return;
    }

    try {
        showAlert('📊 جاري تصدير البيانات...', 'info');
        
        // Fetch all students from the lecture
        const students = await fetchLectureStudents(currentLectureNumber);
        
        if (students.length === 0) {
            showAlert('❌ لا توجد بيانات طلاب لتصديرها', 'error');
            return;
        }

        await enrichStudentNamesForExport(students);

        // Prepare data for Excel
        const excelData = [];
        
        students.forEach(record => {
            const fields = record.fields || {};
            excelData.push({
                'الاسم': getStudentName(fields) || '---',
                'الكود': fields.Code || record.id || '---',
                '1st QR': fields['1st QR'] === true || fields['1st QR'] === 'true' ? 'X' : '',
                '2nd QR': fields['2nd QR'] === true || fields['2nd QR'] === 'true' ? 'X' : '',
                '3rd QR': fields['3rd QR'] === true || fields['3rd QR'] === 'true' ? 'X' : '',
                'المنطقة': fields.Region || '---'
            });
        });

        // Sort by name
        excelData.sort((a, b) => a['الاسم'].localeCompare(b['الاسم'], 'ar'));

        // Create a new workbook with ExcelJS
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet(`Lecture_${currentLectureNumber}`);

        // Add header row
        const headers = ['الاسم', 'الكود', '1st QR', '2nd QR', '3rd QR', 'المنطقة'];
        worksheet.addRow(headers);

        // Add data rows with Region coloring
        excelData.forEach((row, rowIndex) => {
            const newRow = worksheet.addRow([
                row['الاسم'],
                row['الكود'],
                row['1st QR'],
                row['2nd QR'],
                row['3rd QR'],
                row['المنطقة']
            ]);
            
            // Color the Region cell (column 6) based on value
            const regionCell = newRow.getCell(6);
            if (row['المنطقة'] === 'Out region') {
                // Red background for Out region
                regionCell.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFDC2626' }  // Red
                };
                regionCell.font = { color: { argb: 'FFFFFFFF' }, bold: true };  // White text
            } else if (row['المنطقة'] === 'In region') {
                // Green background for In region
                regionCell.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FF16A34A' }  // Green
                };
                regionCell.font = { color: { argb: 'FFFFFFFF' }, bold: true };  // White text
            }
        });

        // Set column widths
        worksheet.getColumn(1).width = 35;  // Name
        worksheet.getColumn(2).width = 10;  // Code
        worksheet.getColumn(3).width = 9;  // 1st QR
        worksheet.getColumn(4).width = 9;  // 2nd QR
        worksheet.getColumn(5).width = 9;  // 3rd QR
        worksheet.getColumn(6).width = 10;  // Region

        // Apply professional formatting
        applyProfessionalFormatting(worksheet, 1, excelData.length + 1);

        // Generate file name with timestamp
        const timestamp = new Date().toLocaleString('ar-EG').replace(/[\/:]/g, '-');
        const fileName = `Attendance_Lec${currentLectureNumber}_${timestamp}.xlsx`;

        // Write the file using browser download method
        const buffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);

        showAlert(`✓ تم تصدير بيانات ${excelData.length} طالب!\nملف: ${fileName}`, 'success');
        console.log('✓ Excel file exported successfully:', fileName);

    } catch (error) {
        console.error('❌ Error exporting to Excel:', error);
        showAlert('❌ حدث خطأ أثناء التصدير. تأكد من أن لديك بيانات لتصديرها', 'error');
    }
}

// ====== Login Functions ======

/**
 * Handle student code submission - Optimized for speed
 */
async function submitStudentCode() {
    const codeInput = document.getElementById('student-code').value.trim();
    const signInBtn = document.querySelector('button[onclick="submitStudentCode()"]');
    
    if (!codeInput) {
        showAlert('Please enter your student code', 'error');
        return;
    }

    // Rate-limit check (prevent brute-force)
    const allowed = allowAction('submitStudentCode', { limit: 6, windowMs: 60 * 1000, lockMs: 5 * 60 * 1000 });
    if (!allowed) {
        const rem = Math.ceil(getActionLockRemaining('submitStudentCode') / 1000);
        showAlert(`Too many attempts. Try again in ${rem} seconds.`, 'error');
        return;
    }

    // Disable button during login
    if (signInBtn) signInBtn.disabled = true;

    showAlert('🔐 Logging in...', 'info');

    try {
        // ✅ Load protection settings first so doctor password is current
        const protectionOK = await checkWebsiteProtectionStatus();
        if (!protectionOK) {
            showAlert('❌ Cannot verify protection settings. Please try again later.', 'error');
            if (signInBtn) signInBtn.disabled = false;
            return;
        }

        // Enforce protection lock first (prevents doctor access when locked)
        if (isWebsiteLocked) {
            // Show locked UI and prevent any login (including doctor)
            showLockedWebsite();
            if (signInBtn) signInBtn.disabled = false;
            return;
        }

        // Verify doctor credentials on the server; never expose the password to the browser.
        const authResponse = await axios.post('/api/auth', { code: codeInput }, {
            headers: getDataHeaders(),
            validateStatus: status => status < 500
        }).catch(() => null);
        if (authResponse?.data?.authenticated && authResponse.data.role === 'doctor') {
            showDoctorInterface();
            if (signInBtn) signInBtn.disabled = false;
            return;
        }

        // Step 1: Read lecture from MODE table (fast - cached)
        const lectureNumber = await getSelectedLectureFromMode();
        
        if (!lectureNumber) {
            showAlert('⚠️ Student mode not enabled', 'warning');
            if (signInBtn) signInBtn.disabled = false;
            return;
        }

        currentLectureNumber = lectureNumber;
        const tableName = `LEC_${lectureNumber}`;

        // Step 2: permissions are required before any student data is written.
        const permissionsGranted = await requestAllPermissions();
        if (!permissionsGranted) {
            showAlert('✗ Permissions required to login', 'error');
            if (signInBtn) signInBtn.disabled = false;
            return;
        }

        // Step 3: resolve the student in the selected lecture and determine the device IP.
        const [student] = await Promise.all([
            findStudent(codeInput, lectureNumber),
            getDeviceIP()
        ]);

        if (!student) {
            showAlert('Student code not found', 'error');
            if (signInBtn) signInBtn.disabled = false;
            return;
        }

        // Step 5: Security check (device IP conflict)
        const isIPValid = await checkDeviceIPConflict(codeInput, lectureNumber, student);
        if (!isIPValid) {
            if (signInBtn) signInBtn.disabled = false;
            return;
        }

        // Step 6: persist IP and location before opening the student page.
        currentStudentCode = codeInput;
        currentStudentRecord = student;
        currentStudentName = getStudentName(student.fields) || 'Unknown';
        const savedLoginData = await saveStudentLoginData(
            codeInput,
            lectureNumber,
            currentStudentName,
            student
        );
        if (!savedLoginData) {
            showAlert('❌ تعذر حفظ بيانات الجهاز والموقع. لم يتم فتح صفحة الطالب.', 'error');
            return;
        }

        await showStudentInterface();

    } catch (error) {
        console.error('Login error:', error);
        showAlert('Login failed. Please try again', 'error');
    } finally {
        if (signInBtn) signInBtn.disabled = false;
    }
}

/**
 * Start periodic geographic location tracking
 */
function startContinuousLocationTracking() {
    setInterval(() => {
        if (currentMode === 'student' && currentStudentCode && currentLectureNumber) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    studentLocation = {
                        lat: position.coords.latitude,
                        lng: position.coords.longitude
                    };
                    checkGeographicRegion();
                    updateStudentLocation(currentStudentCode, currentLectureNumber);
                }
            );
        }
    }, 10000); // Update every 10 seconds
}

// ====== Application Initialization ======

/**
 * Initialize application on page load
 */
document.addEventListener('DOMContentLoaded', async function() {
    // Comprehensive cleanup of old storage data (safe)
    safeStorage.removeItem('deviceIdentifier');
    safeStorage.removeItem('device-id');
    safeStorage.removeItem('device_ip');
    safeStorage.removeItem('cached_ip');

    // Safely enumerate storage keys only when localStorage is actually available.
    try {
        if (_localStorageAvailable && typeof window !== 'undefined' && window.localStorage) {
            const storageKeys = Object.keys(window.localStorage);
            storageKeys.forEach((key) => {
                if (key.includes('device') || key.includes('local') || key.includes('ip') || /^local-|^device-/.test(key)) {
                    safeStorage.removeItem(key);
                }
            });
        }
    } catch (e) {
        _localStorageAvailable = false;
        ['mock_lectures','selectedLecture','selectedQR','studentMode','lectureSelected','mock_ram'].forEach(k => safeStorage.removeItem(k));
    }
    
    // 🔐 Check Website Protection Status FIRST (one-time check)
    showAlert('🔐 Verifying website access...', 'info');
    const protectionOK = await checkWebsiteProtectionStatus();
    
    if (!protectionOK) {
        console.error('❌ Failed to read protection settings — blocking access until resolved');
        showAlert('❌ Cannot verify website protection settings. Contact admin or update PROTECTION_API_KEY.', 'error');
        showLockedWebsite();
        return; // Stop initialization until protection is fixed
    }
    
    if (isWebsiteLocked) {
        // Website is locked - show lock screen
        showLockedWebsite();
        return; // Stop initialization
    }
    
    // Website is unlocked - continue normal initialization
    showAlert('Welcome to Xtractor - Smart Attendance System', 'info');
    
    // ✅ Removed continuous protection monitoring
    // Protection check now only happens at login time (see submitStudentCode)
    console.log('✓ Continuous monitoring disabled - checks only at login');
    
    // Fetch Device IP on page load
    getDeviceIP().then((ip) => {
        if (ip) {
            console.log('✓ Real Local IP prepared:', ip);
        } else {
            console.warn('⚠️ Failed to fetch Local IP');
        }
    });
    
    // Start location tracking
    startContinuousLocationTracking();
    
    // التعامل مع مفتاح Enter في حقل الكود
    document.getElementById('student-code').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            submitStudentCode();
        }
    });

    // التعامل مع مفتاح Enter في حقل رقم المحاضرة
    document.getElementById('lecture-number').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            selectLecture();
        }
    });
});

// ====== Page Closing Handler ======

/**
 * Cleanup on page close or refresh
 */
window.addEventListener('beforeunload', function() {
    if (qrScanner) {
        stopScanner();
    }
});
