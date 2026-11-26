import hashlib
import hmac
import secrets

def hash_password(password: str) -> str:
    """Hashes a password using PBKDF2-HMAC-SHA256 with 100,000 iterations and a random 128-bit salt."""
    if not password:
        raise ValueError("Password cannot be empty")
    salt = secrets.token_hex(16)
    pw_hash = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 100000).hex()
    return f"pbkdf2_sha256${salt}${pw_hash}"

def verify_password(password: str, hashed: str) -> bool:
    """Securely verifies a password against a PBKDF2-HMAC-SHA256 hash in constant time."""
    if not password or not hashed:
        return False
    try:
        parts = hashed.split("$")
        if len(parts) != 3 or parts[0] != "pbkdf2_sha256":
            return False
        salt = bytes.fromhex(parts[1])
        expected_hash = parts[2]
        calc_hash = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 100000).hex()
        return hmac.compare_digest(expected_hash, calc_hash)
    except Exception:
        return False
