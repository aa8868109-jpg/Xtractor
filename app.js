// ============================================
// Xtractor Smart Attendance System - Main Application File
// ============================================

// ====== Basic Variables and Constants ======

// Airtable Data
// API keys moved to the server proxy. Do NOT store keys in client-side code.
// `BASE_ID` is loaded at runtime from a server endpoint (`/api/config`) so
// it can be provided via Vercel environment variables. Falls back to null.
let BASE_ID = null;
const STUDENTS_TABLE = 'LEC_1';
const MODE_TABLE = 'MODE'; // Mode control table (ON/OFF and lecture number)
const MODE_RECORD_NAME = 'Xtractor Website'; // Name of the only record in MODE table

// Proxy configuration (empty => same origin)
const API_PROXY_BASE = '';
let protectionCheckInterval = null;
let isWebsiteLocked = false;
let lockMessage = '';
let lockLink = '';
let doctorPassword = '';

// Variable to control using mock data or real data
const USE_MOCK_DATA = false; // تعيين true لاستخدام بيانات محاكاة، false لـ Airtable الحقيقي

// ====== Mock Data System ======


// Mock storage for lecture tables
let MOCK_LECTURES = {};

/**
 * Initialize mock data from localStorage
 */
function initMockData() {
    // Clean old data from localStorage
    localStorage.removeItem('deviceIdentifier');
    localStorage.removeItem('device-id');
    
    const stored = localStorage.getItem('mock_lectures');
    if (stored) {
        MOCK_LECTURES = JSON.parse(stored);
    }
}

/**
 * Save mock data to localStorage
 */
function saveMockData() {
    localStorage.setItem('mock_lectures', JSON.stringify(MOCK_LECTURES));
}

/**
 * Mock fetching data from Airtable
 */
async function mockFetch(endpoint, method = 'GET', data = null) {
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 300));
    
    return {
        status: 200,
        data: data || {}
    };
}

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

// Special Doctor Code (will be read from Protection table)
let DOCTOR_CODE = '13634';

// Geographic tolerance constant - approximately 15 meters
const REGION_TOLERANCE = 0.00015;

// State variables
let currentMode = null; // 'student' or 'doctor'
let currentStudentCode = null;
let currentStudentName = null; // To save student name
let currentLectureNumber = localStorage.getItem('selectedLecture'); // Load from localStorage
let lectureSelected = localStorage.getItem('lectureSelected') === 'true'; // Load from localStorage
let monitoringInterval = null; // 🎯 To monitor Student Mode changes
let studentLocation = null;
let qrScanner = null;
let scannedQRs = {
    qr1: false,
    qr2: false,
    qr3: false
};
let isProcessingQR = false; // Prevent concurrent processing
let deviceIP = null; // Device IP address

// ====== 🔐 Website Protection System Functions ======

/**
 * 🔐 Read Protection Settings from Airtable
 * Checks if website is locked or unlocked
 */
async function checkWebsiteProtectionStatus() {
    try {
        console.log('🔐 Checking website protection status via proxy...');

        const resp = await axios.get(`${API_PROXY_BASE}/api/protection`);

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

        console.log('📊 Protection Record (proxy):', fields);

        const protectionStatus = fields.Select || 'Unlock';
        isWebsiteLocked = protectionStatus === 'Lock';
        lockMessage = fields.Text || 'Website is currently locked';
        lockLink = fields.Link || '';
        doctorPassword = fields.Password || DOCTOR_CODE;
        DOCTOR_CODE = doctorPassword;

        console.log(`🔐 Protection Status: ${isWebsiteLocked ? 'LOCKED' : 'UNLOCKED'}`);
        return true;
    } catch (error) {
        console.error('❌ Error checking protection status (proxy):', error.response?.data || error.message || error);
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
        if (USE_MOCK_DATA) {
            // في حالة البيانات الوهمية، استخدم localStorage
            const qr = localStorage.getItem('selectedQR') || 'NONE';
            const lecture = localStorage.getItem('selectedLecture');
            
            // تحقق من أن QR محدد و المحاضرة موجودة
            if (qr !== 'NONE' && lecture) {
                console.log(`✓ Read lecture from localStorage: ${lecture}, QR: ${qr}`);
                return parseInt(lecture);
            } else {
                console.warn(`⚠️ QR not enabled: ${qr}, Lecture: ${lecture}`);
                return null;
            }
        }

        // البحث عن السجل في جدول MODE
        console.log('🔍 جاري البحث عن المحاضرة في جدول MODE...');
        const response = await axios.get(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(MODE_TABLE)}`,
            { headers: getAirtableHeaders() }
        );

        const records = (response && response.data && Array.isArray(response.data.records)) ? response.data.records : [];

        console.log('📋 عدد السجلات المتاحة:', records.length);

        if (records.length > 0) {
            // البحث عن السجل الصحيح - مع معالجة مرنة لأنواع البيانات
            let record = records.find(r => {
                const name = r.fields.Name || '';
                return name.trim() === MODE_RECORD_NAME.trim();
            });
            
            // إذا لم نجده، جرب البحث عن أول سجل إذا كان هناك واحد فقط
            if (!record && records.length === 1) {
                console.warn('⚠️ تم استخدام السجل الوحيد في الجدول');
                record = records[0];
            }
            
            if (record) {
                const lectureNum = record.fields.Lecture;
                const studentMode = record.fields['Student Mode'];
                const qrSelected = record.fields['QR Selected'] || 'NONE';
                
                console.log(`✓ تم العثور على السجل: Student Mode = ${studentMode}, Lecture = ${lectureNum}, QR Selected = ${qrSelected}`);
                
                // تحقق من أن الموضع مفعّل (ON) وأن QR محدد
                if ((studentMode === 'ON' || studentMode === true) && lectureNum && qrSelected !== 'NONE') {
                    console.log('✓ تم قراءة المحاضرة من MODE:', lectureNum, '- QR:', qrSelected);
                    return parseInt(lectureNum);
                } else {
                    console.warn('⚠️ وضع الطالب معطّل أو لا توجد محاضرة مختارة أو لم يتم تحديد QR');
                }
            } else {
                console.error(`❌ لم يتم العثور على سجل باسم "${MODE_RECORD_NAME}"`);
                console.log('أسماء السجلات المتاحة:');
                records.forEach((r, idx) => {
                    console.log(`  ${idx + 1}. "${r.fields.Name || '(فارغ)'}" - Student Mode: ${r.fields['Student Mode']} - Lecture: ${r.fields.Lecture} - QR: ${r.fields['QR Selected'] || 'NONE'}`);
                });
            }
        } else {
            console.error('❌ جدول MODE فارغ');
        }
        
        return null;
    } catch (error) {
        console.error('❌ خطأ في قراءة جدول MODE:', error);
        if (error.response?.status === 401 || error.response?.status === 403) {
            console.error('❌ خطأ في المصادقة: تحقق من API Key و BASE_ID');
            showAlert('❌ خطأ في المصادقة مع Airtable. تحقق من البيانات المدخلة', 'error');
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
        if (USE_MOCK_DATA) {
            // في حالة البيانات الوهمية، استخدم localStorage
            if (isEnabled) {
                localStorage.setItem('selectedLecture', lectureNumber);
                localStorage.setItem('studentMode', 'ON');
            } else {
                localStorage.setItem('studentMode', 'OFF');
            }
            return true;
        }

        // البحث عن السجل في جدول MODE
        console.log('🔍 جاري البحث في جدول MODE...');
        const response = await axios.get(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(MODE_TABLE)}`,
            { headers: getAirtableHeaders() }
        );

        const records = (response && response.data && Array.isArray(response.data.records)) ? response.data.records : [];

        console.log('📋 عدد السجلات المتاحة:', records.length);

        if (records.length === 0) {
            console.error('❌ No records found in MODE table');
            showAlert('❌ MODE table is empty or not found', 'error');
            return false;
        }

        // Search for the correct record - with flexible handling
        let record = records.find(r => {
            const name = r.fields.Name || '';
            return name.trim() === MODE_RECORD_NAME.trim();
        });
        
        // If not found, try searching for first record if there's only one
        if (!record && records.length === 1) {
            console.warn('⚠️ Using the only record in the table');
            record = records[0];
        }
        
        if (!record) {
            console.error(`❌ Record with name "${MODE_RECORD_NAME}" not found`);
            console.log('Available record names:');
            records.forEach((r, idx) => {
                console.log(`  ${idx + 1}. "${r.fields.Name || '(empty)'}" - ID: ${r.id}`);
            });
            showAlert(`❌ Record "${MODE_RECORD_NAME}" not found in MODE table`, 'error');
            return false;
        }

        const recordId = record.id;

        console.log('✓ Record found, updating...');

        // تحديث السجل
        const updateResponse = await axios.patch(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(MODE_TABLE)}/${recordId}`,
            {
                fields: {
                    'Lecture': isEnabled ? lectureNumber : null,
                    'Student Mode': isEnabled ? 'ON' : 'OFF'
                }
            },
            { headers: getAirtableHeaders() }
        );

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
        if (USE_MOCK_DATA) {
            // في حالة البيانات الوهمية، استخدم localStorage
            if (qrValue !== 'NONE') {
                localStorage.setItem('selectedLecture', lectureNumber);
                localStorage.setItem('selectedQR', qrValue);
                localStorage.setItem('studentMode', 'ON');
            } else {
                localStorage.setItem('selectedQR', 'NONE');
                localStorage.setItem('studentMode', 'OFF');
            }
            return true;
        }

        // البحث عن السجل في جدول MODE
        console.log('🔍 جاري البحث في جدول MODE...');
        const response = await axios.get(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(MODE_TABLE)}`,
            { headers: getAirtableHeaders() }
        );

        const records = (response && response.data && Array.isArray(response.data.records)) ? response.data.records : [];

        if (records.length === 0) {
            console.error('❌ No records found in MODE table');
            showAlert('❌ MODE table is empty or not found', 'error');
            return false;
        }

        // Search for the correct record
        let record = records.find(r => {
            const name = r.fields.Name || '';
            return name.trim() === MODE_RECORD_NAME.trim();
        });
        
        if (!record && records.length === 1) {
            console.warn('⚠️ Using the only record in the table');
            record = records[0];
        }
        
        if (!record) {
            console.error(`❌ Record with name "${MODE_RECORD_NAME}" not found`);
            return false;
        }

        const recordId = record.id;
        const studentMode = qrValue === 'NONE' ? 'OFF' : 'ON';

        console.log('✓ Record found, updating...');

        // تحديث السجل
        const updateResponse = await axios.patch(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(MODE_TABLE)}/${recordId}`,
            {
                fields: {
                    'Lecture': lectureNumber,
                    'QR Selected': qrValue === 'NONE' ? null : qrValue,
                    'Student Mode': studentMode
                }
            },
            { headers: getAirtableHeaders() }
        );

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
        if (USE_MOCK_DATA) {
            // في حالة البيانات الوهمية، استخدم localStorage
            const qr = localStorage.getItem('selectedQR') || 'NONE';
            console.log(`📋 Loaded QR from localStorage: ${qr}`);
            return qr;
        }

        // البحث عن السجل في جدول MODE
        console.log('🔍 جاري البحث عن QR المختار في جدول MODE...');
        const response = await axios.get(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(MODE_TABLE)}`,
            { headers: getAirtableHeaders() }
        );

        const records = (response && response.data && Array.isArray(response.data.records)) ? response.data.records : [];

        if (records.length > 0) {
            // البحث عن السجل الصحيح
            let record = records.find(r => {
                const name = r.fields.Name || '';
                return name.trim() === MODE_RECORD_NAME.trim();
            });
            
            if (!record && records.length === 1) {
                console.warn('⚠️ تم استخدام السجل الوحيد في الجدول');
                record = records[0];
            }
            
            if (record) {
                const qrSelected = record.fields['QR Selected'] || 'NONE';
                const studentMode = record.fields['Student Mode'];
                
                console.log(`✓ تم العثور على السجل: QR Selected = ${qrSelected}, Student Mode = ${studentMode}`);
                
                // تحقق من أن وضع الطالب مفعّل وأن QR محدد
                if ((studentMode === 'ON' || studentMode === true) && qrSelected !== 'NONE') {
                    console.log('✓ تم قراءة QR المختار من MODE:', qrSelected);
                    return qrSelected;
                } else {
                    console.warn('⚠️ وضع الطالب معطّل أو لا يوجد QR محدد');
                }
            } else {
                console.error(`❌ لم يتم العثور على سجل باسم "${MODE_RECORD_NAME}"`);
            }
        } else {
            console.error('❌ جدول MODE فارغ');
        }
        
        return 'NONE';
    } catch (error) {
        console.error('❌ خطأ في قراءة جدول MODE:', error);
        return 'NONE';
    }
}

/**
 * 🎚️ تحديث حالة QR Selection من Airtable (عند تحميل صفحة الدكتور)
 */
async function updateQRSelectionDisplay() {
    try {
        if (USE_MOCK_DATA) {
            const selectedQR = localStorage.getItem('selectedQR') || 'NONE';
            const statusDiv = document.getElementById('mode-status');
            
            if (statusDiv) {
                if (selectedQR === 'NONE') {
                    statusDiv.textContent = '✗ Status: No QR Selected';
                    statusDiv.style.color = '#c62828';
                } else {
                    statusDiv.textContent = `✓ Status: ${selectedQR} Active`;
                    statusDiv.style.color = '#2e7d32';
                }
            }
            
            // Set radio button
            const radio = document.querySelector(`input[name="qr-select"][value="${selectedQR}"]`);
            if (radio) {
                radio.checked = true;
            }
            return;
        }

        const response = await axios.get(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(MODE_TABLE)}`,
            { headers: getAirtableHeaders() }
        );

        // Defensive: ensure response structure is valid
        const records = (response && response.data && Array.isArray(response.data.records)) ? response.data.records : [];

        if (records.length === 0) return;

        let record = records.find(r => {
            const name = r.fields.Name || '';
            return name.trim() === MODE_RECORD_NAME.trim();
        }) || records[0];

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
 * 🎚️ تحديث حالة Toggle من Airtable (Legacy - kept for compatibility)
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
async function checkDeviceIPConflict(studentCode, lectureNumber) {
    const currentIP = await getDeviceIP();
    console.log(`🔍 فحص تضارب IP: Code=${studentCode}, IP=${currentIP}, Lecture=${lectureNumber}`);
    
    if (!currentIP) {
        console.error('❌ لم تتمكن من الحصول على IP');
        showAlert('❌ جهازك غير مدعوم أو الشبكة غير متوفرة - لا يمكن تحديد Local IP', 'error');
        return false;
    }

    try {
        const tableName = `LEC_${lectureNumber}`;
        
        if (USE_MOCK_DATA) {
            console.log('📋 فحص Mock Data...');
            // محاكاة جدول RAM
            let mockRAM = JSON.parse(localStorage.getItem('mock_ram') || '{}');
            console.log('RAM Mock Data:', mockRAM);
            
            // ✅ الفحص الأول: إذا كان هناك IP مسجل في RAM مع كود مختلف
            for (const code in mockRAM) {
                if (mockRAM[code] === currentIP && code !== studentCode) {
                    console.warn(`⚠️ نفس IP مُستخدم برمز جامعي مختلف: ${code}`);
                    showAlert(`❌ هذا الجهاز مسجل برمز جامعي مختلف (${code}) - لا يمكن الدخول`, 'error');
                    return false;
                }
            }
            
            // فحص في جدول المحاضرة (تاريخ الحضور)
            if (!MOCK_LECTURES[tableName]) {
                console.log(`✓ جدول ${tableName} فارغ - سماح`);
                return true;
            }
            
            // ✅ الفحص الأول: هل IP مسجل برمز مختلف؟
            for (const code in MOCK_LECTURES[tableName]) {
                const student = MOCK_LECTURES[tableName][code];
                if (student['Device IP'] && student['Device IP'] === currentIP && code !== studentCode) {
                    console.warn(`⚠️ نفس IP مُستخدم برمز جامعي مختلف: ${code}`);
                    showAlert(`❌ هذا الجهاز مرتبط برمز جامعي مختلف (${code}) - لا يمكن تسجيل الدخول`, 'error');
                    return false;
                }
            }
            
            // ✅ الفحص الثاني: هل رمز الطالب هذا عنده IP مختلف مسجل؟
            if (MOCK_LECTURES[tableName][studentCode]) {
                const studentData = MOCK_LECTURES[tableName][studentCode];
                if (studentData['Device IP'] && studentData['Device IP'] !== currentIP && studentData['Device IP'] !== 'Unknown') {
                    console.warn(`⚠️ رمز الطالب ${studentCode} عنده IP مختلف مسجل: ${studentData['Device IP']}`);
                    showAlert(`❌ رمز الطالب هذا مسجل من IP مختلف - لا يمكن تسجيل الدخول من جهاز جديد`, 'error');
                    return false;
                }
            }
            
            console.log('✓ فحص Mock Data: سماح');
            return true;
        }

        // ✅ الفحص الأول: البحث في جدول المحاضرة عن IP (هل مسجل برمز مختلف؟)
        console.log(`🔍 الفحص الأول - فحص جدول ${tableName} عن IP: ${currentIP}`);
        const lectureResponseByIP = await axios.get(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(tableName)}?filterByFormula=({Device IP}='${currentIP}')`,
            { headers: getAirtableHeaders() }
        );

        console.log('فحص IP في جدول المحاضرة:', lectureResponseByIP.data.records.length, 'records');
        if (lectureResponseByIP.data.records.length > 0) {
            const lectureRecord = lectureResponseByIP.data.records[0];
            const registeredCode = String(lectureRecord.fields.Code); // ✅ تحويل إلى String
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
        const lectureResponseByCode = await axios.get(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(tableName)}?filterByFormula=({Code}='${studentCode}')`,
            { headers: getAirtableHeaders() }
        );

        console.log('فحص الكود في جدول المحاضرة:', lectureResponseByCode.data.records.length, 'records');
        if (lectureResponseByCode.data.records.length > 0) {
            const studentRecord = lectureResponseByCode.data.records[0];
            const registeredIP = studentRecord.fields['Device IP'];
            console.log(`✓ وجد كود الطالب في ${tableName}: Code=${studentCode}, Device IP=${registeredIP}`);
            
            if (registeredIP && registeredIP !== currentIP && registeredIP !== 'Unknown') {
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
        return true; // السماح بالدخول عند الخطأ
    }
}

// ====== وظائف طلب الصلاحيات ======

/**
 * طلب صلاحية الكاميرا
 */
async function requestCameraPermission() {
    try {
        await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
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
    
    // طلب الصلاحيات
    const permissionsGranted = await requestAllPermissions();
    if (!permissionsGranted) {
        showAlert('بعض الصلاحيات غير متاحة، سيتم استخدام بيانات اختبار', 'warning');
    }
    
    currentMode = 'student';
    
    // 📖 قراءة الأكواد المحفوظة من Airtable وتحديث العلامات
    const tableName = `LEC_${currentLectureNumber}`;
    await loadStudentScannedQRs(currentStudentCode, currentLectureNumber, tableName);
    
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
        
        // 🎚️ Update toggle status (check current status from Airtable)
        updateToggleStatus();
        
        // Start updating student list immediately
        startLectureStudentUpdates();
    }
    
    currentMode = 'doctor';
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
    deviceIP = null; // ✅ Important: Reset Device IP
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

// ====== Airtable Functions ======

/**
 * Create HTTP request headers
 */
function getAirtableHeaders() {
    // Authorization is handled by the server proxy. Client only sends JSON content-type.
    return { 'Content-Type': 'application/json' };
}

/**
 * Load server-side config (provided via environment variables on Vercel)
 * Expected response: { BASE_ID: 'appXXXXX' }
 */
async function loadServerConfig() {
    try {
        if (typeof axios === 'undefined') return;
        const resp = await axios.get(`${API_PROXY_BASE}/api/config`);
        if (resp && resp.data) {
                console.log('🔎 /api/config response (client):', resp.data);
            if (resp.data.BASE_ID) {
                BASE_ID = resp.data.BASE_ID;
                console.log('✓ Loaded BASE_ID from server config');
            } else {
                console.warn('⚠️ Server config returned but BASE_ID not set');
            }
        }
    } catch (error) {
        console.warn('⚠️ Could not load server config:', error?.response?.data || error.message || error);
    }
}

// Intercept direct Airtable URLs and route them through local proxy so keys are never exposed
if (typeof axios !== 'undefined' && axios.interceptors) {
    axios.interceptors.request.use(async function (config) {
        try {
            const url = config.url || '';
            const prefix = 'https://api.airtable.com/v0/';
            // Only attempt to load server config when we're about to rewrite an Airtable URL
            if (url.startsWith(prefix)) {
                const rest = url.slice(prefix.length); // baseId/rest/of/path
                const parts = rest.split('/');
                let baseId = parts.shift();
                const path = parts.join('/');

                // If the request used a placeholder like 'null' or 'undefined', reload config
                if (!baseId || baseId === 'null' || baseId === 'undefined') {
                    try {
                        await loadServerConfig();
                    } catch (e) {
                        // ignore
                    }
                    // prefer loaded BASE_ID if available
                    if (BASE_ID) baseId = BASE_ID;
                }
                // preserve querystring
                const qsIndex = url.indexOf('?');
                const qs = qsIndex !== -1 ? url.slice(qsIndex) : '';
                config.url = `${API_PROXY_BASE}/api/airtable/${baseId}/${path}${qs}`;
                // remove any auth header that might exist
                if (config.headers) delete config.headers['Authorization'];
            }
            // Also handle requests already targeted at the local proxy that may contain 'null' as baseId
            const proxyPath = '/api/airtable/';
            const proxyIdx = url.indexOf(proxyPath);
            if (proxyIdx !== -1) {
                try {
                    const after = url.slice(proxyIdx + proxyPath.length); // baseId/rest...
                    const parts = after.split('/');
                    let baseId = parts.shift();
                    const restPath = parts.join('/');
                    if (!baseId || baseId === 'null' || baseId === 'undefined') {
                        try {
                            await loadServerConfig();
                        } catch (e) {}
                        if (BASE_ID) baseId = BASE_ID;
                    }
                    // rebuild url if we substituted baseId
                    if (baseId && baseId !== 'null' && baseId !== 'undefined') {
                        const qsIndex = url.indexOf('?');
                        const qs = qsIndex !== -1 ? url.slice(qsIndex) : '';
                        // Preserve origin if present
                        const origin = url.slice(0, proxyIdx);
                        config.url = `${origin}${proxyPath}${baseId}/${restPath}${qs}`;
                    }
                } catch (e) {
                    // ignore
                }
            }
        } catch (e) {
            // ignore
        }
        return config;
    }, function (err) { return Promise.reject(err); });
}

/**
 * Search for student in Airtable or mock data
 */
async function findStudent(studentCode) {
    // إذا كنا نستخدم البيانات الوهمية، ابحث فيها أولاً
    if (USE_MOCK_DATA && MOCK_STUDENTS[studentCode]) {
        return MOCK_STUDENTS[studentCode];
    }

    try {
        const response = await axios.get(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(STUDENTS_TABLE)}?filterByFormula=({Code}='${studentCode}')`,
            { headers: getAirtableHeaders() }
        );

        const records = (response && response.data && Array.isArray(response.data.records)) ? response.data.records : [];
        if (records.length > 0) {
            return records[0];
        }
        return null;
    } catch (error) {
        console.error('Error searching for student:', error);
        // If Airtable connection fails, use mock data
        if (USE_MOCK_DATA && MOCK_STUDENTS[studentCode]) {
            return MOCK_STUDENTS[studentCode];
        }
        return null;
    }
}

/**
 * Save Device IP on first student login (for security and verification)
 */
async function saveDeviceIPForStudent(studentCode, lectureNumber) {
    try {
        const tableName = `LEC_${lectureNumber}`;
        console.log(`🔄 Starting to save Device IP for student ${studentCode} in table ${tableName}...`);
        
        if (USE_MOCK_DATA) {
            // Save in mock data
            if (!MOCK_LECTURES[tableName]) {
                MOCK_LECTURES[tableName] = {};
            }
            if (!MOCK_LECTURES[tableName][studentCode]) {
                MOCK_LECTURES[tableName][studentCode] = {};
            }
            MOCK_LECTURES[tableName][studentCode]['Device IP'] = deviceIP || 'Unknown';
            saveMockData();
            console.log(`✓ Device IP saved in lecture: ${deviceIP}`);
            return;
        }

        // Search for student record in Airtable
        const response = await axios.get(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(tableName)}?filterByFormula=({Code}='${studentCode}')`,
            { headers: getAirtableHeaders() }
        );

        const records = (response && response.data && Array.isArray(response.data.records)) ? response.data.records : [];
        if (records.length > 0) {
            // ✅ Update existing record
            const recordId = records[0].id;
            await axios.patch(
                `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(tableName)}/${recordId}`,
                {
                    fields: {
                        'Device IP': deviceIP || 'Unknown'
                    }
                },
                { headers: getAirtableHeaders() }
            );
            console.log(`✓ Device IP updated in table ${tableName}: ${deviceIP}`);
        } else {
            // ✅ Create new record if not found
            console.warn(`⚠️ Student ${studentCode} not found in table ${tableName} - will be added`);
            // Do not create new record - this is an error, student must exist
        }
        
    } catch (error) {
        console.error('❌ Error saving Device IP in lecture table:', error);
    }
}

/**
 * Update student data in lecture table (mock or real)
 */
async function updateStudentAttendance(studentCode, lectureNumber, tableName, columnName) {
    try {
        if (USE_MOCK_DATA) {
            // Create table if not exists
            if (!MOCK_LECTURES[tableName]) {
                MOCK_LECTURES[tableName] = {};
            }
            
            // Search for student
            if (!MOCK_LECTURES[tableName][studentCode]) {
                const mapsLink = `https://maps.google.com/?q=${studentLocation.lat},${studentLocation.lng}`;
                MOCK_LECTURES[tableName][studentCode] = {
                    Name: MOCK_STUDENTS[studentCode]?.fields?.Name || 'Unknown',
                    Code: studentCode,
                    Location: mapsLink,
                    Region: 'In region',
                    'Device IP': deviceIP || 'Unknown',
                    '1st QR': false,
                    '2nd QR': false,
                    '3rd QR': false
                };
            }
            
            // Create Google Maps link
            const mapsLink = `https://maps.google.com/?q=${studentLocation.lat},${studentLocation.lng}`;
            
            // Update QR based on column name
            MOCK_LECTURES[tableName][studentCode][columnName] = true;
            MOCK_LECTURES[tableName][studentCode].Location = mapsLink;
            MOCK_LECTURES[tableName][studentCode].Region = checkGeographicRegion();
            MOCK_LECTURES[tableName][studentCode]['Device IP'] = deviceIP || 'Unknown';
            
            // Save data
            saveMockData();
            
            console.log('✓ Student data updated (Mock):', MOCK_LECTURES[tableName][studentCode]);
            return { success: true };
        }
        
        // Real Airtable code
        const response = await axios.get(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(tableName)}?filterByFormula=({Code}='${studentCode}')`,
            { headers: getAirtableHeaders() }
        );

        const records = (response && response.data && Array.isArray(response.data.records)) ? response.data.records : [];
        if (records.length === 0) {
            console.error('❌ Student not found in lecture table');
            return null;
        }

        // Create Google Maps link from coordinates
        const mapsLink = `https://maps.google.com/?q=${studentLocation.lat},${studentLocation.lng}`;
        
        const studentRecord = records[0];
        const recordId = studentRecord.id;
        
        // Determine Region based on student location
        const region = checkGeographicRegion();
        
        const updateResponse = await axios.patch(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(tableName)}/${recordId}`,
            {
                fields: {
                    [columnName]: true,
                    'Location': mapsLink,
                    'Region': region,
                    'Device IP': deviceIP || 'Unknown'
                }
            },
            { headers: getAirtableHeaders() }
        );

        console.log(`✓ تم تحديث ${columnName} والموقع والـ Device IP والـ Region للطالب في جدول ${tableName}`);
        return updateResponse.data;
    } catch (error) {
        console.error('خطأ في تحديث بيانات الطالب:', error);
        return null;
    }
}

/**
 * إضافة طالب جديد إلى جدول المحاضرة (محاكاة أو حقيقي)
 */
async function addStudentToLecture(studentCode, lectureNumber, tableName) {
    try {
        // إذا لم يتم تمرير اسم الجدول، استخدم الصيغة الافتراضية
        if (!tableName) {
            tableName = `LEC_${lectureNumber}`;
        }
        
        if (USE_MOCK_DATA) {
            if (!MOCK_LECTURES[tableName]) {
                MOCK_LECTURES[tableName] = {};
            }
            
            const studentRecord = await findStudent(studentCode);
            if (!studentRecord) return null;

            const studentName = studentRecord.fields.Name || '';
            
            const mapsLink = `https://maps.google.com/?q=${studentLocation?.lat || 0},${studentLocation?.lng || 0}`;
            
            MOCK_LECTURES[tableName][studentCode] = {
                Name: studentName,
                Code: studentCode,
                Location: mapsLink,
                Region: 'In region',
                'Device IP': deviceIP || 'Unknown',
                '1st QR': false,
                '2nd QR': false,
                '3rd QR': false
            };
            
            saveMockData();
            
            return {
                id: `mock_${studentCode}`,
                fields: MOCK_LECTURES[tableName][studentCode]
            };
        }
        
        // الكود الحقيقي لـ Airtable
        const studentRecord = await findStudent(studentCode);
        if (!studentRecord) return null;

        const studentName = studentRecord.fields.Name || '';
        
        const response = await axios.post(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(tableName)}`,
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
            { headers: getAirtableHeaders() }
        );

        console.log(`✓ تم إضافة الطالب ${studentCode} إلى جدول ${tableName} مع Device IP`);
        const records = (response && response.data && Array.isArray(response.data.records)) ? response.data.records : [];
        return records.length > 0 ? records[0] : null;
    } catch (error) {
        console.error('خطأ في إضافة طالب جديد:', error);
        return null;
    }
}

/**
 * Update student location in Airtable (mock or real)
 */
async function updateStudentLocation(studentCode, lectureNumber) {
    try {
        const tableName = `LEC_${lectureNumber}`; // Use correct format
        
        // Create Google Maps link
        const mapsLink = `https://maps.google.com/?q=${studentLocation.lat},${studentLocation.lng}`;
        
        if (USE_MOCK_DATA) {
            if (!MOCK_LECTURES[tableName]) {
                MOCK_LECTURES[tableName] = {};
            }
            
            if (MOCK_LECTURES[tableName][studentCode]) {
                const regionStatus = checkGeographicRegion();
                MOCK_LECTURES[tableName][studentCode].Location = mapsLink;
                MOCK_LECTURES[tableName][studentCode].Region = regionStatus;
                MOCK_LECTURES[tableName][studentCode]['Device IP'] = deviceIP || 'Unknown';
                saveMockData();
            }
            return;
        }
        
        // Real Airtable code
        const response = await axios.get(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(tableName)}?filterByFormula=({Code}='${studentCode}')`,
            { headers: getAirtableHeaders() }
        );

        const records = (response && response.data && Array.isArray(response.data.records)) ? response.data.records : [];
        if (records.length > 0) {
            const recordId = records[0].id;
            const regionStatus = checkGeographicRegion();
            
            await axios.patch(
                `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(tableName)}/${recordId}`,
                {
                    fields: {
                        'Location': mapsLink,
                        'Region': regionStatus,
                        'Device IP': deviceIP || 'Unknown'
                    }
                },
                { headers: getAirtableHeaders() }
            );
        }
    } catch (error) {
        console.error('Error updating student location:', error);
    }
}

/**
 * Fetch list of students for specified lecture (mock or real)
 */
async function fetchLectureStudents(lectureNumber) {
    try {
        const tableName = `LEC_${lectureNumber}`; // Use correct format
        
        if (USE_MOCK_DATA) {
            if (!MOCK_LECTURES[tableName]) {
                return [];
            }
            
            // Convert mock data to Airtable format
            const students = [];
            for (const code in MOCK_LECTURES[tableName]) {
                students.push({
                    id: `mock_${code}`,
                    fields: MOCK_LECTURES[tableName][code]
                });
            }
            return students;
        }
        
        // Real Airtable code
        const response = await axios.get(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(tableName)}`,
            { headers: getAirtableHeaders() }
        );

        // Defensive: ensure response structure is valid
        if (!response || !response.data || !Array.isArray(response.data.records)) {
            console.warn('⚠️ Unexpected response from Airtable while fetching students', response);
            return [];
        }

        return response.data.records;
    } catch (error) {
        console.error('Error fetching students:', error);
        return [];
    }
}

// ====== Geographic Verification Functions ======

/**
 * قراءة الأكواد المحفوظة للطالب من Airtable وتحديث العلامات
 */
async function loadStudentScannedQRs(studentCode, lectureNumber, tableName) {
    try {
        console.log(`📖 جاري قراءة الأكواد المحفوظة للطالب ${studentCode}...`);
        
        if (USE_MOCK_DATA) {
            // قراءة من البيانات الوهمية
            if (MOCK_LECTURES[tableName] && MOCK_LECTURES[tableName][studentCode]) {
                const studentData = MOCK_LECTURES[tableName][studentCode];
                
                // تحديث حالة scannedQRs
                scannedQRs.qr1 = studentData['1st QR'] === true;
                scannedQRs.qr2 = studentData['2nd QR'] === true;
                scannedQRs.qr3 = studentData['3rd QR'] === true;
                
                console.log('✓ تم قراءة البيانات (Mock):', scannedQRs);
                updateQRCheckmarks();
                return;
            }
        }
        
        // قراءة من Airtable الحقيقي
        const response = await axios.get(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(tableName)}?filterByFormula=({Code}='${studentCode}')`,
            { headers: getAirtableHeaders() }
        );

        if (response.data.records.length === 0) {
            console.warn('⚠️ لم يتم العثور على سجل الطالب');
            return;
        }

        const studentRecord = response.data.records[0];
        const fields = studentRecord.fields;

        // تحديث حالة scannedQRs بناءً على البيانات المحفوظة
        scannedQRs.qr1 = fields['1st QR'] === true;
        scannedQRs.qr2 = fields['2nd QR'] === true;
        scannedQRs.qr3 = fields['3rd QR'] === true;

        console.log('✓ تم قراءة الأكواس المحفوظة من Airtable:', scannedQRs);
        
        // تحديث العلامات الثلاث على الواجهة
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
        
        // تحديث Airtable أولاً قبل تضييء العلامة
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
            
            // انتظر نتيجة التحديث في Airtable
            const updateResult = await updateStudentAttendance(currentStudentCode, currentLectureNumber, tableName, columnName);
            
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

    showAlert('Activating lecture on server...', 'info');

    // Ensure BASE_ID is loaded before attempting server updates
    if (!BASE_ID) {
        try {
            await loadServerConfig();
        } catch (e) {
            console.warn('⚠️ Failed loading server config before activating lecture:', e);
        }
    }

    // Update MODE table on the server to enable Student Mode and set Lecture
    const activated = await updateStudentMode(lectureNumber, true);
    if (!activated) {
        showAlert('❌ Failed to activate lecture on server. Check MODE table and try again.', 'error');
        return;
    }

    // Local state + UI updates only after server-side activation succeeds
    currentLectureNumber = lectureNumber;
    lectureSelected = true;

    // Save to localStorage as well
    localStorage.setItem('selectedLecture', lectureNumber);
    localStorage.setItem('lectureSelected', 'true');

    // Display lecture information
    document.getElementById('current-lecture').textContent = `Lec ${lectureNumber}`;
    document.getElementById('lecture-info').style.display = 'block';

    // Load QR selection status for this lecture
    await updateQRSelectionDisplay();

    showAlert(`✓ Lecture ${lectureNumber} activated - Select a QR code to enable`, 'success');

    // Start updating student list
    startLectureStudentUpdates();
}

/**
 * 🎚️ تحديث حالة Toggle من Airtable
 */


/**
 * 📊 Start monitoring Student Mode for students (check every 2 seconds)
 */
function startStudentModeMonitoring() {
    console.log('📊 Starting Student Mode monitoring...');
    
    // Check first time immediately
    checkStudentModeStatus();
    
    // Check every 2 seconds
    monitoringInterval = setInterval(() => {
        if (currentMode === 'student') {
            checkStudentModeStatus();
        }
    }, 2000);
}

/**
 * 🔍 Check current Student Mode status
 */
async function checkStudentModeStatus() {
    try {
        if (USE_MOCK_DATA) {
            const studentMode = localStorage.getItem('studentMode');
            if (studentMode === 'OFF' && currentMode === 'student') {
                console.warn('⚠️ Mock: Student mode stopped! - Closing page...');
                showAlert('⛔ Student mode disabled by instructor - Exiting', 'warning');
                setTimeout(() => {
                    exitMode();
                }, 1500);
            }
            return;
        }

        const response = await axios.get(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(MODE_TABLE)}`,
            { headers: getAirtableHeaders() }
        );

        if (response.data.records.length === 0) {
            console.warn('⚠️ MODE table is empty');
            return;
        }

        let record = response.data.records.find(r => {
            const name = r.fields.Name || '';
            return name.trim() === MODE_RECORD_NAME.trim();
        }) || response.data.records[0];

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
        console.error('⚠️ Error checking Student Mode:', error.message);
    }
}

/**
 * Start updating student list periodically
 */
function startLectureStudentUpdates() {
    // Update first time immediately
    updateStudentsList();
    
    // Update every 3 seconds
    setInterval(() => {
        if (currentMode === 'doctor' && currentLectureNumber) {
            updateStudentsList();
        }
    }, 3000);
}

/**
 * Update registered student list
 * Display only students who scanned at least one QR
 */
async function updateStudentsList() {
    if (!currentLectureNumber) return;
    
    const students = await fetchLectureStudents(currentLectureNumber);
    const studentsList = document.getElementById('students-list');
    
    // Filter students - show only those with at least one QR code true
    const attendedStudents = students.filter(record => {
        const student = record.fields;
        const has1stQR = student['1st QR'] === true;
        const has2ndQR = student['2nd QR'] === true;
        const has3rdQR = student['3rd QR'] === true;
        return has1stQR || has2ndQR || has3rdQR;
    });
    
    if (attendedStudents.length === 0) {
        studentsList.innerHTML = '<div class="empty-list">No students have scanned QR codes yet</div>';
        return;
    }

    let html = '';
    attendedStudents.forEach(record => {
        const student = record.fields;
        const studentCode = student.Code || 'N/A';
        const studentName = student.Name || 'Unknown';
        const region = student.Region || 'Unknown';
        
        // Count scanned QR codes
        const qrCount = (student['1st QR'] ? 1 : 0) + (student['2nd QR'] ? 1 : 0) + (student['3rd QR'] ? 1 : 0);
        const qrStatus = `(${qrCount}/3 QR)`;
        
        // Check if student is out of region
        const isOutRegion = region === 'Out region';
        const locationIndicator = isOutRegion ? '<span class="location-alert-indicator" title="Student is out of region">📍</span>' : '';
        
        html += `
            <div class="student-item ${isOutRegion ? 'out-of-region' : ''}">
                <div class="student-info">
                    <div class="student-name">${studentName} ${locationIndicator}</div>
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
            
            students.forEach(record => {
                const fields = record.fields;
                const code = fields.Code;
                const name = fields.Name;
                const region = fields.Region || 'Unknown';
                
                // Count QR codes scanned
                const qrCount = (fields['1st QR'] === true ? 1 : 0) + 
                               (fields['2nd QR'] === true ? 1 : 0) + 
                               (fields['3rd QR'] === true ? 1 : 0);
                
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

        // Prepare data for Excel
        const excelData = [];
        
        students.forEach(record => {
            const fields = record.fields;
            excelData.push({
                'الاسم': fields.Name || '---',
                'الكود': fields.Code || '---',
                '1st QR': fields['1st QR'] === true ? 'X' : '',
                '2nd QR': fields['2nd QR'] === true ? 'X' : '',
                '3rd QR': fields['3rd QR'] === true ? 'X' : '',
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

        // Doctor code check after loading the current password from Airtable
        if (codeInput === DOCTOR_CODE) {
            showDoctorInterface();
            if (signInBtn) signInBtn.disabled = false;
            return;
        }

        if (isWebsiteLocked) {
            showAlert('⛔ Website has been locked by administrator', 'error');
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

        // Step 2-4: Run in parallel (permissions, student search, device IP)
        const [permissionsGranted, student, _] = await Promise.all([
            requestAllPermissions(),
            findStudent(codeInput),
            getDeviceIP()
        ]);
        
        if (!permissionsGranted) {
            showAlert('✗ Permissions required to login', 'error');
            if (signInBtn) signInBtn.disabled = false;
            return;
        }

        if (!student) {
            showAlert('Student code not found', 'error');
            if (signInBtn) signInBtn.disabled = false;
            return;
        }

        // Step 5: Security check (device IP conflict)
        const isIPValid = await checkDeviceIPConflict(codeInput, lectureNumber);
        if (!isIPValid) {
            showAlert('❌ Device already registered with different code', 'error');
            if (signInBtn) signInBtn.disabled = false;
            return;
        }

        // Step 6: Save data and show interface
        currentStudentCode = codeInput;
        currentStudentName = student.fields?.Name || 'Unknown';
        
        // Save Device IP in background (don't wait)
        saveDeviceIPForStudent(codeInput, lectureNumber).catch(err => {
            console.warn('Warning saving device IP:', err);
        });
        
        // Show interface immediately
        await showStudentInterface();

    } catch (error) {
        console.error('Login error:', error);
        showAlert('Login failed. Please try again', 'error');
    } finally {
        if (signInBtn) signInBtn.disabled = false;
    }
}

/**
 * Optimized student finder - searches STUDENTS_TABLE (المرجع الأساسي)
 */
async function findStudent(studentCode) {
    // إذا كنا نستخدم البيانات الوهمية، ابحث فيها أولاً
    if (USE_MOCK_DATA && MOCK_STUDENTS[studentCode]) {
        return MOCK_STUDENTS[studentCode];
    }

    try {
        // البحث في جدول الطلاب الأساسي (STUDENTS_TABLE)
        const response = await axios.get(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(STUDENTS_TABLE)}?filterByFormula=({Code}='${studentCode}')`,
            { headers: getAirtableHeaders() }
        );
        
        return response.data.records.length > 0 ? response.data.records[0] : null;
    } catch (error) {
        console.error('Error searching for student:', error);
        return null;
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
    // Comprehensive cleanup of old localStorage data
    localStorage.removeItem('deviceIdentifier');
    localStorage.removeItem('device-id');
    localStorage.removeItem('device_ip');
    localStorage.removeItem('cached_ip');
    
    // Delete any key containing "device", "local", or "ip"
    for (let key in localStorage) {
        if (key.includes('device') || key.includes('local') || key.includes('ip') || key.match(/^local-|^device-/)) {
            localStorage.removeItem(key);
        }
    }
    
    // Initialize mock data
    initMockData();
    
    // Display operation mode message
    if (USE_MOCK_DATA) {
        console.log('🔄 System running with Mock Data');
    } else {
        console.log('🔗 System running with real Airtable');
    }
    
    // 🔐 Check Website Protection Status FIRST (one-time check)
    showAlert('🔐 Verifying website access...', 'info');

    // Load server-provided config (e.g. BASE_ID) before making Airtable calls
    try {
        await loadServerConfig();
    } catch (e) {
        console.warn('⚠️ loadServerConfig failed:', e);
    }

    if (!BASE_ID) {
        console.error('❌ BASE_ID is not configured on the server. Aborting initialization.');
        showAlert('❌ Server configuration missing BASE_ID. Contact admin.', 'error');
        showLockedWebsite();
        return;
    }

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
