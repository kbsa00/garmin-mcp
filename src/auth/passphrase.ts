// PBKDF2-SHA256 passphrase hashing. Format: pbkdf2-sha256:<iterations>:<salt b64>:<hash b64>
// (":" rather than "$" so the value survives dotenv/shell variable expansion.)
// 100k iterations is the maximum Workers' WebCrypto allows; the passphrase itself is high-entropy.

export const PBKDF2_ITERATIONS = 100_000;

const enc = new TextEncoder();

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
	return new Uint8Array(bits);
}

export async function hashPassphrase(passphrase: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await derive(passphrase, salt, iterations);
	return `pbkdf2-sha256:${iterations}:${toB64(salt)}:${toB64(hash)}`;
}

export async function verifyPassphrase(passphrase: string, stored: string): Promise<boolean> {
	const parts = stored.trim().split(":");
	if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
	const iterations = Number(parts[1]);
	if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
	let salt: Uint8Array, expected: Uint8Array;
	try {
		salt = fromB64(parts[2]!);
		expected = fromB64(parts[3]!);
	} catch {
		return false;
	}
	const actual = await derive(passphrase, salt, iterations);
	return timingSafeEqual(actual, expected);
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}
