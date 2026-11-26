use std::env;
use std::path::PathBuf;
use std::sync::Arc;

fn var(key: &str) -> String {
    env::var(key).unwrap_or_default()
}

fn var_or(key: &str, default: &str) -> String {
    let v = var(key);
    if v.is_empty() {
        default.to_string()
    } else {
        v
    }
}

fn truthy(key: &str) -> bool {
    matches!(
        var(key).to_lowercase().as_str(),
        "true" | "1" | "yes" | "on"
    )
}

#[derive(Clone, Debug, Default)]
pub struct LdapCfg {
    pub url: String,
    pub base_dn: String,
    pub bind_dn: String,
    pub bind_password: String,
    pub user_filter: String,
    pub team_lead_group_dn: String,
}

#[derive(Clone, Debug)]
pub struct SmtpCfg {
    pub host: String,
    pub port: u16,
    pub security: String,
    pub username: String,
    pub password: String,
    pub from: String,
}

impl Default for SmtpCfg {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: 587,
            security: "starttls".into(),
            username: String::new(),
            password: String::new(),
            from: String::new(),
        }
    }
}

impl SmtpCfg {
    pub fn configured(&self) -> bool {
        !self.host.is_empty() && !self.from.is_empty()
    }
}

#[derive(Clone, Debug, Default)]
pub struct Integrations {
    pub dev_login: bool,
    pub ldap: LdapCfg,
    pub smtp: SmtpCfg,
}

impl Integrations {
    pub fn ldap_enabled(&self) -> bool {
        (!self.ldap.url.is_empty() && !self.ldap.base_dn.is_empty()) || self.dev_login
    }

    pub fn from_env() -> Self {
        Self {
            dev_login: truthy("DEV_LOGIN"),
            ldap: LdapCfg {
                url: var("LDAP_URL"),
                base_dn: var("LDAP_BASE_DN"),
                bind_dn: var("LDAP_BIND_DN"),
                bind_password: var("LDAP_BIND_PASSWORD"),
                user_filter: var("LDAP_USER_FILTER"),
                team_lead_group_dn: var("LDAP_TEAM_LEAD_GROUP_DN"),
            },
            smtp: SmtpCfg {
                host: var("SMTP_HOST"),
                port: var_or("SMTP_PORT", "587").parse().unwrap_or(587),
                security: var_or("SMTP_SECURITY", "starttls"),
                username: var("SMTP_USERNAME"),
                password: var("SMTP_PASSWORD"),
                from: var("SMTP_FROM"),
            },
        }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub db_pool_max: u32,
    pub port: u16,
    pub env: String,
    pub cors_origins: Vec<String>,
    pub ldap_jwt_secret: String,
    pub admin_emails: Vec<String>,
    pub clerk_publishable_key: String,
    pub clerk_secret_key: String,
    pub llm_key: String,
    pub llm_base_url: String,
    pub llm_model: String,
    pub webhook_cron_secret: String,
    pub env_file: PathBuf,
    pub static_dir: PathBuf,
    pub storage_base: String,
    pub app_name: String,
    pub integrations: Arc<Integrations>,
}

impl Config {
    pub fn from_env() -> Self {
        let publishable = var("CLERK_PUBLISHABLE_KEY");
        let cors = var_or("CORS_ORIGINS", "*");
        let static_dir = env::var("STATIC_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("../frontend/build"));
        let env_file = env::var("ENV_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("../backend/.env"));
        Self {
            database_url: var_or(
                "DATABASE_URL",
                "postgres://postgres:postgres@127.0.0.1:5432/cadence_cx",
            ),
            db_pool_max: var_or("DB_POOL_MAX", "10").parse().unwrap_or(10),
            port: var_or("PORT", "8050").parse().unwrap_or(8050),
            env: if publishable.starts_with("pk_live_") {
                "live".into()
            } else {
                "preview".into()
            },
            cors_origins: cors.split(',').map(|s| s.trim().to_string()).collect(),
            ldap_jwt_secret: var("LDAP_JWT_SECRET"),
            admin_emails: var("ADMIN_EMAIL")
                .split(',')
                .map(|s| s.trim().to_lowercase())
                .filter(|s| !s.is_empty())
                .collect(),
            clerk_publishable_key: publishable,
            clerk_secret_key: var("CLERK_SECRET_KEY"),
            llm_key: var("EMERGENT_LLM_KEY"),
            llm_base_url: var("LLM_BASE_URL"),
            llm_model: var_or("LLM_MODEL", "claude-opus-5-5"),
            webhook_cron_secret: var("WEBHOOK_CRON_SECRET"),
            env_file,
            static_dir,
            storage_base: {
                let explicit = var("INTEGRATION_PROXY_URL");
                let base = if explicit.trim().is_empty() {
                    "https://integrations.emergentagent.com".to_string()
                } else {
                    explicit.trim().to_string()
                };
                format!("{}/objstore/api/v1/storage", base.trim_end_matches('/'))
            },
            app_name: "cadence-cx".into(),
            integrations: Arc::new(Integrations::from_env()),
        }
    }

    pub fn clerk_enabled(&self) -> bool {
        !self.clerk_publishable_key.is_empty() && !self.clerk_secret_key.is_empty()
    }

    pub fn clerk_is_production(&self) -> bool {
        self.clerk_publishable_key.starts_with("pk_live_")
    }
}

/// Rewrite the env file with `updates`, keeping the original ordering (mirrors the Python backend).
pub fn update_env_file(path: &PathBuf, updates: &[(String, Option<String>)]) -> std::io::Result<()> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let mut order: Vec<String> = Vec::new();
    let mut map: Vec<(String, String)> = Vec::new();
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = trimmed.split_once('=') {
            let k = k.trim().to_string();
            let v = v.trim().to_string();
            if !order.contains(&k) {
                order.push(k.clone());
            }
            map.push((k, v));
        }
    }
    let set = |map: &mut Vec<(String, String)>, order: &mut Vec<String>, k: &str, v: &str| {
        if let Some(slot) = map.iter_mut().find(|(key, _)| key == k) {
            slot.1 = v.to_string();
        } else {
            map.push((k.to_string(), v.to_string()));
            order.push(k.to_string());
        }
        // mirror into the live process environment so the change applies without a restart
        std::env::set_var(k, v);
    };
    for (k, v) in updates {
        if let Some(v) = v {
            set(&mut map, &mut order, k, v);
        }
    }
    let out: Vec<String> = order
        .iter()
        .filter_map(|k| map.iter().find(|(key, _)| key == k).map(|(key, v)| format!("{key}={v}")))
        .collect();
    std::fs::write(path, format!("{}\n", out.join("\n")))
}
