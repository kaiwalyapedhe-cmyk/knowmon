use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::map::Entry;
use std::ops::{Deref, DerefMut};
pub use serde_json::{json, Map, Value};
use uuid::Uuid;

/// A JSON object: PostgreSQL stores it as `jsonb`.
///
/// It derefs to `serde_json::Map` (so `get`, `iter`, `keys` … work), serialises
/// transparently as the object itself, and can be built from any JSON value.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Document(pub Map<String, Value>);

/// Anything that can be stored as a JSON value inside a document.
pub trait IntoDocValue {
    fn into_doc_value(self) -> Value;
}

impl IntoDocValue for Value {
    fn into_doc_value(self) -> Value {
        self
    }
}

impl IntoDocValue for &Value {
    fn into_doc_value(self) -> Value {
        self.clone()
    }
}

impl IntoDocValue for String {
    fn into_doc_value(self) -> Value {
        Value::String(self)
    }
}

impl IntoDocValue for &String {
    fn into_doc_value(self) -> Value {
        Value::String(self.clone())
    }
}

impl IntoDocValue for &str {
    fn into_doc_value(self) -> Value {
        Value::String(self.to_string())
    }
}

impl IntoDocValue for Document {
    fn into_doc_value(self) -> Value {
        Value::Object(self.0)
    }
}

impl IntoDocValue for &Document {
    fn into_doc_value(self) -> Value {
        Value::Object(self.0.clone())
    }
}

impl IntoDocValue for Vec<Value> {
    fn into_doc_value(self) -> Value {
        Value::Array(self)
    }
}

impl IntoDocValue for Vec<Document> {
    fn into_doc_value(self) -> Value {
        Value::Array(self.into_iter().map(|d| Value::Object(d.0)).collect())
    }
}

impl IntoDocValue for Vec<String> {
    fn into_doc_value(self) -> Value {
        Value::Array(self.into_iter().map(Value::String).collect())
    }
}

impl IntoDocValue for bool {
    fn into_doc_value(self) -> Value {
        Value::Bool(self)
    }
}

macro_rules! numeric_doc_value {
    ($($t:ty),*) => {
        $(impl IntoDocValue for $t {
            fn into_doc_value(self) -> Value {
                Value::from(self as f64)
            }
        })*
    };
}

numeric_doc_value!(i32, i64, u32, u64, usize, f64);

impl Document {
    pub fn new() -> Self {
        Self(Map::new())
    }

    pub fn from_value(v: Value) -> Self {
        match v {
            Value::Object(m) => Self(m),
            _ => Self(Map::new()),
        }
    }

    pub fn into_value(self) -> Value {
        Value::Object(self.0)
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        self.0.get_mut(key)
    }

    pub fn get_str(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|v| v.as_str())
    }

    pub fn insert<K, V>(&mut self, key: K, value: V) -> Option<Value>
    where
        K: Into<String>,
        V: IntoDocValue,
    {
        self.0.insert(key.into(), value.into_doc_value())
    }

    pub fn remove(&mut self, key: &str) -> Option<Value> {
        self.0.remove(key)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.0.contains_key(key)
    }

    pub fn entry(&mut self, key: String) -> Entry<'_> {
        self.0.entry(key)
    }

    pub fn extend_map(&mut self, other: Document) {
        self.0.extend(other.0);
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }
}

impl Deref for Document {
    type Target = Map<String, Value>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for Document {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl From<Map<String, Value>> for Document {
    fn from(m: Map<String, Value>) -> Self {
        Self(m)
    }
}

impl From<Value> for Document {
    fn from(v: Value) -> Self {
        Self::from_value(v)
    }
}

impl From<Document> for Value {
    fn from(d: Document) -> Self {
        Value::Object(d.0)
    }
}

impl<'a> IntoIterator for &'a Document {
    type Item = (&'a String, &'a Value);
    type IntoIter = serde_json::map::Iter<'a>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}

impl IntoIterator for Document {
    type Item = (String, Value);
    type IntoIter = serde_json::map::IntoIter;
    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

impl FromIterator<(String, Value)> for Document {
    fn from_iter<I: IntoIterator<Item = (String, Value)>>(iter: I) -> Self {
        Self(iter.into_iter().collect())
    }
}

/// Turn any JSON value into a document (non-objects become empty).
pub fn as_doc(v: Value) -> Document {
    Document::from_value(v)
}

pub const ROLES: [&str; 4] = ["admin", "qa_auditor", "team_lead", "agent"];
pub const DEFAULT_ROLE: &str = "agent";
pub const STAFF: [&str; 3] = ["admin", "qa_auditor", "team_lead"];
pub const QA: [&str; 2] = ["admin", "qa_auditor"];
pub const CHANNELS: [&str; 5] = ["voice", "email", "chat", "whatsapp", "in_store"];
pub const LDAP_ISSUER: &str = "cadence-ldap";

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Micros, false)
}

pub fn new_id() -> String {
    Uuid::new_v4().to_string()
}

pub fn rank(role: &str) -> i32 {
    match role {
        "admin" => 4,
        "qa_auditor" => 3,
        "team_lead" => 2,
        "agent" => 1,
        _ => 0,
    }
}

pub fn effective_role(role: Option<&Value>) -> String {
    let raw = role.and_then(|b| b.as_str()).unwrap_or("");
    if ROLES.contains(&raw) {
        raw.to_string()
    } else {
        DEFAULT_ROLE.to_string()
    }
}

pub fn doc_str(d: &Map<String, Value>, key: &str) -> String {
    d.get(key)
        .and_then(|b| b.as_str())
        .unwrap_or("")
        .to_string()
}

pub fn doc_opt_str(d: &Map<String, Value>, key: &str) -> Option<String> {
    d.get(key).and_then(|b| b.as_str()).map(|s| s.to_string())
}

pub fn doc_f64(d: &Map<String, Value>, key: &str) -> f64 {
    match d.get(key) {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

pub fn doc_i64(d: &Map<String, Value>, key: &str) -> i64 {
    match d.get(key) {
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .unwrap_or(0),
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        _ => 0,
    }
}

pub fn doc_bool(d: &Map<String, Value>, key: &str) -> bool {
    matches!(d.get(key), Some(Value::Bool(true)))
}

pub fn doc_array(d: &Map<String, Value>, key: &str) -> Vec<Value> {
    d.get(key)
        .and_then(|b| b.as_array())
        .cloned()
        .unwrap_or_default()
}

pub fn doc_obj(d: &Map<String, Value>, key: &str) -> Document {
    d.get(key)
        .and_then(|b| b.as_object())
        .cloned()
        .map(Document)
        .unwrap_or_default()
}

pub fn as_value_list(items: &[&str]) -> Vec<Value> {
    items.iter().map(|s| Value::String(s.to_string())).collect()
}

/// The document as a JSON value, ready to serialise to a client.
pub fn to_json(d: &Document) -> Value {
    Value::Object(d.0.clone())
}

pub fn clean(mut d: Document) -> Document {
    d.remove("_id");
    d
}

pub fn clean_all(docs: Vec<Document>) -> Vec<Document> {
    docs.into_iter().map(clean).collect()
}

pub fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

pub fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

pub fn avg(values: &[f64]) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        round1(values.iter().sum::<f64>() / values.len() as f64)
    }
}

/// `{"env": {"$in": [ENV, null]}}` — environment-scoped reads, same as `core.IN_ENV`.
pub fn in_env(env_name: &str) -> Document {
    as_doc(json!({ "env": { "$in": [env_name, Value::Null] } }))
}

pub fn parse_iso(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

pub fn utc_from_days(days: i64) -> String {
    (Utc::now() + chrono::Duration::days(days)).to_rfc3339_opts(SecondsFormat::Micros, false)
}

pub fn today_iso() -> String {
    Utc::now().date_naive().format("%Y-%m-%d").to_string()
}

pub fn date_in_days(days: i64) -> String {
    (Utc::now().date_naive() + chrono::Duration::days(days))
        .format("%Y-%m-%d")
        .to_string()
}

pub fn short_date(ts: &str) -> String {
    ts.chars().take(10).collect()
}

pub fn unix_now() -> i64 {
    Utc::now().timestamp()
}

pub fn utc_from_ts(ts: i64) -> Option<DateTime<Utc>> {
    Utc.timestamp_opt(ts, 0).single()
}
