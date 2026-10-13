"""Outbound email over SMTP.

Every message the application sends goes through ``send_email``. The templates
below are plain functions so they are easy to test and to adjust.
"""

from __future__ import annotations

import logging
import os
import smtplib
import ssl
import time
import uuid
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formataddr
from html import escape

from app.config import settings


logger = logging.getLogger(__name__)


class EmailDeliveryError(RuntimeError):
    """Raised when an email could not be handed to the SMTP server."""


def delivery_enabled() -> bool:
    """False when EMAIL_DELIVERY_ENABLED=false: messages go to the outbox folder."""
    return settings.email_delivery_enabled


def is_configured() -> bool:
    """Whether the application can hand a message on at all.

    True with working SMTP settings, and also whenever delivery is switched
    off -- the outbox always accepts a message, so every email feature stays
    usable (and testable) without anything being sent.
    """
    return settings.smtp_configured or not settings.email_delivery_enabled


def _save_to_outbox(message: EmailMessage) -> str:
    """Write a message to EMAIL_OUTBOX_DIR instead of sending it. Returns the path."""
    folder = os.path.abspath(settings.email_outbox_dir)
    os.makedirs(folder, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    path = os.path.join(folder, f"{stamp}-{uuid.uuid4().hex[:8]}.eml")
    with open(path, "wb") as handle:
        handle.write(bytes(message))
    return path


def _clean_header(value: str) -> str:
    """Collapse CR/LF (and other line breaks) that would make a header invalid.

    Subjects include user-controlled text such as an event name; the email
    package refuses a header containing a newline.
    """
    return " ".join(str(value).split()) if value else ""


def _build_message(to_email: str, subject: str, text: str, html: str | None) -> EmailMessage:
    message = EmailMessage()
    message["Subject"] = _clean_header(subject)
    # Only an outbox message can lack a sender: delivery refuses to run
    # without SMTP_FROM_EMAIL (see is_configured / send_email).
    sender = settings.smtp_from_email or "outbox@localhost"
    message["From"] = formataddr((settings.smtp_from_name, sender))
    message["To"] = to_email
    message.set_content(text)
    if html:
        message.add_alternative(html, subtype="html")
    return message


# Failures worth a second attempt: dropped connections, timeouts and 4xx
# "try again later" replies. Bad credentials or a rejected recipient will fail
# the same way twice, so those are reported straight away.
_PERMANENT_ERRORS = (smtplib.SMTPAuthenticationError, smtplib.SMTPRecipientsRefused)
_TRANSIENT_ERRORS = (OSError, smtplib.SMTPException)
SEND_ATTEMPTS = 2
RETRY_DELAY_SECONDS = 2


def send_email(to_email: str, subject: str, text: str, html: str | None = None) -> None:
    """Deliver one message. Raises ``EmailDeliveryError`` on any failure.

    With delivery switched off the message is saved to the outbox folder and
    no mail server is contacted -- checked first, before anything else.
    """
    if not settings.email_delivery_enabled:
        try:
            message = _build_message(to_email, subject, text, html)
            path = _save_to_outbox(message)
        except (OSError, ValueError, TypeError) as error:
            raise EmailDeliveryError(f"Could not save the message to the outbox: {error}") from error
        logger.warning(
            "email_suppressed delivery=disabled recipient_domain=%s outbox=%s",
            to_email.rsplit("@", 1)[-1],
            os.path.basename(path),
        )
        return

    if not is_configured():
        raise EmailDeliveryError(
            "SMTP is not configured: missing " + ", ".join(settings.smtp_missing_variables)
        )

    # Inside the error handling so a malformed header surfaces as the usual
    # EmailDeliveryError (which background callers catch and log) instead of an
    # uncaught exception that silently kills the background task.
    try:
        message = _build_message(to_email, subject, text, html)
    except (ValueError, TypeError) as error:
        _log_failure(to_email, error, 0)
        raise EmailDeliveryError(f"Could not build the message: {error}") from error
    subject = message["Subject"]
    started = time.perf_counter()

    for attempt in range(1, SEND_ATTEMPTS + 1):
        try:
            _deliver(message)
            break
        except _PERMANENT_ERRORS as error:
            _log_failure(to_email, error, attempt)
            raise EmailDeliveryError(str(error)) from error
        except _TRANSIENT_ERRORS as error:
            _log_failure(to_email, error, attempt)
            if attempt == SEND_ATTEMPTS:
                raise EmailDeliveryError(str(error)) from error
            time.sleep(RETRY_DELAY_SECONDS)

    logger.info(
        "email_sent recipient_domain=%s subject=%s elapsed_ms=%d",
        to_email.rsplit("@", 1)[-1],
        subject,
        (time.perf_counter() - started) * 1000,
    )


def _log_failure(to_email: str, error: Exception, attempt: int) -> None:
    logger.error(
        "email_send_failed recipient_domain=%s error_type=%s attempt=%d/%d detail=%s",
        to_email.rsplit("@", 1)[-1],
        type(error).__name__,
        attempt,
        SEND_ATTEMPTS,
        str(error)[:200],
    )


def _deliver(message: EmailMessage) -> None:
    """One SMTP session: connect, secure, authenticate, send."""
    if not settings.email_delivery_enabled:
        raise EmailDeliveryError("Email delivery is switched off (EMAIL_DELIVERY_ENABLED=false).")
    context = ssl.create_default_context()
    if settings.smtp_use_ssl:
        client = smtplib.SMTP_SSL(
            settings.smtp_host,
            settings.smtp_port,
            timeout=settings.smtp_timeout_seconds,
            context=context,
        )
    else:
        client = smtplib.SMTP(
            settings.smtp_host,
            settings.smtp_port,
            timeout=settings.smtp_timeout_seconds,
        )

    with client as smtp:
        smtp.ehlo()
        if settings.smtp_use_tls and not settings.smtp_use_ssl:
            smtp.starttls(context=context)
            smtp.ehlo()
        if settings.smtp_user and settings.smtp_password:
            smtp.login(settings.smtp_user, settings.smtp_password)
        smtp.send_message(message)


def send_email_safely(to_email: str, subject: str, text: str, html: str | None = None) -> bool:
    """Best-effort delivery for notifications that must never block a request."""
    try:
        send_email(to_email, subject, text, html)
        return True
    except EmailDeliveryError:
        return False


# ======================================================================
# Templates
# ======================================================================
#
# Email HTML is not web HTML. Outlook for Windows renders with Word's engine,
# Gmail rewrites or drops parts of <head>, and phones shrink anything wider
# than the screen. So the layout below sticks to what every client agrees on:
#
#   * tables for structure, every style inline (the <style> block is only a
#     progressive enhancement for the clients that honour media queries);
#   * a fluid card (width 100%, max-width 600px) instead of a fixed width, with
#     an Outlook-only fixed-width wrapper because Outlook ignores max-width;
#   * 16px body text, so iOS does not auto-zoom and nothing is under 13px;
#   * "bulletproof" buttons -- a real <a> with padding for every client, and a
#     VML shape for Outlook -- at least 48px tall, full width on phones;
#   * long values (links, email addresses, passwords) allowed to wrap anywhere,
#     so a 43-character token can never push the card wider than the screen.
#
# Colours are the platform's own design tokens (frontend/src/index.css) so a
# message looks like the portal it links to.

_BRAND = "#0D3668"    # SRHU Prussian Blue -- header band
_ACCENT = "#0369A1"   # deep sky -- buttons and links
_INK = "#0F1A2E"      # body text
_MUTED = "#4B5A73"    # secondary text
_CANVAS = "#F3F5F9"   # page background around the card
_SURFACE = "#FFFFFF"  # the card
_SOFT = "#F8FAFC"     # footer and panels
_LINE = "#E2E8F0"     # hairlines

_FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
_DISPLAY = "Sora,Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
_MONO = "SFMono-Regular,Consolas,'Liberation Mono',Menlo,Courier,monospace"

# Tones for status badges and callouts: (text, background, border). Darker
# shades of the portal's status hues (components/teacher/status.js), because
# the mid-tones it uses on screen are too light to carry text on a pale tint.
# Every pair here clears WCAG AA (4.5:1).
_TONES = {
    "ok": ("#047857", "#ECFDF5", "#A7F3D0"),      # approved
    "err": ("#B91C1C", "#FEF2F2", "#FECACA"),     # rejected
    "rose": ("#BE123C", "#FFF1F2", "#FECDD3"),    # revoked
    "warn": ("#B45309", "#FFFBEB", "#FDE68A"),    # needs changes / important
    "info": ("#1D4ED8", "#EFF6FF", "#BFDBFE"),    # in progress
    "teal": ("#0F766E", "#F0FDFA", "#99F6E4"),    # completed
    "neutral": ("#334155", "#F1F5F9", "#CBD5E1"),
}

# Clients that honour <style> (Apple Mail, iOS, the Gmail and Outlook apps,
# Samsung Mail) get tighter gutters and a full-width button on a phone. The
# rest keep the inline styles, which already fit a narrow screen.
_RESPONSIVE_CSS = (
    "<style>"
    "body{margin:0!important;padding:0!important;width:100%!important;}"
    "a{color:" + _ACCENT + ";}"
    "@media only screen and (max-width:620px){"
    ".cc-gutter{padding:16px 10px!important;}"
    ".cc-pad{padding-left:22px!important;padding-right:22px!important;}"
    ".cc-head{padding:22px 22px!important;}"
    ".cc-h1{font-size:22px!important;line-height:30px!important;}"
    ".cc-btn-table{width:100%!important;}"
    ".cc-btn a{display:block!important;}"
    "}"
    "</style>"
)


def _layout(title: str, body_html: str, *, preheader: str = "") -> str:
    """Wrap a message body in the branded, mobile-first card.

    ``preheader`` is the grey preview line inboxes show beside the subject;
    it is hidden in the message itself.
    """
    preview = (
        "<div style=\"display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;"
        f"mso-hide:all;font-size:1px;line-height:1px;color:{_CANVAS};\">"
        # The trailing spacers stop clients filling the preview with body text.
        f"{escape(preheader)}" + "&#8199;&#65279;&#847; " * 30 + "</div>"
        if preheader
        else ""
    )
    return (
        "<!DOCTYPE html>"
        "<html lang=\"en\" xmlns=\"http://www.w3.org/1999/xhtml\" "
        "xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:o=\"urn:schemas-microsoft-com:office:office\">"
        "<head>"
        "<meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<meta http-equiv=\"X-UA-Compatible\" content=\"IE=edge\">"
        "<meta name=\"x-apple-disable-message-reformatting\">"
        "<meta name=\"format-detection\" content=\"telephone=no,date=no,address=no,email=no,url=no\">"
        "<meta name=\"color-scheme\" content=\"light\">"
        "<meta name=\"supported-color-schemes\" content=\"light\">"
        f"<title>{escape(title)}</title>"
        "<!--[if mso]><noscript><xml><o:OfficeDocumentSettings>"
        "<o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->"
        f"{_RESPONSIVE_CSS}"
        "</head>"
        f"<body style=\"margin:0;padding:0;width:100%;background-color:{_CANVAS};"
        "-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;\">"
        f"{preview}"
        f"<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\" "
        f"bgcolor=\"{_CANVAS}\" style=\"width:100%;background-color:{_CANVAS};\">"
        "<tr><td class=\"cc-gutter\" align=\"center\" style=\"padding:32px 16px;\">"
        # Outlook ignores max-width, so give it a fixed 600px column instead.
        "<!--[if mso]><table role=\"presentation\" width=\"600\" cellspacing=\"0\" cellpadding=\"0\" "
        "border=\"0\" align=\"center\"><tr><td><![endif]-->"
        f"<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\" "
        f"style=\"width:100%;max-width:600px;margin:0 auto;background-color:{_SURFACE};"
        f"border:1px solid {_LINE};border-radius:16px;border-collapse:separate;overflow:hidden;\">"
        # ---- header: the portal's wordmark on SRHU blue
        f"<tr><td class=\"cc-head\" bgcolor=\"{_BRAND}\" "
        f"style=\"background-color:{_BRAND};padding:24px 32px;border-radius:15px 15px 0 0;\">"
        f"<div style=\"font-family:{_DISPLAY};font-size:20px;line-height:26px;font-weight:700;"
        "color:#FFFFFF;letter-spacing:-0.2px;\">Campus Capture</div>"
        f"<div style=\"font-family:{_FONT};font-size:13px;line-height:18px;color:#C7D5EA;"
        "padding-top:2px;\">Swami Rama Himalayan University</div>"
        "</td></tr>"
        # ---- body
        "<tr><td class=\"cc-pad\" style=\"padding:32px 32px 28px;\">"
        f"<h1 class=\"cc-h1\" style=\"margin:0 0 20px;font-family:{_DISPLAY};font-size:24px;"
        f"line-height:32px;font-weight:700;color:{_INK};letter-spacing:-0.3px;\">{escape(title)}</h1>"
        f"{body_html}"
        "</td></tr>"
        # ---- footer
        f"<tr><td class=\"cc-pad\" bgcolor=\"{_SOFT}\" style=\"background-color:{_SOFT};"
        f"padding:20px 32px;border-top:1px solid {_LINE};border-radius:0 0 15px 15px;\">"
        f"<p style=\"margin:0;font-family:{_FONT};font-size:13px;line-height:20px;color:{_MUTED};\">"
        "This message was sent automatically by Campus Capture SRHU.</p>"
        f"<p style=\"margin:6px 0 0;font-family:{_FONT};font-size:13px;line-height:20px;color:{_MUTED};\">"
        "Campus Capture &middot; Swami Rama Himalayan University</p>"
        "</td></tr>"
        "</table>"
        "<!--[if mso]></td></tr></table><![endif]-->"
        "</td></tr></table>"
        "</body></html>"
    )


def _p(html: str, *, muted: bool = False, size: int = 16, gap: int = 16) -> str:
    """One paragraph. Every block carries its own font: Outlook does not inherit it."""
    color = _MUTED if muted else _INK
    line = 24 if size >= 16 else 21
    return (
        f"<p style=\"margin:0 0 {gap}px;font-family:{_FONT};font-size:{size}px;"
        f"line-height:{line}px;color:{color};\">{html}</p>"
    )


def _greeting(name: str) -> str:
    return _p(f"Hello {escape(name)},")


def _button(url: str, label: str) -> str:
    """A tappable call to action that survives every client, Outlook included."""
    href = escape(url, quote=True)
    text = escape(label)
    # VML needs a fixed width; size it to the label so it never clips.
    vml_width = max(220, len(label) * 10 + 64)
    return (
        "<table role=\"presentation\" class=\"cc-btn-table\" cellspacing=\"0\" cellpadding=\"0\" "
        "border=\"0\" style=\"margin:28px 0 24px;\">"
        f"<tr><td class=\"cc-btn\" align=\"center\" bgcolor=\"{_ACCENT}\" "
        f"style=\"border-radius:10px;background-color:{_ACCENT};\">"
        "<!--[if mso]>"
        f"<v:roundrect xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:w=\"urn:schemas-microsoft-com:office:word\" "
        f"href=\"{href}\" style=\"height:50px;v-text-anchor:middle;width:{vml_width}px;\" arcsize=\"20%\" "
        f"strokecolor=\"{_ACCENT}\" fillcolor=\"{_ACCENT}\"><w:anchorlock/>"
        "<center style=\"color:#FFFFFF;font-family:'Segoe UI',Arial,sans-serif;font-size:16px;"
        f"font-weight:bold;\">{text}</center></v:roundrect>"
        "<![endif]-->"
        "<!--[if !mso]><!-->"
        f"<a href=\"{href}\" target=\"_blank\" rel=\"noopener\" "
        f"style=\"display:inline-block;padding:15px 32px;font-family:{_FONT};font-size:16px;"
        "line-height:20px;font-weight:600;color:#FFFFFF;text-decoration:none;text-align:center;"
        f"border-radius:10px;background-color:{_ACCENT};mso-hide:all;\">{text}</a>"
        "<!--<![endif]-->"
        "</td></tr></table>"
    )


def _link_fallback(url: str, note: str) -> str:
    """The expiry note, then the raw link for when the button does not work.

    ``word-break:break-all`` matters: the link carries a long token and would
    otherwise force the whole card wider than a phone screen.
    """
    href = escape(url, quote=True)
    return (
        f"<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\" "
        f"style=\"border-top:1px solid {_LINE};\">"
        "<tr><td style=\"padding-top:20px;\">"
        + _p(escape(note), muted=True, size=14, gap=10)
        + _p("If the button does not work, copy this address into your browser:",
             muted=True, size=14, gap=6)
        + f"<p style=\"margin:0;font-family:{_FONT};font-size:14px;line-height:21px;"
        "word-break:break-all;overflow-wrap:anywhere;\">"
        f"<a href=\"{href}\" target=\"_blank\" rel=\"noopener\" "
        f"style=\"color:{_ACCENT};text-decoration:underline;\">{escape(url)}</a></p>"
        "</td></tr></table>"
    )


def _callout(html: str, tone: str = "neutral", *, heading: str | None = None) -> str:
    """A tinted panel with a coloured left rule, for remarks and warnings."""
    fg, bg, border = _TONES.get(tone, _TONES["neutral"])
    title = (
        f"<p style=\"margin:0 0 6px;font-family:{_FONT};font-size:13px;line-height:18px;"
        f"font-weight:700;letter-spacing:0.4px;text-transform:uppercase;color:{fg};\">"
        f"{escape(heading)}</p>"
        if heading
        else ""
    )
    return (
        "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\" "
        "style=\"margin:4px 0 8px;\">"
        f"<tr><td bgcolor=\"{bg}\" style=\"background-color:{bg};border:1px solid {border};"
        f"border-left:4px solid {fg};border-radius:10px;padding:14px 18px;\">"
        f"{title}"
        f"<p style=\"margin:0;font-family:{_FONT};font-size:15px;line-height:23px;color:{_INK};"
        f"overflow-wrap:anywhere;\">{html}</p>"
        "</td></tr></table>"
    )


def _credentials(rows: list[tuple[str, str, bool]]) -> str:
    """Account details as stacked label/value pairs.

    Stacked rather than side by side: on a phone a long address and a
    password next to each other ran off the screen. ``secret`` values are set
    in a monospace, every-character-distinct face, since they get retyped.
    """
    cells = []
    for index, (label, value, secret) in enumerate(rows):
        top = 18 if index == 0 else 4
        bottom = 18 if index == len(rows) - 1 else 12
        if secret:
            shown = (
                f"<span style=\"display:inline-block;margin-top:4px;padding:8px 12px;"
                f"background-color:{_SURFACE};border:1px dashed #94A3B8;border-radius:8px;"
                f"font-family:{_MONO};font-size:18px;line-height:24px;font-weight:700;"
                f"letter-spacing:0.5px;color:{_INK};word-break:break-all;\">{escape(value)}</span>"
            )
        else:
            shown = (
                f"<span style=\"font-family:{_FONT};font-size:16px;line-height:24px;font-weight:600;"
                f"color:{_INK};word-break:break-all;overflow-wrap:anywhere;\">{escape(value)}</span>"
            )
        cells.append(
            f"<tr><td style=\"padding:{top}px 20px {bottom}px;\">"
            f"<div style=\"font-family:{_FONT};font-size:13px;line-height:18px;font-weight:600;"
            f"letter-spacing:0.4px;text-transform:uppercase;color:{_MUTED};padding-bottom:2px;\">"
            f"{escape(label)}</div>{shown}</td></tr>"
        )
    return (
        "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\" "
        f"bgcolor=\"{_SOFT}\" style=\"margin:8px 0 4px;background-color:{_SOFT};"
        f"border:1px solid {_LINE};border-radius:12px;border-collapse:separate;\">"
        + "".join(cells)
        + "</table>"
    )


def _badge(label: str, tone: str) -> str:
    fg, bg, border = _TONES.get(tone, _TONES["neutral"])
    return (
        "<table role=\"presentation\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\" "
        "style=\"margin:0 0 14px;\">"
        f"<tr><td bgcolor=\"{bg}\" style=\"background-color:{bg};border:1px solid {border};"
        f"border-radius:999px;padding:5px 12px;font-family:{_FONT};font-size:13px;line-height:16px;"
        f"font-weight:700;color:{fg};\">{escape(label)}</td></tr></table>"
    )


def _event_card(event_name: str, status_label: str, tone: str) -> str:
    """The event the message is about, named once and prominently."""
    return (
        "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\" "
        f"bgcolor=\"{_SOFT}\" style=\"margin:4px 0 20px;background-color:{_SOFT};"
        f"border:1px solid {_LINE};border-radius:12px;border-collapse:separate;\">"
        "<tr><td style=\"padding:18px 20px;\">"
        + _badge(status_label, tone)
        + f"<div style=\"font-family:{_FONT};font-size:13px;line-height:18px;font-weight:600;"
        f"letter-spacing:0.4px;text-transform:uppercase;color:{_MUTED};padding-bottom:2px;\">Event</div>"
        f"<div style=\"font-family:{_DISPLAY};font-size:18px;line-height:26px;font-weight:700;"
        f"color:{_INK};overflow-wrap:anywhere;\">{escape(event_name)}</div>"
        "</td></tr></table>"
    )


def send_verification_email(to_email: str, name: str, token: str) -> None:
    url = settings.email_verification_url(token)
    hours = settings.email_verification_expire_hours
    subject = "Confirm your Campus Capture account"
    text = (
        f"Hello {name},\n\n"
        "Thank you for registering with Campus Capture SRHU.\n"
        f"Please confirm your email address by opening this link:\n\n{url}\n\n"
        f"The link is valid for {hours} hours. If you did not create this account, "
        "you can ignore this email.\n"
    )
    html = _layout(
        "Confirm your email address",
        _greeting(name)
        + _p("Thank you for registering with Campus Capture SRHU. "
             "Please confirm your email address to activate your account.")
        + _p("You will be asked for the password you chose when you registered.",
             muted=True, size=15, gap=0)
        + _button(url, "Confirm email")
        + _link_fallback(
            url,
            f"The link is valid for {hours} hours. If you did not create this account, "
            "you can ignore this email.",
        ),
        preheader="Confirm your email address to activate your Campus Capture account.",
    )
    send_email(to_email, subject, text, html)


def send_password_reset_email(to_email: str, name: str, token: str) -> None:
    url = settings.password_reset_url(token)
    minutes = settings.password_reset_expire_minutes
    subject = "Reset your Campus Capture password"
    text = (
        f"Hello {name},\n\n"
        "We received a request to reset the password for your Campus Capture account.\n"
        f"Open this link to choose a new password:\n\n{url}\n\n"
        f"The link is valid for {minutes} minutes. If you did not request a reset, "
        "you can ignore this email and your password will stay the same.\n"
    )
    html = _layout(
        "Reset your password",
        _greeting(name)
        + _p("We received a request to reset the password for your Campus Capture account. "
             "Use the button below to choose a new one.", gap=0)
        + _button(url, "Choose a new password")
        + _link_fallback(
            url,
            f"The link is valid for {minutes} minutes. If you did not request a reset, "
            "ignore this email and your password will stay the same.",
        ),
        preheader=f"Choose a new password. This link is valid for {minutes} minutes.",
    )
    send_email(to_email, subject, text, html)


def _send_invitation(to_email: str, name: str, token: str, *, added_by: str, purpose: str) -> None:
    """A one-time link to set a password and activate the account. No password is sent.

    Accepting it (POST /auth/accept-invite) also verifies the address, so this
    is the account's email verification as well as its registration.
    """
    url = settings.teacher_invite_url(token)
    days = settings.teacher_invite_expire_days
    subject = "You're invited to Campus Capture SRHU"
    intro = f"{added_by} has added you to Campus Capture SRHU, {purpose}."
    text = (
        f"Hello {name},\n\n"
        f"{intro}\n\n"
        f"Open this link to verify your email, choose your password and activate your account:\n\n{url}\n\n"
        f"Your sign-in email is {to_email}. The link works once and is valid for {days} days. "
        "If you were not expecting this, you can ignore this email.\n"
    )
    html = _layout(
        "You're invited to Campus Capture",
        _greeting(name)
        + _p(f"{intro} Choose a password to verify your email and activate your account.")
        + _credentials([("Sign-in email", to_email, False)])
        + _button(url, "Set my password")
        + _link_fallback(
            url,
            f"The link works once and is valid for {days} days. If you were not expecting "
            "this, you can ignore this email.",
        ),
        preheader=f"Choose your password to activate your account. Valid for {days} days.",
    )
    send_email(to_email, subject, text, html)


def send_teacher_invitation_email(to_email: str, name: str, token: str) -> None:
    """A Dean's invitation to a Teacher."""
    _send_invitation(
        to_email, name, token,
        added_by="Your Dean",
        purpose="where teachers submit and manage their events",
    )


def send_event_manager_invitation_email(to_email: str, name: str, token: str) -> None:
    """A Super Admin's invitation to an Event Manager."""
    _send_invitation(
        to_email, name, token,
        added_by="A Super Admin",
        purpose="as an Event Manager: you will record events and generate their reports",
    )


def send_registration_attempt_email(to_email: str, name: str) -> None:
    """Tell a verified account holder that someone tried to register their address.

    /auth/register answers exactly as for a new account, so the attempt cannot
    be used to discover who has an account; the real owner learns of it here.
    """
    login_url = settings.login_url
    reset_url = settings.frontend_route("/forgot-password")
    subject = "Someone tried to register with your email"
    text = (
        f"Hello {name},\n\n"
        "Someone just tried to create a new Campus Capture account with this email "
        "address, but you already have one.\n\n"
        f"If it was you, sign in here: {login_url}\n"
        f"Forgot your password? Reset it here: {reset_url}\n\n"
        "If it wasn't you, you can ignore this email. Your account has not changed.\n"
    )
    html = _layout(
        "You already have an account",
        _greeting(name)
        + _p("Someone just tried to create a new Campus Capture account with this email "
             "address, but you already have one.", gap=0)
        + _button(login_url, "Sign in")
        + _p(
            "Forgot your password? "
            f"<a href=\"{escape(reset_url, quote=True)}\" target=\"_blank\" rel=\"noopener\" "
            f"style=\"color:{_ACCENT};font-weight:600;text-decoration:underline;\">Reset it here</a>.",
            muted=True, size=15, gap=8,
        )
        + _p("If it wasn't you, you can ignore this email. Your account has not changed.",
             muted=True, size=15, gap=0),
        preheader="Someone tried to register with this address. Your account has not changed.",
    )
    send_email(to_email, subject, text, html)


def send_dean_credentials_email(to_email: str, name: str, temporary_password: str) -> None:
    url = settings.login_url
    subject = "Your Campus Capture Dean account"
    text = (
        f"Hello {name},\n\n"
        "A Dean account has been created for you on Campus Capture SRHU.\n\n"
        f"Email: {to_email}\n"
        f"Temporary password: {temporary_password}\n\n"
        f"Sign in here: {url}\n\n"
        "Please change your password after your first login.\n"
    )
    html = _layout(
        "Your Dean account is ready",
        _greeting(name)
        + _p("A Dean account has been created for you on Campus Capture SRHU. "
             "Use these details to sign in:", gap=12)
        + _credentials([
            ("Email", to_email, False),
            ("Temporary password", temporary_password, True),
        ])
        + _button(url, "Sign in")
        + _callout("Please change your password after your first login.", "warn",
                   heading="Important"),
        preheader="Your Dean account is ready. Sign in with the temporary password inside.",
    )
    send_email(to_email, subject, text, html)


def send_teacher_credentials_email(to_email: str, name: str, temporary_password: str) -> None:
    url = settings.login_url
    subject = "Your Campus Capture Teacher account credentials"
    text = (
        f"Hello {name},\n\n"
        "A Teacher account has been created for you on Campus Capture SRHU.\n\n"
        f"Email (Username): {to_email}\n"
        f"Temporary password: {temporary_password}\n\n"
        f"Sign in here: {url}\n\n"
        "Please log in and change your password on first login.\n"
    )
    html = _layout(
        "Your Teacher account is ready",
        _greeting(name)
        + _p("A Teacher account has been created for you on Campus Capture SRHU. "
             "Use these details to sign in:", gap=12)
        + _credentials([
            ("Email (Username)", to_email, False),
            ("Temporary password", temporary_password, True),
        ])
        + _button(url, "Sign in to Portal")
        + _callout("Please log in and change your password on first login.", "warn",
                   heading="Important"),
        preheader="Your Teacher account is ready. Sign in with the temporary password inside.",
    )
    send_email(to_email, subject, text, html)


# Badge wording and tone per outcome, beside each email's heading.
_STATUS_BADGE = {
    "approved": ("Approved", "ok"),
    "reapproved": ("Re-approved", "ok"),
    "rejected": ("Rejected", "err"),
    "revoked": ("Approval revoked", "rose"),
    "needs_changes": ("Changes requested", "warn"),
    "in_progress": ("In progress", "info"),
    "completed": ("Completed", "teal"),
    "progress_approved": ("Approved", "ok"),
}


def send_event_status_email(
    to_email: str,
    name: str,
    event_name: str,
    status: str,
    remarks: str | None = None,
    *,
    event_id: str | None = None,
    stage: str | None = None,
    reapproved: bool = False,
) -> None:
    labels = {
        "approved": ("Event approved", "has been approved by the Dean."),
        "rejected": ("Event rejected", "was rejected by the Dean."),
        "revoked": ("Event approval revoked", "had its approval revoked by the Dean."),
        "needs_changes": ("Event needs changes", "needs changes before it can be approved."),
    }
    stage_labels = {
        "in_progress": ("Event in progress", "has been marked in progress by the Dean."),
        "completed": ("Event completed", "has been marked completed by the Dean."),
        "approved": ("Event status updated", "has been moved back to approved by the Dean."),
    }
    if status == "progress":
        heading, sentence = stage_labels.get(stage or "", ("Event update", "has been updated."))
        badge_key = "progress_approved" if stage == "approved" else (stage or "")
    elif status == "approved" and reapproved:
        # The Dean reconsidered a refusal. Saying "approved" here would read as
        # a first decision to a teacher who was told days ago it was refused.
        heading, sentence = (
            "Event re-approved",
            "has been re-approved by the Dean after being refused.",
        )
        badge_key = "reapproved"
    else:
        heading, sentence = labels.get(status, ("Event update", "has been updated."))
        badge_key = status
    badge_label, badge_tone = _STATUS_BADGE.get(badge_key, ("Updated", "neutral"))

    # Straight to the event, where the teacher also finds its full history and
    # every remark the Dean has made — not the list they would have to search.
    url = settings.frontend_route(
        f"/teacher/events/{event_id}" if event_id else "/teacher/my-events"
    )

    remark_text = f"\nRemarks from the Dean:\n{remarks}\n" if remarks else ""
    text = (
        f"Hello {name},\n\n"
        f"Your event \"{event_name}\" {sentence}\n"
        f"{remark_text}\n"
        f"{'View the event' if event_id else 'View your events'}: {url}\n"
    )
    # Escaped first, then line breaks restored: a Dean's multi-line remark used
    # to arrive as one run-on paragraph.
    remark_html = (
        _callout(escape(remarks).replace("\n", "<br>"), badge_tone,
                 heading="Remarks from the Dean")
        if remarks
        else ""
    )
    html = _layout(
        heading,
        _greeting(name)
        # The card below names the event, so the sentence does not repeat it.
        + _p(f"Your event {escape(sentence)}")
        + _event_card(event_name, badge_label, badge_tone)
        + remark_html
        + _button(url, "View this event" if event_id else "View my events"),
        preheader=f"Your event “{event_name}” {sentence}",
    )
    send_email(to_email, f"{heading}: {event_name}", text, html)
