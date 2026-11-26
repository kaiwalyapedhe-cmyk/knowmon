//! SMTP mailer used by the QA digest.

use crate::config::SmtpCfg;
use lettre::message::{header::ContentType, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

fn mailbox(input: &str, fallback_user: &str) -> Option<Mailbox> {
    let trimmed = input.trim();
    if trimmed.contains('@') {
        return trimmed.parse::<Mailbox>().ok();
    }
    // A display name only: send from the configured login mailbox.
    let email = fallback_user.trim();
    if !email.contains('@') {
        return None;
    }
    let address = email.parse().ok()?;
    Some(Mailbox::new(Some(trimmed.to_string()), address))
}

pub async fn send_email(
    cfg: &SmtpCfg,
    to: &[String],
    subject: &str,
    html: &str,
    text: &str,
) -> Result<(), String> {
    if cfg.host.is_empty() || cfg.from.is_empty() {
        return Err("SMTP is not configured".into());
    }
    let from = mailbox(&cfg.from, &cfg.username).ok_or("Invalid sender address")?;
    let mut builder = Message::builder().from(from).subject(subject);
    for addr in to {
        let parsed = addr
            .trim()
            .parse::<Mailbox>()
            .map_err(|e| format!("Invalid recipient {addr}: {e}"))?;
        builder = builder.to(parsed);
    }
    let message = builder
        .multipart(
            MultiPart::alternative()
                .singlepart(SinglePart::plain(text.to_string()))
                .singlepart(
                    SinglePart::builder()
                        .header(ContentType::TEXT_HTML)
                        .body(html.to_string()),
                ),
        )
        .map_err(|e| format!("Could not build email: {e}"))?;

    let builder = match cfg.security.as_str() {
        "ssl" => AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.host)
            .map_err(|e| e.to_string())?
            .port(cfg.port),
        "none" => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&cfg.host).port(cfg.port),
        _ => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host)
            .map_err(|e| e.to_string())?
            .port(cfg.port),
    };
    let builder = if cfg.username.is_empty() {
        builder
    } else {
        builder.credentials(Credentials::new(
            cfg.username.clone(),
            cfg.password.clone(),
        ))
    };
    let mailer = builder.build();
    mailer
        .send(message)
        .await
        .map(|_| ())
        .map_err(|e| format!("SMTP send failed: {e}"))
}
