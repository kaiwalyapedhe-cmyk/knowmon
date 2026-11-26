use crate::db;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::util::*;
use axum::async_trait;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::HeaderMap;
use base64::Engine;
use hmac::{Hmac, Mac};
use rsa::{BigUint, Pkcs1v15Sign, RsaPublicKey};
use sha2::{Digest, Sha256};
use crate::util::{Document, Value, json, as_doc};

type HmacSha256 = Hmac<Sha256>;

// ---------- Password hashing (PBKDF2-HMAC-SHA256, compatible with the Python hashes) ----------

fn pbkdf2_sha256(password: &[u8], salt: &[u8], iterations: u32) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(password).expect("hmac accepts any key length");
    mac.update(salt);
    mac.update(&1u32.to_be_bytes());
    let mut u: [u8; 32] = mac.finalize().into_bytes().into();
    let mut out = u;
    for _ in 1..iterations {
        let mut mac = HmacSha256::new_from_slice(password).expect("hmac accepts any key length");
        mac.update(&u);
        u = mac.finalize().into_bytes().into();
        for (i, byte) in u.iter().enumerate() {
            out[i] ^= byte;
        }
    }
    out.to_vec()
}

pub fn hash_password(password: &str) -> String {
    use rand::RngCore;
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let hash = pbkdf2_sha256(password.as_bytes(), &salt, 100_000);
    format!("pbkdf2_sha256${}${}", hex::encode(salt), hex::encode(hash))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

pub fn verify_password(password: &str, hashed: &str) -> bool {
    if password.is_empty() || hashed.is_empty() {
        return false;
    }
    let parts: Vec<&str> = hashed.split('$').collect();
    if parts.len() != 3 || parts[0] != "pbkdf2_sha256" {
        return false;
    }
    let Ok(salt) = hex::decode(parts[1]) else {
        return false;
    };
    let Ok(expected) = hex::decode(parts[2]) else {
        return false;
    };
    let calc = pbkdf2_sha256(password.as_bytes(), &salt, 100_000);
    constant_time_eq(&expected, &calc)
}

// ---------- Base64url / HS256 helpers ----------

fn b64url_decode(input: &str) -> Option<Vec<u8>> {
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    engine
        .decode(input)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(input))
        .ok()
}

fn b64url_encode(input: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(input)
}

fn hmac_sha256(key: &[u8], msg: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(msg);
    mac.finalize().into_bytes().to_vec()
}

fn json_part(token: &str, index: usize) -> Option<serde_json::Value> {
    let part = token.split('.').nth(index)?;
    serde_json::from_slice(&b64url_decode(part)?).ok()
}

fn token_alg(token: &str) -> Option<String> {
    json_part(token, 0)?
        .get("alg")?
        .as_str()
        .map(|s| s.to_string())
}

// ---------- LDAP session tokens (HS256) ----------

pub fn issue_session(secret: &str, user_id: &str) -> ApiResult<(String, String)> {
    if secret.is_empty() {
        return Err(AppError::internal("LDAP_JWT_SECRET is not configured"));
    }
    let exp = (chrono::Utc::now() + chrono::Duration::hours(12)).timestamp();
    let header = json!({ "alg": "HS256", "typ": "JWT" });
    let claims = json!({ "sub": user_id, "iss": LDAP_ISSUER, "exp": exp });
    let signing_input = format!(
        "{}.{}",
        b64url_encode(header.to_string().as_bytes()),
        b64url_encode(claims.to_string().as_bytes())
    );
    let signature = hmac_sha256(secret.as_bytes(), signing_input.as_bytes());
    let token = format!("{signing_input}.{}", b64url_encode(&signature));
    let expires_at = chrono::DateTime::<chrono::Utc>::from_timestamp(exp, 0)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Micros, false))
        .unwrap_or_default();
    Ok((token, expires_at))
}

fn verify_ldap_token(secret: &str, token: &str) -> Option<String> {
    let mut parts = token.split('.');
    let (header, payload, signature) = (parts.next()?, parts.next()?, parts.next()?);
    let signing_input = format!("{header}.{payload}");
    let expected = hmac_sha256(secret.as_bytes(), signing_input.as_bytes());
    let signature = b64url_decode(signature)?;
    if !constant_time_eq(&expected, &signature) {
        return None;
    }
    let claims: serde_json::Value = serde_json::from_slice(&b64url_decode(payload)?).ok()?;
    if claims.get("iss")?.as_str()? != LDAP_ISSUER {
        return None;
    }
    let exp = claims.get("exp")?.as_i64()?;
    if exp < chrono::Utc::now().timestamp() {
        return None;
    }
    claims.get("sub")?.as_str().map(|s| s.to_string())
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get("cookie")?.to_str().ok()?;
    raw.split(';').find_map(|part| {
        let (k, v) = part.split_once('=')?;
        (k.trim() == name).then(|| v.trim().to_string())
    })
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get("authorization")?.to_str().ok()?;
    if raw.len() > 7 && raw[..7].eq_ignore_ascii_case("bearer ") {
        Some(raw[7..].trim().to_string())
    } else {
        None
    }
}

// ---------- Clerk ----------

struct ClerkProfile {
    email: String,
    name: String,
    is_admin: bool,
}

async fn clerk_profile(state: &AppState, user_id: &str) -> ApiResult<ClerkProfile> {
    if state.cfg.clerk_secret_key.is_empty() {
        return Err(AppError::unavailable("Clerk is not configured"));
    }
    let resp = state
        .http
        .get(format!("https://api.clerk.com/v1/users/{user_id}"))
        .bearer_auth(&state.cfg.clerk_secret_key)
        .header("User-Agent", "emergent-app")
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::upstream("Clerk profile lookup failed"));
    }
    let v: serde_json::Value = resp.json().await.unwrap_or_default();
    let emails = v
        .get("email_addresses")
        .and_then(|e| e.as_array())
        .cloned()
        .unwrap_or_default();
    let primary_id = v
        .get("primary_email_address_id")
        .and_then(|e| e.as_str())
        .unwrap_or("");
    let primary = emails
        .iter()
        .find(|e| e.get("id").and_then(|i| i.as_str()) == Some(primary_id))
        .or_else(|| emails.first());
    let email = primary
        .and_then(|e| e.get("email_address"))
        .and_then(|e| e.as_str())
        .unwrap_or("")
        .to_string();
    let first = v.get("first_name").and_then(|s| s.as_str()).unwrap_or("");
    let last = v.get("last_name").and_then(|s| s.as_str()).unwrap_or("");
    let combined = format!("{first} {last}").trim().to_string();
    let name = if combined.is_empty() {
        email.split('@').next().unwrap_or("").to_string()
    } else {
        combined
    };
    let is_admin = emails.iter().any(|e| {
        let addr = e
            .get("email_address")
            .and_then(|a| a.as_str())
            .unwrap_or("")
            .to_lowercase();
        let verified = e
            .get("verification")
            .and_then(|v| v.get("status"))
            .and_then(|s| s.as_str())
            == Some("verified");
        state.cfg.admin_emails.contains(&addr) && verified
    });
    Ok(ClerkProfile {
        email,
        name,
        is_admin,
    })
}

fn rsa_verify_sha256(n: &[u8], e: &[u8], message: &[u8], signature: &[u8]) -> bool {
    let n = BigUint::from_bytes_be(n);
    let e = BigUint::from_bytes_be(e);
    let Ok(key) = RsaPublicKey::new(n, e) else {
        return false;
    };
    let hashed = Sha256::digest(message);
    key.verify(Pkcs1v15Sign::new::<Sha256>(), &hashed, signature)
        .is_ok()
}

async fn verify_clerk_token(state: &AppState, token: &str) -> ApiResult<serde_json::Value> {
    if state.cfg.clerk_secret_key.is_empty() {
        return Err(AppError::unavailable("Clerk is not configured"));
    }
    let invalid = || AppError::unauthorized("Invalid or expired session");
    let header = json_part(token, 0).ok_or_else(invalid)?;
    let kid = header.get("kid").and_then(|k| k.as_str()).unwrap_or("");
    let resp = state
        .http
        .get("https://api.clerk.com/v1/jwks")
        .bearer_auth(&state.cfg.clerk_secret_key)
        .header("User-Agent", "emergent-clerk-auth")
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::upstream("Clerk keys unavailable"));
    }
    let jwks: serde_json::Value = resp.json().await.map_err(|_| AppError::upstream("Clerk keys unavailable"))?;
    let keys = jwks
        .get("keys")
        .and_then(|k| k.as_array())
        .cloned()
        .unwrap_or_default();
    let jwk = keys
        .iter()
        .find(|k| k.get("kid").and_then(|v| v.as_str()) == Some(kid))
        .ok_or_else(invalid)?;
    let n = jwk
        .get("n")
        .and_then(|v| v.as_str())
        .and_then(b64url_decode)
        .ok_or_else(invalid)?;
    let e = jwk
        .get("e")
        .and_then(|v| v.as_str())
        .and_then(b64url_decode)
        .ok_or_else(invalid)?;
    let mut parts = token.split('.');
    let (h, p, s) = (
        parts.next().ok_or_else(invalid)?,
        parts.next().ok_or_else(invalid)?,
        parts.next().ok_or_else(invalid)?,
    );
    let signature = b64url_decode(s).ok_or_else(invalid)?;
    if !rsa_verify_sha256(&n, &e, format!("{h}.{p}").as_bytes(), &signature) {
        return Err(invalid());
    }
    let claims: serde_json::Value =
        serde_json::from_slice(&b64url_decode(p).ok_or_else(invalid)?).map_err(|_| invalid())?;
    if let Some(exp) = claims.get("exp").and_then(|v| v.as_i64()) {
        if exp + 5 < chrono::Utc::now().timestamp() {
            return Err(invalid());
        }
    }
    Ok(claims)
}

// ---------- Member resolution ----------

async fn finish_member(state: &AppState, mut member: Document) -> ApiResult<Document> {
    let uid = doc_str(&member, "user_id");
    let env_name = state.env_name().to_string();
    if doc_str(&member, "env") != env_name {
        db::set_fields(
            &state.db,
            "users",
            as_doc(json!( { "user_id": &uid })),
            as_doc(json!( { "env": &env_name })),
        )
        .await?;
    }
    let role = effective_role(member.get("role"));
    member.insert("role".to_string(), role);
    member.insert("env".to_string(), env_name);
    Ok(member)
}

async fn ldap_member(state: &AppState, uid: &str) -> ApiResult<Document> {
    let member = db::find_one(&state.db, "users", as_doc(json!( { "user_id": uid }))).await?;
    match member {
        Some(m) if !doc_bool(&m, "disabled") => finish_member(state, m).await,
        _ => Err(AppError::unauthorized("Session no longer valid")),
    }
}

async fn clerk_member(state: &AppState, uid: &str) -> ApiResult<Document> {
    let mut member = db::find_one(&state.db, "users", as_doc(json!( { "user_id": uid }))).await?;
    let needs_profile = match &member {
        None => true,
        Some(m) => doc_str(m, "role").is_empty() || doc_str(m, "email").is_empty(),
    };
    if needs_profile {
        let prof = clerk_profile(state, uid).await?;
        let role = if prof.is_admin { "admin" } else { DEFAULT_ROLE };
        db::update(
            &state.db,
            "users",
            as_doc(json!( { "user_id": uid, "role": { "$in": [Value::Null, ""] } })),
            as_doc(json!( { "$set": { "role": role } })),
        )
        .await?;
        db::upsert_set(
            &state.db,
            "users",
            as_doc(json!({ "user_id": uid })),
            as_doc(json!({ "email": &prof.email, "name": &prof.name })),
            as_doc(json!({ "user_id": uid, "role": role, "created_at": now() })),
        )
        .await?;
        member = db::find_one(&state.db, "users", as_doc(json!( { "user_id": uid }))).await?;
    }
    match member {
        Some(m) => finish_member(state, m).await,
        None => Err(AppError::unauthorized("Not signed in")),
    }
}

pub async fn current_member(state: &AppState, headers: &HeaderMap) -> ApiResult<Document> {
    let token = bearer(headers);
    if let Some(tok) = token.as_deref() {
        if !state.cfg.ldap_jwt_secret.is_empty() && token_alg(tok).as_deref() == Some("HS256") {
            return match verify_ldap_token(&state.cfg.ldap_jwt_secret, tok) {
                Some(uid) => ldap_member(state, &uid).await,
                None => Err(AppError::unauthorized("Invalid or expired session")),
            };
        }
    }
    let token = token
        .or_else(|| cookie_value(headers, "__session"))
        .ok_or_else(|| AppError::unauthorized("Not signed in"))?;
    let claims = verify_clerk_token(state, &token).await?;
    let uid = claims
        .get("sub")
        .and_then(|s| s.as_str())
        .ok_or_else(|| AppError::unauthorized("Invalid or expired session"))?;
    clerk_member(state, uid).await
}

pub fn role_of(member: &Document) -> String {
    effective_role(member.get("role"))
}

pub fn is_staff(member: &Document) -> bool {
    STAFF.contains(&role_of(member).as_str())
}

pub fn agent_scope(member: &Document) -> Document {
    if is_staff(member) {
        Document::new()
    } else {
        as_doc(json!( { "agent_id": doc_str(member, "user_id") }))
    }
}

pub fn ensure_role(member: &Document, allowed: &[&str]) -> ApiResult<()> {
    if allowed.contains(&role_of(member).as_str()) {
        Ok(())
    } else {
        Err(AppError::forbidden("Not allowed"))
    }
}

// ---------- Extractor wrappers ----------

#[derive(Debug, Clone)]
pub struct Member(pub Document);
#[derive(Debug, Clone)]
pub struct Staff(pub Document);
#[derive(Debug, Clone)]
pub struct Qa(pub Document);
#[derive(Debug, Clone)]
pub struct Admin(pub Document);

#[async_trait]
impl FromRequestParts<AppState> for Member {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        Ok(Member(current_member(state, &parts.headers).await?))
    }
}

#[async_trait]
impl FromRequestParts<AppState> for Staff {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let m = current_member(state, &parts.headers).await?;
        ensure_role(&m, &STAFF)?;
        Ok(Staff(m))
    }
}

#[async_trait]
impl FromRequestParts<AppState> for Qa {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let m = current_member(state, &parts.headers).await?;
        ensure_role(&m, &QA)?;
        Ok(Qa(m))
    }
}

#[async_trait]
impl FromRequestParts<AppState> for Admin {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let m = current_member(state, &parts.headers).await?;
        ensure_role(&m, &["admin"])?;
        Ok(Admin(m))
    }
}

pub fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}
