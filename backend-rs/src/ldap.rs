//! Active Directory / LDAP lookups used by company login and the integrations screen.

use crate::config::LdapCfg;
use ldap3::{LdapConnAsync, LdapConnSettings, Scope, SearchEntry};
use std::time::Duration;

const DEFAULT_FILTER: &str = "(|(uid={u})(sAMAccountName={u})(mail={u}))";

#[derive(Debug, Clone)]
pub struct LdapUser {
    pub dn: String,
    pub email: String,
    pub name: String,
    pub member_of: Vec<String>,
}

/// Escape a value for use inside an LDAP filter (RFC 4515).
pub fn escape_filter_chars(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' => out.push_str("\\5c"),
            '*' => out.push_str("\\2a"),
            '(' => out.push_str("\\28"),
            ')' => out.push_str("\\29"),
            '\0' => out.push_str("\\00"),
            c => out.push(c),
        }
    }
    out
}

fn settings() -> LdapConnSettings {
    LdapConnSettings::new()
        .set_conn_timeout(Duration::from_secs(8))
}

async fn connect(url: &str, user: Option<&str>, password: Option<&str>) -> Result<ldap3::Ldap, String> {
    let (conn, mut ldap) = LdapConnAsync::with_settings(settings(), url)
        .await
        .map_err(|e| format!("Connection Error: {e}"))?;
    ldap3::drive!(conn);
    if let Some(user) = user {
        ldap.simple_bind(user, password.unwrap_or(""))
            .await
            .map_err(|e| format!("LDAP Error: {e}"))?
            .success()
            .map_err(|e| format!("Bind failed with provided credentials: {e}"))?;
    }
    Ok(ldap)
}

fn first_attr(attrs: &std::collections::HashMap<String, Vec<String>>, names: &[&str], default: &str) -> String {
    for name in names {
        for (k, v) in attrs.iter() {
            if k.eq_ignore_ascii_case(name) {
                if let Some(first) = v.first() {
                    if !first.is_empty() {
                        return first.clone();
                    }
                }
            }
        }
    }
    default.to_string()
}

fn build_filter(cfg: &LdapCfg, username: &str) -> String {
    let raw = if cfg.user_filter.trim().is_empty() {
        DEFAULT_FILTER.to_string()
    } else {
        cfg.user_filter.trim().to_string()
    };
    let raw = if raw.contains("{u}") {
        raw
    } else {
        format!("(&{raw}{DEFAULT_FILTER})")
    };
    raw.replace("{u}", &escape_filter_chars(username))
}

pub async fn authenticate(cfg: &LdapCfg, username: &str, password: &str) -> Result<Option<LdapUser>, String> {
    if cfg.url.trim().is_empty() || cfg.base_dn.trim().is_empty() || username.is_empty() || password.is_empty() {
        return Ok(None);
    }
    let bind_dn = if cfg.bind_dn.trim().is_empty() {
        None
    } else {
        Some(cfg.bind_dn.trim())
    };
    let mut ldap = connect(&cfg.url, bind_dn, Some(&cfg.bind_password)).await?;
    let filter = build_filter(cfg, username);
    let (entries, _res) = ldap
        .search(&cfg.base_dn, Scope::Subtree, &filter, vec!["mail", "displayName", "cn", "memberOf"])
        .await
        .map_err(|e| format!("LDAP Error: {e}"))?
        .success()
        .map_err(|e| format!("LDAP Error: {e}"))?;
    let entries: Vec<SearchEntry> = entries.into_iter().map(SearchEntry::construct).collect();
    let _ = ldap.unbind().await;
    if entries.len() != 1 {
        return Ok(None);
    }
    let entry = &entries[0];
    // Verify the password by binding as the user.
    let mut user_conn = match connect(&cfg.url, Some(&entry.dn), Some(password)).await {
        Ok(conn) => conn,
        Err(_) => return Ok(None),
    };
    let _ = user_conn.unbind().await;
    let email = first_attr(&entry.attrs, &["mail"], "").to_lowercase();
    let name = first_attr(&entry.attrs, &["displayName", "cn"], username);
    let member_of: Vec<String> = entry
        .attrs
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("memberOf"))
        .flat_map(|(_, v)| v.iter().map(|s| s.to_lowercase()))
        .collect();
    Ok(Some(LdapUser {
        dn: entry.dn.clone(),
        email,
        name,
        member_of,
    }))
}

pub async fn test_connection(cfg: &LdapCfg) -> Result<usize, String> {
    if cfg.url.trim().is_empty() {
        return Err("LDAP URL is required".into());
    }
    let bind_dn = if cfg.bind_dn.trim().is_empty() {
        None
    } else {
        Some(cfg.bind_dn.trim())
    };
    let mut ldap = connect(&cfg.url, bind_dn, Some(&cfg.bind_password)).await?;
    let filter = if cfg.user_filter.trim().is_empty() {
        "(objectClass=*)"
    } else {
        cfg.user_filter.trim()
    };
    let result = ldap
        .search(&cfg.base_dn, Scope::Subtree, filter, vec!["cn"])
        .await
        .map_err(|e| format!("LDAP Error: {e}"))?;
    let count = match result.success() {
        Ok((entries, _)) => entries.len(),
        Err(e) => return Err(format!("Bind failed with provided credentials: {e}")),
    };
    let _ = ldap.unbind().await;
    Ok(count)
}

pub async fn password_ok(cfg: &LdapCfg, username: &str, password: &str) -> bool {
    matches!(authenticate(cfg, username, password).await, Ok(Some(_)))
}

pub async fn team_lead_emails(cfg: &LdapCfg) -> Vec<String> {
    if cfg.url.trim().is_empty() || cfg.base_dn.trim().is_empty() || cfg.team_lead_group_dn.trim().is_empty() {
        return Vec::new();
    }
    let bind_dn = if cfg.bind_dn.trim().is_empty() {
        None
    } else {
        Some(cfg.bind_dn.trim())
    };
    let Ok(mut ldap) = connect(&cfg.url, bind_dn, Some(&cfg.bind_password)).await else {
        return Vec::new();
    };
    let filter = format!("(memberOf={})", escape_filter_chars(cfg.team_lead_group_dn.trim()));
    let emails = match ldap
        .search(&cfg.base_dn, Scope::Subtree, &filter, vec!["mail"])
        .await
        .and_then(|r| r.success())
    {
        Ok((entries, _)) => entries
            .into_iter()
            .map(SearchEntry::construct)
            .flat_map(|e| {
                e.attrs
                    .iter()
                    .filter(|(k, _)| k.eq_ignore_ascii_case("mail"))
                    .flat_map(|(_, v)| v.iter().map(|s| s.to_lowercase()))
                    .collect::<Vec<_>>()
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    let _ = ldap.unbind().await;
    emails
}
