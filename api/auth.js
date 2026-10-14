const { getFirestore } = require('../lib/firebase');
const {
    SESSION_COOKIE_NAME,
    createSessionToken,
    getCookieValue,
    getDoctorSessionCookieName,
    validateSessionToken
} = require('../lib/session');
const { logSecurityEvent } = require('../lib/security-logger');
const { checkRateLimit } = require('../lib/rate-limit');
const { checkLoginRateLimit, respondToLogin } = require('../lib/login-attempts');
const { enforceSameOrigin } = require('../lib/request-security');
const {
    DEVICE_COOKIE_NAME,
    createDeviceToken,
    hasDeviceIdConflict,
    hasFingerprintConflict,
    hashDeviceToken,
    isValidDeviceFingerprint,
    isValidDeviceToken
} = require('../lib/device-policy');
const { findDoctorAccountMatches } = require('../lib/doctor-accounts');
const { getCourseStorageFieldName, getModeCourseLecture, getModeCourseMap, hasAnyActiveCourseLecture, normalizeCourseName } = require('../lib/course-policy');

function getCookieSecurityFlags(req = null) {
    const proto = (req?.headers?.['x-forwarded-proto'] || req?.headers?.['X-Forwarded-Proto'] || '').toLowerCase();
    const isHttps = proto.includes('https') || req?.socket?.encrypted || process.env.NODE_ENV === 'production';
    const secureFlag = isHttps ? '; Secure' : '';
    return `SameSite=Lax${secureFlag}`;
}

function setSessionCookie(res, token, req = null, deviceToken = null, sessionCookieName = SESSION_COOKIE_NAME) {
    const securityFlags = getCookieSecurityFlags(req);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const cookies = [`${sessionCookieName}=${encodeURIComponent(token)}; Path=/; Max-Age=3600; HttpOnly; ${securityFlags};`];
    if (deviceToken) {
        cookies.push(`${DEVICE_COOKIE_NAME}=${encodeURIComponent(deviceToken)}; Path=/; Max-Age=31536000; HttpOnly; ${securityFlags};`);
    }
    res.setHeader('Set-Cookie', cookies);
}

function clearSessionCookie(res, req = null) {
    const securityFlags = getCookieSecurityFlags(req);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const requestedCourse = req?.headers?.['x-xtractor-session-course'] || req?.headers?.['X-Xtractor-Session-Course'];
    const cookieName = requestedCourse
        ? getDoctorSessionCookieName(requestedCourse)
        : SESSION_COOKIE_NAME;
    if (!cookieName) {
        res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; ${securityFlags};`);
        return;
    }
    res.setHeader('Set-Cookie', `${cookieName}=; Path=/; Max-Age=0; HttpOnly; ${securityFlags};`);
}

function getClientIp(req) {
    const forwarded = String(req?.headers?.['x-forwarded-for'] || req?.headers?.['X-Forwarded-For'] || '').trim();
    const firstForward = forwarded.split(',')[0]?.trim();
    const direct = req?.headers?.['x-real-ip'] || req?.headers?.['X-Real-IP'] || req?.headers?.['cf-connecting-ip'] || req?.headers?.['CF-Connecting-IP'] || '';
    const ip = firstForward || direct || req?.socket?.remoteAddress || 'Unknown';
    return String(ip).replace(/^::ffff:/, '').trim() || 'Unknown';
}

function normalizeFingerprint(value) {
    return String(value || '').trim().replace(/\s+/g, '').slice(0, 256);
}

function isPrivateIpv4(value) {
    const parts = String(value || '').split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    return parts[0] === 10 ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168);
}

function getStudentCodeCandidates(doc, fallbackCode = '') {
    const data = doc && typeof doc.data === 'function' ? doc.data() || {} : {};
    const values = [
        fallbackCode,
        data.Code,
        data.code,
        data['Student Code'],
        data.studentCode,
        data.StudentCode,
        doc?.id || ''
    ];
    return Array.from(new Set(values.filter(value => typeof value === 'string' ? value.trim() : value !== undefined && value !== null && String(value).trim()))).map(String).map(value => value.trim());
}

async function findStudentDocument(lectureRef, submittedCode) {
    if (!lectureRef || !submittedCode) return null;

    try {
        const byDocumentId = await lectureRef.doc(submittedCode).get();
        if (byDocumentId.exists) {
            return byDocumentId;
        }
    } catch (error) {
        console.warn('findStudentDocument doc-id lookup failed:', error.message || error);
    }

    for (const fieldName of ['Code', 'code', 'Student Code', 'studentCode', 'StudentCode']) {
        try {
            const byCodeField = await lectureRef.where(fieldName, '==', submittedCode).limit(1).get();
            if (!byCodeField.empty) {
                return byCodeField.docs[0];
            }
        } catch (error) {
            console.warn(`findStudentDocument ${fieldName} lookup failed:`, error.message || error);
        }
    }

    return null;
}

module.exports = async function handler(req, res) {
    if (!enforceSameOrigin(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'method_not_allowed' });
    }

    const isLoginRequest = req.body?.action !== 'logout' && req.body?.action !== 'switchLecture';
    if (!isLoginRequest && !checkRateLimit(req, res, { endpoint: 'auth-ip', maxRequests: 600, windowMs: 60000 })) return;

    if (req.body?.action === 'logout') {
        clearSessionCookie(res, req);
        return res.status(200).json({ authenticated: false });
    }

    let isLoginAttempt = false;
    let loginFirestore = null;
    let loginIdentifier = '';
    try {
        if (req.body?.action === 'switchLecture') {
            const session = validateSessionToken(req);
            if (!session) {
                return res.status(401).json({ authenticated: false, reason: 'unauthorized' });
            }
            if (session.role !== 'student') {
                return res.status(403).json({ authenticated: false, reason: 'student_session_required' });
            }

            const courseName = normalizeCourseName(req.body?.courseName);
            if (!courseName) {
                return res.status(400).json({ authenticated: false, reason: 'invalid_course' });
            }

            const firestore = getFirestore();
            const modeSnap = await firestore.collection('MODE').doc('Website Status').get();
            const modeData = modeSnap.exists ? modeSnap.data() || {} : {};
            const lectureNumber = getModeCourseLecture(modeData, courseName);
            const isModeEnabled = modeData.Student_Mode === true ||
                String(modeData.Student_Mode || '').toLowerCase() === 'on' ||
                hasAnyActiveCourseLecture(modeData);
            if (!isModeEnabled || !lectureNumber) {
                return res.status(403).json({ authenticated: false, reason: 'student_course_not_active' });
            }

            const userCode = String(session.userCode || '').trim();
            const studentDoc = await findStudentDocument(firestore.collection(`LEC_${lectureNumber}`), userCode);
            if (!studentDoc) {
                return res.status(403).json({ authenticated: false, reason: 'student_course_record_missing' });
            }
            const studentData = studentDoc.data() || {};
            const recordCode = String(
                studentData.Code ??
                studentData.code ??
                studentData['Student Code'] ??
                studentData.studentCode ??
                studentData.StudentCode ??
                studentDoc.id ??
                ''
            ).trim();
            if (!userCode || recordCode !== userCode) {
                return res.status(403).json({ authenticated: false, reason: 'student_course_record_mismatch' });
            }

            const token = createSessionToken({
                role: 'student',
                userCode,
                lecture: lectureNumber,
                courseName,
                issuedAt: Date.now()
            });
            setSessionCookie(res, token, req);
            logSecurityEvent('student_lecture_switched', { req, lectureNumber });
            return res.json({
                authenticated: true,
                role: 'student',
                courseName,
                lectureNumber,
                studentRecordId: studentDoc.id
            });
        }

        isLoginAttempt = true;
        const submittedCode = String(req.body?.code || '').trim();
        loginIdentifier = submittedCode;
        loginFirestore = getFirestore();
        const loginLimit = await checkLoginRateLimit(loginFirestore, req, submittedCode);
        if (!loginLimit.allowed) {
            res.setHeader('Retry-After', String(loginLimit.retryAfter));
            logSecurityEvent('login_rate_limited', { req, reason: loginLimit.reason });
            return await respondToLogin(
                loginFirestore,
                req,
                res,
                submittedCode,
                429,
                {
                    authenticated: false,
                    reason: 'rate_limited',
                    retryAfter: loginLimit.retryAfter
                },
                false,
                null,
                loginLimit.identifierHash,
                false
            );
        }

        if (!submittedCode || submittedCode.length > 128 || /[\u0000-\u001F\u007F]/.test(submittedCode)) {
            logSecurityEvent('invalid_auth_input', { req, submittedCodeLength: submittedCode.length });
            return await respondToLogin(loginFirestore, req, res, submittedCode, 401, {
                authenticated: false,
                reason: 'invalid_input'
            }, false, null, loginLimit.identifierHash);
        }

        const firestore = loginFirestore;
        const doctorAccountsSnapshot = await firestore.collection('Dr Accounts').get();
        const matchingDoctorNames = findDoctorAccountMatches(doctorAccountsSnapshot.docs, submittedCode);
        if (matchingDoctorNames.length > 1) {
            logSecurityEvent('doctor_login_duplicate_password', { req, matchCount: matchingDoctorNames.length });
            return await respondToLogin(loginFirestore, req, res, submittedCode, 401, {
                authenticated: false,
                reason: 'ambiguous_doctor_password'
            }, false, null, loginLimit.identifierHash);
        }

        if (matchingDoctorNames.length === 1) {
            const { doctorName, courseName } = matchingDoctorNames[0];
            if (!doctorName || !courseName) {
                logSecurityEvent('doctor_login_course_missing', { req });
                return await respondToLogin(loginFirestore, req, res, submittedCode, 401, {
                    authenticated: false,
                    reason: 'doctor_course_not_configured'
                }, false, null, loginLimit.identifierHash);
            }
            logSecurityEvent('doctor_login_success', { req, doctorName });
            const token = createSessionToken({ role: 'doctor', doctorName, courseName, issuedAt: Date.now() });
            return await respondToLogin(
                loginFirestore,
                req,
                res,
                submittedCode,
                200,
                { authenticated: true, role: 'doctor', doctorName, courseName },
                true,
                () => setSessionCookie(res, token, req, null, getDoctorSessionCookieName(courseName)),
                loginLimit.identifierHash
            );
        }

        if (!/^[A-Za-z0-9\-_]+$/.test(submittedCode)) {
            logSecurityEvent('student_login_invalid_format', { req, submittedCodeLength: submittedCode.length });
            return await respondToLogin(loginFirestore, req, res, submittedCode, 401, {
                authenticated: false,
                reason: 'invalid_format'
            }, false, null, loginLimit.identifierHash);
        }

        const modeSnap = await firestore.collection('MODE').doc('Website Status').get();
        const modeData = modeSnap.exists ? modeSnap.data() : {};
        const activeCourses = Object.entries(getModeCourseMap(modeData))
            .sort(([, lectureA], [, lectureB]) => lectureB - lectureA);
        const isModeEnabled = modeData.Student_Mode === true || String(modeData.Student_Mode || '').toLowerCase() === 'on' || hasAnyActiveCourseLecture(modeData);

        if (!isModeEnabled || activeCourses.length === 0) {
            logSecurityEvent('student_login_disabled', { req, isModeEnabled, activeCourseCount: activeCourses.length });
            return await respondToLogin(loginFirestore, req, res, submittedCode, 401, {
                authenticated: false,
                reason: 'student_mode_disabled'
            }, false, null, loginLimit.identifierHash);
        }

        let courseName = null;
        let lectureNumber = 0;
        let lectureRef = null;
        let studentDoc = null;
        for (const [candidateCourse, candidateLecture] of activeCourses) {
            const candidateRef = firestore.collection(`LEC_${candidateLecture}`);
            const candidateStudent = await findStudentDocument(candidateRef, submittedCode);
            if (!candidateStudent) continue;
            courseName = candidateCourse;
            lectureNumber = candidateLecture;
            lectureRef = candidateRef;
            studentDoc = candidateStudent;
            break;
        }

        if (!studentDoc) {
            logSecurityEvent('student_login_failed', { req, activeCourseCount: activeCourses.length });
            return await respondToLogin(loginFirestore, req, res, submittedCode, 401, {
                authenticated: false,
                reason: 'student_not_found'
            }, false, null, loginLimit.identifierHash);
        }
        const courseField = getCourseStorageFieldName(courseName);
        if (!courseField) {
            logSecurityEvent('student_login_course_missing', { req, lectureNumber });
            return await respondToLogin(loginFirestore, req, res, submittedCode, 401, {
                authenticated: false,
                reason: 'student_mode_disabled'
            }, false, null, loginLimit.identifierHash);
        }

        const clientIp = getClientIp(req);
        const incomingFingerprint = normalizeFingerprint(req.body?.deviceFingerprint || req.headers?.['x-device-fingerprint'] || req.headers?.['X-Device-Fingerprint'] || '');
        const studentData = studentDoc.data() || {};
        const studentCodeFromDoc = getStudentCodeCandidates(studentDoc, submittedCode)[0] || submittedCode;
        const storedIp = String(studentData.Device_ip || studentData['Device IP'] || '').trim();
        const storedFingerprint = normalizeFingerprint(studentData.Device_Fingerprint || studentData.deviceFingerprint || studentData['Device Fingerprint'] || '');
        const existingDeviceToken = getCookieValue(req.headers?.cookie || req.headers?.Cookie, DEVICE_COOKIE_NAME);
        const deviceToken = isValidDeviceToken(existingDeviceToken) ? existingDeviceToken : createDeviceToken();
        const deviceIdHash = hashDeviceToken(deviceToken);
        const storedDeviceIdHash = String(studentData.Device_Id_Hash || '').trim();
        if (!clientIp || clientIp === 'Unknown' || clientIp === 'unknown' || clientIp === '127.0.0.1' || clientIp === '::1') {
            logSecurityEvent('student_login_missing_ip', { req, lectureNumber, clientIp });
            return await respondToLogin(loginFirestore, req, res, submittedCode, 401, {
                authenticated: false,
                reason: 'device_ip_missing'
            }, false, null, loginLimit.identifierHash);
        }

        if (!isValidDeviceFingerprint(incomingFingerprint)) {
            logSecurityEvent('student_login_invalid_fingerprint', { req, lectureNumber });
            return await respondToLogin(loginFirestore, req, res, submittedCode, 401, {
                authenticated: false,
                reason: 'device_fingerprint_invalid'
            }, false, null, loginLimit.identifierHash);
        }

        const allowLegacyIpMigration = Boolean(
            storedIp && storedIp !== clientIp && isPrivateIpv4(storedIp) && storedFingerprint === incomingFingerprint
        );

        if (storedIp === 'Unknown' || storedIp === 'unknown') {
            logSecurityEvent('student_login_stored_unknown_ip', { req, lectureNumber, storedIp });
            return await respondToLogin(loginFirestore, req, res, submittedCode, 401, {
                authenticated: false,
                reason: 'device_ip_missing'
            }, false, null, loginLimit.identifierHash);
        }

        if (storedIp && storedIp !== 'Unknown' && storedIp !== clientIp && !allowLegacyIpMigration) {
            logSecurityEvent('student_login_ip_conflict', { req, lectureNumber, storedIp, clientIp });
            return await respondToLogin(loginFirestore, req, res, submittedCode, 401, {
                authenticated: false,
                reason: 'device_ip_conflict'
            }, false, null, loginLimit.identifierHash);
        }

        if (storedDeviceIdHash && storedDeviceIdHash !== deviceIdHash) {
            logSecurityEvent('student_login_device_binding_conflict', { req, lectureNumber });
            return await respondToLogin(loginFirestore, req, res, submittedCode, 401, {
                authenticated: false,
                reason: 'device_id_conflict'
            }, false, null, loginLimit.identifierHash);
        }

        if (allowLegacyIpMigration) {
            logSecurityEvent('student_login_legacy_ip_migration', { req, lectureNumber });
        }

        if (!studentCodeFromDoc || studentCodeFromDoc === 'UNKNOWN' || studentCodeFromDoc === 'unknown') {
            logSecurityEvent('student_login_missing_code', { req, lectureNumber });
            return await respondToLogin(loginFirestore, req, res, submittedCode, 401, {
                authenticated: false,
                reason: 'student_code_missing'
            }, false, null, loginLimit.identifierHash);
        }

        const conflict = await firestore.runTransaction(async transaction => {
            const [deviceMatches, fingerprintMatches, legacyFingerprintMatches] = await Promise.all([
                transaction.get(lectureRef.where('Device_Id_Hash', '==', deviceIdHash).limit(100)),
                transaction.get(lectureRef.where('Device_Fingerprint', '==', incomingFingerprint).limit(100)),
                transaction.get(lectureRef.where('Device Fingerprint', '==', incomingFingerprint).limit(100))
            ]);
            const matchingDevices = new Map();
            for (const doc of [...deviceMatches.docs, ...fingerprintMatches.docs, ...legacyFingerprintMatches.docs]) {
                matchingDevices.set(doc.id, doc);
            }
            const deviceStudentCodes = deviceMatches.docs.map(doc => getStudentCodeCandidates(doc)[0] || '');
            const fingerprintStudentCodes = [...fingerprintMatches.docs, ...legacyFingerprintMatches.docs]
                .map(doc => getStudentCodeCandidates(doc)[0] || '');
            if (deviceMatches.size >= 100 || fingerprintMatches.size >= 100 || legacyFingerprintMatches.size >= 100) {
                return 'device_conflict_review';
            }
            if (hasDeviceIdConflict(deviceStudentCodes, submittedCode)) return 'device_id_conflict';
            if (hasFingerprintConflict(fingerprintStudentCodes, submittedCode)) return 'shared_device_fingerprint';

            transaction.set(studentDoc.ref, {
                Device_ip: clientIp,
                Device_Fingerprint: incomingFingerprint,
                Device_Id_Hash: deviceIdHash
            }, { merge: true });
            return false;
        });
        if (conflict) {
            logSecurityEvent('student_login_shared_device_detected', { req, lectureNumber });
            return await respondToLogin(loginFirestore, req, res, submittedCode, 401, {
                authenticated: false,
                reason: conflict
            }, false, null, loginLimit.identifierHash);
        }

        const token = createSessionToken({ role: 'student', userCode: submittedCode, lecture: lectureNumber, courseName, issuedAt: Date.now() });
        logSecurityEvent('student_login_success', { req, lectureNumber });
        return await respondToLogin(
            loginFirestore,
            req,
            res,
            submittedCode,
            200,
            { authenticated: true, role: 'student', deviceIp: clientIp, courseName, allowLegacyIpMigration },
            true,
            () => setSessionCookie(res, token, req, deviceToken),
            loginLimit.identifierHash
        );
    } catch (error) {
        logSecurityEvent('authentication_error', { req, message: error.message || String(error) });
        console.error('Authentication error:', error.message || error);
        if (isLoginAttempt) {
            if (!loginFirestore) {
                return res.status(503).json({ error: 'login_audit_unavailable' });
            }
            return await respondToLogin(loginFirestore, req, res, loginIdentifier, 500, {
                error: 'authentication_failed'
            });
        }
        return res.status(500).json({ error: 'authentication_failed' });
    }
};