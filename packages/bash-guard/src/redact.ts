/**
 * Redaction of common secret shapes before a command or output tail is sent to
 * Jev or embedded in an error message. Best-effort by design: it catches the
 * common token/key/password shapes, not arbitrary secrets.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
	/AKIA[0-9A-Z]{16}/g,
	/ASIA[0-9A-Z]{16}/g,
	/gh[pousr]_[A-Za-z0-9]{20,}/g,
	/xox[baprs]-[A-Za-z0-9-]{10,}/g,
	/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
	/Bearer\s+[A-Za-z0-9._~+/=:-]{8,}/gi,
	/(?:api[_-]?key|token|secret|password|passwd|pwd|authorization)["']?\s*[:=]\s*\S+/gi,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	// URL-embedded credentials: https://user:password@host
	/[a-z][a-z0-9+.-]*:\/\/[^\s\/:@]+:[^\s\/]+@/gi,
];

/** Replace recognized secret shapes with `[REDACTED]`. */
export function redactSecrets(text: string): string {
	let result = text;
	for (const pattern of SECRET_PATTERNS) {
		result = result.replace(pattern, "[REDACTED]");
	}
	return result;
}
