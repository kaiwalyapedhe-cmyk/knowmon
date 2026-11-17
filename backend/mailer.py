import os
import smtplib
import ssl
from email.message import EmailMessage


def smtp_configured() -> bool:
    return bool(os.environ.get("SMTP_HOST") and os.environ.get("SMTP_FROM"))


def send_email(to: list, subject: str, html: str, text: str) -> None:
    host = os.environ["SMTP_HOST"]
    port = int(os.environ.get("SMTP_PORT") or 587)
    security = (os.environ.get("SMTP_SECURITY") or "starttls").lower()  # starttls | ssl | none
    msg = EmailMessage()
    msg["From"] = os.environ["SMTP_FROM"]
    msg["To"] = ", ".join(to)
    msg["Subject"] = subject
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    ctx = ssl.create_default_context()
    smtp = smtplib.SMTP_SSL(host, port, timeout=20, context=ctx) if security == "ssl" else smtplib.SMTP(host, port, timeout=20)
    with smtp as s:
        if security == "starttls":
            s.starttls(context=ctx)
        if os.environ.get("SMTP_USERNAME"):
            s.login(os.environ["SMTP_USERNAME"], os.environ.get("SMTP_PASSWORD", ""))
        s.send_message(msg)
