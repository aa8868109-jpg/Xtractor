function shouldEnforceFingerprintUniqueness({ storedIp, currentIp, allowLegacyIpMigration = false }) {
  if (allowLegacyIpMigration) return false;
  const normalizedStoredIp = String(storedIp || '').trim();
  const normalizedCurrentIp = String(currentIp || '').trim();
  return !normalizedStoredIp || !normalizedCurrentIp || normalizedStoredIp !== normalizedCurrentIp;
}

module.exports = { shouldEnforceFingerprintUniqueness };